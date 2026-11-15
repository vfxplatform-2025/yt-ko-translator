"""STT 워커: yt-dlp로 오디오를 받고 faster-whisper로 받아쓰기를 하며, 결과 자막(cue)을 조금씩 stdout(JSON lines)으로 내보냅니다.
node server.js가 자식 프로세스로 실행합니다. 모델은 처음 요청 때 한 번만 로드해 계속 유지합니다.

stdin : {"cmd":"start","videoId":"...","from":123.4}   (같은 영상이면 탐색 요청으로 처리: 해당 위치부터 우선 처리)
stdout: {"ev":"status","videoId":..,"state":"downloading|loading|transcribing|done|error","msg":".."}
        {"ev":"cues","videoId":..,"cues":[{"s":..,"e":..,"o":".."}],"lang":".."}
"""
import glob
import json
import os
import site
import subprocess
import sys
import threading
import time

# hf-xet 다운로더가 이 환경에서 멈추는 문제가 있어 끔 (일반 다운로드 사용)
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIO_DIR = os.path.join(HERE, "cache", "audio")
os.makedirs(AUDIO_DIR, exist_ok=True)

# Windows: pip로 설치한 CUDA 라이브러리(cuBLAS/cuDNN) DLL 경로 등록
for sp in site.getsitepackages():
    for d in glob.glob(os.path.join(sp, "nvidia", "*", "bin")):
        try:
            os.add_dll_directory(d)
        except Exception:
            pass
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")

# DLL을 싣는 무거운 임포트는 반드시 여기(메인 스레드, stdin 읽기 전)에서 끝낼 것.
# 스레드 안에서 처음 임포트하면 메인이 stdin 파이프를 읽는 동안 Windows에서 교착됩니다.
import av  # noqa: E402
import numpy  # noqa: E402,F401
from faster_whisper import WhisperModel  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")
sys.stdin.reconfigure(encoding="utf-8")

MODEL_NAME = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
CPU_MODEL_NAME = os.environ.get("WHISPER_CPU_MODEL", "small")
_out_lock = threading.Lock()


def emit(obj):
    with _out_lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def log(*a):
    sys.stderr.write(" ".join(str(x) for x in a) + "\n")
    sys.stderr.flush()


# ---------------- 모델 ----------------
_model = None
_model_device = None


def get_model(force_cpu=False):
    global _model, _model_device
    if _model is not None and not (force_cpu and _model_device != "cpu"):
        return _model
    import ctranslate2

    if not force_cpu and ctranslate2.get_cuda_device_count() > 0:
        try:
            _model = WhisperModel(MODEL_NAME, device="cuda", compute_type="float16")
            _model_device = "cuda"
            return _model
        except Exception as e:  # noqa: BLE001
            log("CUDA 로드 실패, CPU로 대체:", e)
    else:
        log("CUDA 장치 없음 -> CPU 사용")
    # CPU에서는 큰 모델이 너무 느려서 작은 모델 사용 (WHISPER_CPU_MODEL 로 변경 가능)
    threads = int(os.environ.get("WHISPER_CPU_THREADS", str(os.cpu_count() or 4)))
    _model = WhisperModel(CPU_MODEL_NAME, device="cpu", compute_type="int8", cpu_threads=threads)
    _model_device = "cpu"
    return _model


# ---------------- 오디오 다운로드 ----------------
def find_audio(vid):
    for p in glob.glob(os.path.join(AUDIO_DIR, vid + ".*")):
        if not p.endswith((".part", ".ytdl", ".temp")):
            return p
    return None


def download_audio(vid):
    path = find_audio(vid)
    if path:
        return path
    import imageio_ffmpeg

    cmd = [
        sys.executable, "-m", "yt_dlp",
        "-f", "bestaudio[ext=m4a]/bestaudio",
        "--no-playlist", "--no-warnings", "--no-part",
        "--js-runtimes", "node",
        "--ffmpeg-location", imageio_ffmpeg.get_ffmpeg_exe(),
        "-o", os.path.join(AUDIO_DIR, "%(id)s.%(ext)s"),
        "https://www.youtube.com/watch?v=" + vid,
    ]
    # stdin을 워커의 파이프와 분리 (물려받으면 하위 프로세스가 명령 스트림을 읽으며 멈출 수 있음)
    for attempt in range(3):  # 유튜브가 가끔 일시적으로 403을 주므로 재시도
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           stdin=subprocess.DEVNULL, timeout=600)
        path = find_audio(vid)
        if r.returncode == 0 and path:
            break
        time.sleep(3 * (attempt + 1))
    if r.returncode != 0 or not path:
        raise RuntimeError("오디오 다운로드 실패: " + (r.stderr or r.stdout).strip()[-400:])
    return path


def audio_duration(path):
    with av.open(path) as c:
        return float(c.duration) / 1_000_000 if c.duration else 0.0


# ---------------- 자막 분할 ----------------
SENT_END = (".", "?", "!", "。", "？", "！", "…")


def is_cjk(text):
    n = sum(1 for ch in text if "぀" <= ch <= "ヿ" or "一" <= ch <= "鿿" or "가" <= ch <= "힯")
    return n > len(text) * 0.3


def words_to_cues(words):
    if not words:
        return []
    cjk = is_cjk("".join(w.word for w in words))
    max_chars = 34 if cjk else 78
    max_dur = 6.5
    cues, cur = [], []

    def flush():
        if not cur:
            return
        text = "".join(w.word for w in cur).strip()
        if text:
            cues.append({"s": round(cur[0].start, 2), "e": round(cur[-1].end, 2), "o": text})
        cur.clear()

    for w in words:
        if cur:
            length = len("".join(x.word for x in cur) + w.word)
            if w.start - cur[-1].end > 0.8 or length > max_chars or (w.end - cur[0].start) > max_dur:
                flush()
        cur.append(w)
        text = "".join(x.word for x in cur).strip()
        if text.endswith(SENT_END) and (cur[-1].end - cur[0].start > 1.5 or len(text) > 25):
            flush()
    flush()
    return cues


# ---------------- 구간 관리 ----------------
def merge(intervals):
    out = []
    for a, b in sorted(intervals):
        if out and a <= out[-1][1] + 0.05:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def next_gap(covered, pos, dur):
    """pos 이후(또는 pos를 포함하는) 처음 미처리 구간. 없으면 처음부터 첫 미처리 구간. 모두 처리됐으면 None."""
    cov = merge(covered)
    gaps, cur = [], 0.0
    for a, b in cov:
        if a - cur > 1.0:
            gaps.append((cur, a))
        cur = max(cur, b)
    if dur - cur > 1.0:
        gaps.append((cur, dur))
    if not gaps:
        return None
    for a, b in gaps:
        if a <= pos < b:
            return (pos, b)
    for a, b in gaps:
        if a >= pos:
            return (a, b)
    return gaps[0]


# ---------------- 작업 루프 ----------------
cv = threading.Condition()
pending = None  # (videoId, from)
jobs = {}  # videoId -> {"covered": [], "dur": float, "audio": str}


def take_pending_for(vid):
    """실행 중 같은 영상의 탐색 요청이 들어왔으면 (from)을 돌려주고 소비. 다른 영상이면 'other'."""
    global pending
    with cv:
        if pending is None:
            return None
        if pending[0] == vid:
            pos = pending[1]
            pending = None
            return pos
        return "other"


def run_pass(vid, job, a, b):
    """[a,b) 구간 받아쓰기. 반환: 'ok' | ('seek', pos) | 'other'"""
    global _model
    model = get_model()
    forced_cpu = False
    while True:
        try:
            segments, info = model.transcribe(
                job["audio"],
                clip_timestamps=[a, b],
                word_timestamps=True,
                vad_filter=True,
                condition_on_previous_text=False,
                beam_size=5,
            )
            lang = info.language
            cursor = a
            for seg in segments:
                cues = words_to_cues(seg.words or [])
                if cues:
                    emit({"ev": "cues", "videoId": vid, "cues": cues, "lang": lang})
                job["covered"].append([cursor, seg.end])
                cursor = max(cursor, seg.end)
                req = take_pending_for(vid)
                if req == "other":
                    return "other"
                if req is not None:
                    return ("seek", req)
            job["covered"].append([cursor, b])
            return "ok"
        except Exception as e:  # noqa: BLE001
            # GPU 추론 오류(드라이버/아키텍처 미지원 등)면 CPU로 한 번 재시도
            msg = str(e).lower()
            gpu_err = any(k in msg for k in ("cuda", "cublas", "cudnn", "kernel image", "out of memory", "driver"))
            if not forced_cpu and _model_device == "cuda" and gpu_err:
                log("GPU 추론 오류, CPU로 재시도:", e)
                emit({"ev": "status", "videoId": vid, "state": "loading", "msg": "GPU 오류로 CPU 모드로 전환"})
                forced_cpu = True
                _model = None
                model = get_model(force_cpu=True)
                continue
            raise


def run_job(vid, pos):
    job = jobs.get(vid)
    if job is None:
        emit({"ev": "status", "videoId": vid, "state": "downloading", "msg": "오디오 받는 중…"})
        audio = download_audio(vid)
        job = {"covered": [], "dur": audio_duration(audio), "audio": audio}
        jobs[vid] = job
        while len(jobs) > 3:
            jobs.pop(next(iter(jobs)))
    emit({"ev": "status", "videoId": vid, "state": "loading", "msg": "음성 인식 모델 준비 중…"})
    get_model()
    while True:
        gap = next_gap(job["covered"], pos, job["dur"])
        if gap is None:
            emit({"ev": "status", "videoId": vid, "state": "done", "msg": "완료"})
            try:
                os.remove(job["audio"])
            except OSError:
                pass
            jobs.pop(vid, None)
            return
        emit({"ev": "status", "videoId": vid, "state": "transcribing", "msg": f"받아쓰기 {gap[0]:.0f}s~{gap[1]:.0f}s"})
        res = run_pass(vid, job, gap[0], gap[1])
        if res == "other":
            return
        if isinstance(res, tuple):
            pos = res[1]
        else:
            pos = gap[1]


def worker():
    global pending
    while True:
        with cv:
            while pending is None:
                cv.wait()
            vid, pos = pending
            pending = None
        try:
            run_job(vid, pos)
        except Exception as e:  # noqa: BLE001
            log("작업 실패:", repr(e))
            emit({"ev": "status", "videoId": vid, "state": "error", "msg": str(e)[-400:]})


def purge_old_audio():
    now = time.time()
    for p in glob.glob(os.path.join(AUDIO_DIR, "*")):
        try:
            if now - os.path.getmtime(p) > 86400:
                os.remove(p)
        except OSError:
            pass


def main():
    global pending
    if os.environ.get("STT_DEBUG"):
        import faulthandler

        faulthandler.dump_traceback_later(int(os.environ["STT_DEBUG"]), repeat=False, file=sys.stderr)
    purge_old_audio()
    threading.Thread(target=worker, daemon=True).start()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("cmd") == "start" and msg.get("videoId"):
            vid = str(msg["videoId"])
            if not all(c.isalnum() or c in "-_" for c in vid) or len(vid) > 20:
                continue
            with cv:
                pending = (vid, float(msg.get("from", 0)))
                cv.notify()


if __name__ == "__main__":
    main()
