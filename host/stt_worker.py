"""STT 워커: yt-dlp로 오디오를 받고 음성 인식 엔진으로 받아쓰기를 하며, 결과 자막(cue)을 조금씩 stdout(JSON lines)으로 내보냅니다.
node server.js가 엔진마다 그 엔진의 가상환경 Python으로 실행합니다 (환경변수 STT_ENGINE = whisper | haas | qwen).
모델은 처음 요청 때 한 번만 로드해 계속 유지합니다.
  whisper: faster-whisper (다국어)
  haas   : Haas-ja (일본어 전용). 일본어가 아니면 같은 환경의 Whisper 로 처리, 언어 자동이면 Whisper 로 먼저 감지
  qwen   : Qwen3-ASR 1.7B + Qwen3-ForcedAligner (다국어, 단어 단위 시간)
  nemotron: NVIDIA Nemotron 3.5 ASR Streaming 0.6B (다국어 40개 로케일, NeMo 최신판)

stdin : {"cmd":"start","videoId":"...","from":123.4,"lang":""}   (같은 영상·같은 언어면 탐색 요청으로 처리: 해당 위치부터 우선 처리)
        lang: "" 이면 자동 감지, "en"/"ja" 등이면 그 언어로 고정.
stdout: {"ev":"status","videoId":..,"req":"<요청 언어>","state":"downloading|loading|transcribing|done|error","msg":"..","prog":0~1}
        {"ev":"cues","videoId":..,"req":"<요청 언어>","cues":[{"s":..,"e":..,"o":"..","l":"<그 줄의 언어, Whisper 만>"}],"lang":"<감지된 언어>","used":"<실제 쓴 엔진>"}
        작업은 (videoId, 요청 언어) 단위이며, 모든 이벤트에 요청 언어가 "req"로 붙습니다.
"""
import glob
import json
import re
import os
import site
import subprocess
import sys
import threading
import time

# hf-xet 다운로더가 이 환경에서 멈추는 문제가 있어 끔 (일반 다운로드 사용)
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

# 서버와의 통신 통로를 라이브러리 입출력과 분리 (무거운 라이브러리를 불러오기 전에):
# - 서버 명령/이벤트는 원래 stdin/stdout 파이프를 복제한 전용 통로로 주고받음
# - sys.stdin 은 /dev/null 로 바꿈: multiprocessing 이 자식 프로세스에서 sys.stdin 을 닫는데, 메인 스레드가
#   명령을 기다리며 그 읽기 잠금을 잡고 있으면 자식이 영원히 멈춤 (NeMo 데이터 로더 보조 프로세스에서 발생)
# - 라이브러리가 stdout(fd 1)에 찍는 로그는 stderr 로 보내 통신 줄에 섞이지 않게 함
PROTO_IN = os.fdopen(os.dup(0), "r", encoding="utf-8")
PROTO_OUT = os.fdopen(os.dup(1), "w", encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr
sys.stdin = open(os.devnull, encoding="utf-8")

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
import av  # noqa: E402,F401
import numpy  # noqa: E402,F401
from faster_whisper import WhisperModel, decode_audio  # noqa: E402
from faster_whisper.vad import VadOptions, get_speech_timestamps  # noqa: E402

ENGINE = os.environ.get("STT_ENGINE", "whisper")
if ENGINE == "haas":
    import haas_asr  # noqa: E402  (NeMo/torch 를 메인 스레드에서 미리 로드)
elif ENGINE == "qwen":
    import torch  # noqa: E402
    from qwen_asr import Qwen3ASRModel  # noqa: E402
elif ENGINE == "nemotron":
    import nemo.collections.asr as nemo_asr  # noqa: E402
    from nemo.collections.asr.models.rnnt_bpe_models_prompt import RNNTPromptTranscribeConfig  # noqa: E402


SR = 16000
# large-v3: turbo 보다 약 3배 느리지만 (그래도 GPU 에서 재생의 약 17배속) 일본어 애니메이션 비교에서 가장 정확
MODEL_NAME = os.environ.get("WHISPER_MODEL", "large-v3")
CPU_MODEL_NAME = os.environ.get("WHISPER_CPU_MODEL", "small")
_out_lock = threading.Lock()


def emit(obj):
    with _out_lock:
        PROTO_OUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
        PROTO_OUT.flush()


def emit_status(vid, lang, state, msg, prog=None):
    obj = {"ev": "status", "videoId": vid, "req": lang, "state": state, "msg": msg}
    if prog is not None:
        obj["prog"] = round(prog, 3)
    emit(obj)


def log(*a):
    sys.stderr.write(" ".join(str(x) for x in a) + "\n")
    sys.stderr.flush()


# ---------------- 엔진 ----------------
# 엔진.transcribe(pcm, a, b, lang) 는 [a,b) 구간을 받아쓰며 (cues, 처리 끝 시각, 감지 언어, 쓴 엔진) 을 조금씩 내놓는다.
class W:  # 단어 하나 (words_to_cues 입력)
    __slots__ = ("word", "start", "end")

    def __init__(self, word, start, end):
        self.word, self.start, self.end = word, start, end


# 언어별 시작 문장: large-v3 가 일본어를 한자 없이 히라가나로만 받아쓰는 경우가 있어 한자 섞인 문장으로 유도
PROMPTS = {"ja": "以下は、日本語の会話の書き起こしです。", "zh": "以下是普通话的句子。"}


class WhisperEngine:
    name = "whisper"

    def __init__(self):
        self.model = None
        self.device = None
        self.lang_cache = {}  # 오디오(id) -> 감지 언어 (영상마다 한 번만 감지)
        self.seen_langs = {}  # 오디오(id) -> 지금까지 나온 언어들 (2개 이상이면 섞인 영상)

    def lang_for(self, pcm, at, lang):
        if lang:
            return lang
        key = id(pcm)
        if key not in self.lang_cache:
            self.lang_cache = {key: self.detect(pcm, at)}
        return self.lang_cache[key]

    def load(self, force_cpu=False):
        if self.model is not None and not (force_cpu and self.device != "cpu"):
            return self.model
        import ctranslate2

        if not force_cpu and ctranslate2.get_cuda_device_count() > 0:
            try:
                self.model = WhisperModel(MODEL_NAME, device="cuda", compute_type="float16")
                self.device = "cuda"
                return self.model
            except Exception as e:  # noqa: BLE001
                log("CUDA 로드 실패, CPU로 대체:", e)
        else:
            log("CUDA 장치 없음 -> CPU 사용")
        # CPU에서는 큰 모델이 너무 느려서 작은 모델 사용 (WHISPER_CPU_MODEL 로 변경 가능)
        threads = int(os.environ.get("WHISPER_CPU_THREADS", str(os.cpu_count() or 4)))
        self.model = WhisperModel(CPU_MODEL_NAME, device="cpu", compute_type="int8", cpu_threads=threads)
        self.device = "cpu"
        return self.model

    def detect(self, pcm, at):
        """at 초부터 90초 안에서 언어 감지. VAD 를 켜면 잘라 붙인 소리 조각 때문에 오감지가 잦아서 끔
        (예: 일본어 애니 구간이 VAD 켜면 ko 0.97, 끄면 ja 0.98)"""
        seg = pcm[int(at * SR): int((at + 90) * SR)]
        lang, _prob, _all = self.load().detect_language(seg, vad_filter=False, language_detection_segments=3)
        return lang

    def chunk_lang(self, pcm, c0, c1):
        """말소리 덩어리 하나의 언어. 너무 짧거나 확신이 낮으면 None (앞 덩어리 언어를 이어 씀)"""
        if c1 - c0 < 1.0:
            return None
        try:
            lang, prob, _all = self.load().detect_language(pcm[int(c0 * SR): int(c1 * SR)], vad_filter=False, language_detection_segments=1)
        except Exception as e:  # noqa: BLE001
            log("덩어리 언어 감지 실패:", e)
            return None
        return lang if prob >= 0.6 else None

    def transcribe(self, pcm, a, b, lang):
        if lang:
            yield from self.transcribe_as(pcm, a, b, lang)
            return
        # 언어 자동: 말소리 덩어리마다 언어를 감지해 같은 언어가 이어지는 구간끼리 그 언어로 받아씀.
        # 영상 전체를 한 언어로 고정하면 한국어 내레이션 + 일본어 대화처럼 섞인 영상에서 다른 언어 부분이
        # 통째로 빠지거나 엉뚱한 글자로 바뀜. 첫 자막이 늦지 않도록 약 1분씩 나눠 처리
        prev = self.lang_for(pcm, a, "")
        if id(pcm) not in self.seen_langs:
            self.seen_langs = {id(pcm): set()}  # 영상이 바뀌면 새로 (lang_cache 처럼 하나만 유지)
        seen = self.seen_langs[id(pcm)]
        pos = a
        while pos < b:
            # 말 사이 쉼으로 나뉜 덩어리 그대로 감지 (speech_chunks 처럼 가까운 덩어리를 합치면 언어 경계가 묻힘)
            chunks = [c for c in speech_segments(pcm, pos, min(b, pos + 90)) if c[0] < pos + 60]
            if not chunks:
                pos = min(b, pos + 60)
                yield [], pos, prev, self.name
                continue
            runs = self.language_runs(pcm, chunks, seen, prev)
            prev = runs[-1][0]
            for lg, r0, r1 in runs:
                yield from self.transcribe_as(pcm, r0, r1, lg)
            pos = max(pos + 1, chunks[-1][1])  # 문장이 창 경계에서 잘리지 않게 마지막 덩어리 끝에서 이어감

    def language_runs(self, pcm, chunks, seen, prev):
        """말소리 덩어리들의 언어를 감지해, 같은 언어가 이어지는 구간끼리 묶은 [언어, 시작, 끝] 목록.
        언어를 모르는 덩어리(짧거나 확신 낮음)는 앞 덩어리 언어를 이어 씀. seen 에 나온 언어를 모음"""
        detected = [(c0, c1, self.chunk_lang(pcm, c0, c1)) for c0, c1 in chunks]
        seen.update(lg for *_, lg in detected if lg)
        pieces = []
        for c0, c1, lg in detected:
            if len(seen) > 1 and c1 - c0 > 3:
                # 섞인 영상이면 긴 덩어리 안에서도 언어가 바뀔 수 있어 짧은 쉼으로 더 잘게 나눠 다시 감지
                # (한 언어 영상은 감지 횟수를 늘리지 않음: 1회 약 80ms)
                subs = speech_segments(pcm, c0, c1, silence_ms=150, pad_ms=50) or [[c0, c1]]
                pieces += [(s0, s1, self.chunk_lang(pcm, s0, s1) or lg) for s0, s1 in subs]
            else:
                pieces.append((c0, c1, lg))
        runs = []
        for c0, c1, lg in pieces:
            lg = prev = lg or prev
            if runs and runs[-1][0] == lg:
                runs[-1][2] = c1
            else:
                runs.append([lg, c0, c1])
        return runs

    def transcribe_as(self, pcm, a, b, lang):
        """[a,b) 를 lang 으로 받아씀. 자막마다 그 언어를 "l" 로 붙임 (확장 프로그램이 줄마다 번역할지 정할 때 씀)"""
        model = self.load()
        forced_cpu = False
        a, b = float(a), float(b)  # numpy 실수면 결과 시각도 numpy 가 되어 JSON 으로 못 내보냄
        while True:
            try:
                segments, info = model.transcribe(
                    pcm,  # 미리 해독한 오디오 (파일 경로를 주면 호출마다 전체를 다시 해독함)
                    clip_timestamps=[a, b],
                    word_timestamps=True,
                    vad_filter=True,
                    condition_on_previous_text=False,
                    beam_size=5,
                    language=lang,
                    initial_prompt=PROMPTS.get(lang),
                )
                for seg in segments:
                    # Whisper 는 구간 끝을 넘어 받아쓰기도 함. 넘친 줄은 버림 (언어별로 나눈 구간에서 다음 구간의
                    # 다른 언어 말을 이 언어로 잘못 받아쓴 것이라, 다음 구간이 제 언어로 다시 받아씀)
                    cues = [c for c in words_to_cues(seg.words or []) if c["s"] < b - 0.2]
                    for c in cues:
                        c["l"] = lang
                    yield cues, min(seg.end, b), info.language, self.name
                return
            except Exception as e:  # noqa: BLE001
                # GPU 추론 오류(드라이버/아키텍처 미지원 등)면 CPU로 한 번 재시도
                msg = str(e).lower()
                gpu_err = any(k in msg for k in ("cuda", "cublas", "cudnn", "kernel image", "out of memory", "driver"))
                if forced_cpu or self.device != "cuda" or not gpu_err:
                    raise
                log("GPU 추론 오류, CPU로 재시도:", e)
                forced_cpu = True
                model = self.load(force_cpu=True)


def speech_segments(pcm, a, b, max_sec=15.0, silence_ms=300, pad_ms=150):
    """[a,b) 의 말소리 구간을 쉼 단위 그대로 (시작, 끝) 초로 돌려줌 (Silero VAD, 합치지 않음)"""
    seg = pcm[int(a * SR): int(b * SR)]
    # threshold 를 기본(0.5)보다 낮춤: 배경음악이 깔린 짧은 대사를 놓치지 않도록
    opts = VadOptions(threshold=0.35, min_silence_duration_ms=silence_ms, speech_pad_ms=pad_ms, max_speech_duration_s=max_sec)
    return [[float(a + t["start"] / SR), float(a + t["end"] / SR)] for t in get_speech_timestamps(seg, opts)]


def speech_chunks(pcm, a, b, max_sec):
    """[a,b) 의 말소리 구간을 max_sec 이하 덩어리로 묶어 (시작, 끝) 초로 돌려줌 (가까운 말소리는 합침)"""
    chunks = []
    for s0, s1 in speech_segments(pcm, a, b, max_sec):
        if chunks and s1 - chunks[-1][0] <= max_sec and s0 - chunks[-1][1] < 0.6:
            chunks[-1][1] = s1  # 가까운 말소리는 한 덩어리로
        else:
            chunks.append([s0, s1])
    return chunks


class ChunkEngine:
    """30초 이하 단위로 받아쓰는 모델 공통: 말소리 덩어리를 몇 개씩 묶어 처리하고 바로 내보냄"""

    max_sec = 15.0
    batch = 4

    def transcribe(self, pcm, a, b, lang):
        chunks = speech_chunks(pcm, a, b, self.max_sec)
        if not chunks:
            yield [], b, lang, self.name
            return
        for i in range(0, len(chunks), self.batch):
            part = chunks[i: i + self.batch]
            audios = [pcm[int(s0 * SR): int(s1 * SR)] for s0, s1 in part]
            cues, detected = [], lang
            for (s0, s1), (words, det) in zip(part, self.recognize(audios, lang)):
                detected = det or detected
                cues += words_to_cues([W(w, s0 + ws, s0 + we) for w, ws, we in words], gap=0.5) if words else []
            yield cues, part[-1][1], detected, self.name


class HaasEngine(ChunkEngine):
    """Haas-ja: 일본어 전용. 일본어가 아니면 Whisper 로 넘김"""

    name = "haas"
    max_sec = 15.0  # 학습 데이터가 30초 이하 발화

    def __init__(self):
        self.model = None
        self.whisper = WhisperEngine()

    def load(self):
        if self.model is None:
            self.model = haas_asr.load_model(os.environ.get("HAAS_MODEL", "third-intelligence/Haas-ja-v1.0"))
        return self.model

    def transcribe(self, pcm, a, b, lang):
        lang = self.whisper.lang_for(pcm, a, lang)
        if lang != "ja":
            yield from self.whisper.transcribe(pcm, a, b, lang)
            return
        self.load()
        yield from super().transcribe(pcm, a, b, "ja")

    def recognize(self, audios, lang):
        # 일본어는 띄어쓰기가 없어 word 시간은 문장 전체 하나뿐이므로 글자(char) 단위 시간을 씀
        # 예: {'char': ['無'], 'start': 0.56, 'end': 0.8, ...}
        hyps = self.model.transcribe(audios, batch_size=len(audios), timestamps=True, verbose=False)
        out = []
        for audio, h in zip(audios, hyps):
            chars = ((getattr(h, "timestamp", None) or {}).get("char")) or []
            words = []
            for it in chars:
                c = it.get("char")
                c = "".join(c) if isinstance(c, list) else (c or "")
                if c and it.get("start") is not None:
                    words.append((c, float(it["start"]), float(it["end"])))
            if not words and h.text.strip():  # 시간 정보가 없으면 덩어리 전체를 한 줄로
                words = [(h.text.strip(), 0.0, len(audio) / SR)]
            out.append((words, "ja"))
        return out


QWEN_LANGS = {"ja": "Japanese", "ko": "Korean", "en": "English", "zh": "Chinese", "es": "Spanish", "fr": "French",
              "de": "German", "ru": "Russian", "pt": "Portuguese", "it": "Italian", "vi": "Vietnamese", "th": "Thai",
              "id": "Indonesian", "hi": "Hindi", "ar": "Arabic", "tr": "Turkish"}
QWEN_CODES = {v.lower(): k for k, v in QWEN_LANGS.items()}


class QwenEngine(ChunkEngine):
    """Qwen3-ASR 1.7B (다국어) + ForcedAligner 로 단어 단위 시간"""

    name = "qwen"
    max_sec = 20.0

    def __init__(self):
        self.model = None

    def load(self):
        if self.model is None:
            kw = dict(dtype=torch.bfloat16, device_map="cuda:0")
            self.model = Qwen3ASRModel.from_pretrained(
                os.environ.get("QWEN_MODEL", "Qwen/Qwen3-ASR-1.7B"), **kw,
                forced_aligner=os.environ.get("QWEN_ALIGNER", "Qwen/Qwen3-ForcedAligner-0.6B"), forced_aligner_kwargs=kw,
                max_inference_batch_size=8, max_new_tokens=512)
        return self.model

    def transcribe(self, pcm, a, b, lang):
        self.load()
        yield from super().transcribe(pcm, a, b, lang)

    def recognize(self, audios, lang):
        res = self.model.transcribe(audio=[(x, SR) for x in audios], language=QWEN_LANGS.get(lang) if lang else None,
                                    return_time_stamps=True)
        out = []
        for r in res:
            # time_stamps: 정렬 항목들 (CJK 는 글자, 그 외 언어는 단어 단위 — 단어 사이에는 띄어쓰기를 붙임)
            words = []
            text, pos = r.text or "", 0
            for t in (r.time_stamps or []):
                # 정렬 항목에는 문장부호가 없으므로 전체 문장에서 그 사이 문장부호를 찾아 앞 단어에 붙임 (줄 나누기용)
                i = text.find(t.text, pos)
                if i >= 0:
                    between = "".join(ch for ch in text[pos:i] if ch in PUNCT)
                    if between and words:
                        words[-1] = (words[-1][0] + between, words[-1][1], words[-1][2])
                    pos = i + len(t.text)
                w = t.text if is_cjk(t.text) else " " + t.text
                words.append((w, float(t.start_time), float(t.end_time)))
            tail = "".join(ch for ch in text[pos:] if ch in PUNCT)
            if tail and words:
                words[-1] = (words[-1][0] + tail, words[-1][1], words[-1][2])
            det = QWEN_CODES.get(str(r.language or "").lower().split(",")[0].strip(), lang)
            out.append((words, det))
        return out


# Nemotron 은 언어를 로케일 코드로 받음. 자동 감지(auto)면 결과 끝에 <ja-JP> 같은 표시가 붙음
NEMO_LOCALES = {"ja": "ja-JP", "ko": "ko-KR", "en": "en-US", "zh": "zh-CN", "es": "es-ES", "fr": "fr-FR",
                "de": "de-DE", "ru": "ru-RU", "pt": "pt-BR", "it": "it-IT", "vi": "vi-VN", "hi": "hi-IN",
                "ar": "ar-AR", "tr": "tr-TR"}


class NemotronEngine(ChunkEngine):
    """NVIDIA Nemotron 3.5 ASR Streaming 0.6B. 스트리밍 모델이지만 가장 큰 문맥(1.12초 앞까지)으로 덩어리 단위 처리"""

    name = "nemotron"
    max_sec = 15.0

    def __init__(self):
        self.model = None

    def load(self):
        if self.model is None:
            m = nemo_asr.models.ASRModel.from_pretrained(
                model_name=os.environ.get("NEMOTRON_MODEL", "nvidia/nemotron-3.5-asr-streaming-0.6b"), map_location="cuda")
            m.eval()
            if hasattr(m.encoder, "set_default_att_context_size"):
                m.encoder.set_default_att_context_size([56, 13])  # 정확도가 가장 좋은 설정
            self.model = m
        return self.model

    def transcribe(self, pcm, a, b, lang):
        self.load()
        yield from super().transcribe(pcm, a, b, lang)

    def recognize(self, audios, lang):
        # 언어는 설정 객체로 전달 (배열 입력에도 적용됨). 시간은 글자(char) 단위:
        #   {'char': ['無'], 'start': 1.12, 'end': 1.2, ...}  — 결과 끝의 '<ja-JP>' 표시는 감지 언어로 쓰고 자막에서는 뺌
        cfg = RNNTPromptTranscribeConfig(batch_size=len(audios), timestamps=True, return_hypotheses=True,
                                         target_lang=NEMO_LOCALES.get(lang, lang) if lang else "auto")
        hyps = self.model.transcribe(audios, override_config=cfg)
        out = []
        for audio, h in zip(audios, hyps):
            m = re.search(r"<([a-z]{2})-[A-Z]{2}>", h.text or "")
            det = m.group(1) if m else lang
            words = []
            for it in ((getattr(h, "timestamp", None) or {}).get("char")) or []:
                c = it.get("char")
                c = "".join(c) if isinstance(c, list) else (c or "")
                if c and not c.startswith("<") and it.get("start") is not None:
                    words.append((c, float(it["start"]), float(it["end"])))
            out.append((words, det))
        return out


def make_engine():
    return {"haas": HaasEngine, "qwen": QwenEngine, "nemotron": NemotronEngine}.get(ENGINE, WhisperEngine)()


engine = None  # 작업 스레드에서 처음 쓸 때 생성


# ---------------- 오디오 다운로드 ----------------
def find_audio(vid):
    for p in glob.glob(os.path.join(AUDIO_DIR, vid + ".*")):
        if not p.endswith((".part", ".ytdl", ".temp")):
            return p
    return None


def download_audio(vid, lang):
    path = find_audio(vid)
    if path:
        return path
    import imageio_ffmpeg

    cmd = [
        sys.executable, "-m", "yt_dlp",
        "-f", "bestaudio[ext=m4a]/bestaudio",
        "--no-playlist", "--no-warnings", "--no-part",
        "--newline", "--progress-template", "download:YTKO %(progress._percent_str)s",
        "--js-runtimes", "node",
        "--ffmpeg-location", imageio_ffmpeg.get_ffmpeg_exe(),
        "-o", os.path.join(AUDIO_DIR, "%(id)s.%(ext)s"),
        "https://www.youtube.com/watch?v=" + vid,
    ]
    # stdin을 워커의 파이프와 분리 (물려받으면 하위 프로세스가 명령 스트림을 읽으며 멈출 수 있음)
    for attempt in range(3):  # 유튜브가 가끔 일시적으로 403을 주므로 재시도
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                             text=True, encoding="utf-8", errors="replace")
        out, last = "", 0.0
        for line in p.stdout:
            if line.startswith("YTKO "):
                try:
                    pct = float(line[5:].strip().rstrip("%"))
                except ValueError:
                    continue
                if time.time() - last > 0.7:
                    last = time.time()
                    emit_status(vid, lang, "downloading", f"오디오 받는 중 {pct:.0f}%", pct / 100)
            else:
                out += line
        try:
            p.wait(timeout=600)
        except subprocess.TimeoutExpired:
            p.kill()
        path = find_audio(vid)
        if p.returncode == 0 and path:
            break
        time.sleep(3 * (attempt + 1))
    if p.returncode != 0 or not path:
        raise RuntimeError("오디오 다운로드 실패: " + out.strip()[-400:])
    return path


# ---------------- 자막 분할 ----------------
SENT_END = (".", "?", "!", "。", "？", "！", "…")
PUNCT = set("、。，．,.!?！？…「」『』")


def is_cjk(text):
    n = sum(1 for ch in text if "぀" <= ch <= "ヿ" or "一" <= ch <= "鿿" or "가" <= ch <= "힯")
    return n > len(text) * 0.3


def words_to_cues(words, gap=0.8):
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
        if text and not all(ch in PUNCT or ch.isspace() for ch in text):  # 문장부호만 있는 줄은 버림
            cues.append({"s": round(cur[0].start, 2), "e": round(cur[-1].end, 2), "o": text})
        cur.clear()

    for w in words:
        if cur:
            length = len("".join(x.word for x in cur) + w.word)
            if w.start - cur[-1].end > gap or length > max_chars or (w.end - cur[0].start) > max_dur:
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
pending = None  # (videoId, from, lang)
jobs = {}  # (videoId, 요청 언어) -> {"covered": [[a,b],...], "dur": float, "audio": str}


def take_pending_for(vid, lang):
    """실행 중 같은 영상·언어의 탐색 요청이 들어왔으면 (from)을 돌려주고 소비. 다른 작업이면 'other'."""
    global pending
    with cv:
        if pending is None:
            return None
        if pending[0] == vid and pending[2] == lang:
            pos = pending[1]
            pending = None
            return pos
        return "other"


def emit_progress(vid, lang, job):
    job["covered"] = merge(job["covered"])  # 겹친 구간을 합쳐 목록을 작게 유지
    dur = job["dur"] or 0
    done = sum(min(b, dur) - max(a, 0) for a, b in job["covered"] if b > a)
    p = max(0.0, min(1.0, done / dur)) if dur > 0 else 0.0
    emit_status(vid, lang, "transcribing", f"받아쓰기 {p * 100:.0f}%", p)


def run_pass(vid, job, a, b, lang):
    """[a,b) 구간 받아쓰기. 반환: 'ok' | ('seek', pos) | 'other'"""
    cursor = a
    last = 0.0
    for cues, end, detected, used in engine.transcribe(job["pcm"], a, b, lang):
        if cues:
            emit({"ev": "cues", "videoId": vid, "req": lang, "cues": cues, "lang": detected, "used": used})
        job["covered"].append([cursor, end])
        cursor = max(cursor, end)
        if time.time() - last > 1.0:
            last = time.time()
            emit_progress(vid, lang, job)
        req = take_pending_for(vid, lang)
        if req == "other":
            return "other"
        if req is not None:
            return ("seek", req)
    job["covered"].append([cursor, b])
    return "ok"


def run_job(vid, pos, lang):
    key = (vid, lang)
    job = jobs.get(key)
    if job is None:
        emit_status(vid, lang, "downloading", "오디오 받는 중…")
        audio = download_audio(vid, lang)  # 같은 영상의 다른 언어 작업과 오디오 파일은 공유
        pcm = decode_audio(audio, sampling_rate=SR)  # 작업당 한 번만 해독 (21분 기준 약 1초, 80MB)
        job = {"covered": [], "dur": len(pcm) / SR, "audio": audio, "pcm": pcm}
        jobs[key] = job
        while len(jobs) > 3:
            jobs.pop(next(iter(jobs)))
    global engine
    emit_status(vid, lang, "loading", "음성 인식 모델 준비 중…")
    if engine is None:
        engine = make_engine()
    while True:
        gap = next_gap(job["covered"], pos, job["dur"])
        if gap is None:
            emit_status(vid, lang, "done", "완료", 1)
            jobs.pop(key, None)
            if not any(v == vid for v, _ in jobs):  # 같은 영상을 쓰는 작업이 없을 때만 오디오 삭제
                try:
                    os.remove(job["audio"])
                except OSError:
                    pass
            return
        emit_progress(vid, lang, job)
        res = run_pass(vid, job, gap[0], gap[1], lang)
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
            vid, pos, lang = pending
            pending = None
        try:
            run_job(vid, pos, lang)
        except Exception as e:  # noqa: BLE001
            log("작업 실패:", repr(e))
            emit_status(vid, lang, "error", str(e)[-400:])


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
    for line in PROTO_IN:
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
                lang = str(msg.get("lang") or "")
                if lang and not (lang.isalpha() and lang.islower() and len(lang) <= 3):
                    lang = ""
                pending = (vid, float(msg.get("from", 0)), lang)
                cv.notify()


if __name__ == "__main__":
    main()
