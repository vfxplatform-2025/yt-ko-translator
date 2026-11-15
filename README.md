# YouTube 한글 자막 번역 (개인용)

유튜브 영상의 자막(또는 음성)을 로컬 `codex` CLI(ChatGPT 로그인)로 자연스러운 한국어로 번역해 영상 위에 오버레이로 보여줍니다.

## 구성
- `host/server.js` — 로컬 서버 (127.0.0.1:17891). 번역은 `codex exec`, 음성 인식은 `stt_worker.py`에 위임
- `host/stt_worker.py` — `yt-dlp`로 오디오를 받아 `faster-whisper`(GPU)로 받아쓰기. 자막이 없는 영상용
- `extension/` — Chrome 확장 프로그램 (MV3)

## 사용
1. `host\start.bat` 실행 (창을 띄워 둠)
2. `chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램 로드" → `extension` 폴더
3. 유튜브 영상을 열면 자동으로 동작. 팝업에서 켜기/끄기, 원문 병기, 글자 크기, 음성 인식 사용 여부 설정

## Rocky Linux 9 (Linux)에서 사용
호스트와 Chrome이 **같은 서버**에서 돌아가는 구성을 기준으로 합니다 (예: DCV 원격 데스크톱 안의 Chrome).
1. Node 18+ 와 codex CLI 설치 후 `codex login` (ChatGPT 로그인)
   ```bash
   sudo dnf module enable -y nodejs:20 && sudo dnf install -y nodejs
   sudo npm install -g @openai/codex
   codex login
   ```
2. 최초 1회: `cd host && chmod +x setup.sh start.sh && ./setup.sh`
   - `uv`로 `host/.venv`(Python 3.12)를 만들고 yt-dlp, faster-whisper 등을 설치합니다.
   - NVIDIA GPU가 있으면 CUDA 라이브러리까지 설치하고, **없으면 CPU 모드**(모델 `small`, int8)로 동작합니다.
3. 실행: `./start.sh`
4. 서버의 Chrome에서 `chrome://extensions` → 개발자 모드 → `extension` 폴더 로드
- GPU 없는 CPU 서버: 자막이 있는 영상은 영향이 없고, 자막 없는 영상의 받아쓰기만 느려집니다 (코어 수에 따라 재생 속도의 1~5배 수준).
  `WHISPER_CPU_MODEL=base` 로 더 가볍게, `medium` 으로 더 정확하게 바꿀 수 있습니다.
- Windows PC의 Chrome에서 원격 Rocky 서버의 호스트를 쓰는 구성은 지원하지 않습니다 (호스트는 127.0.0.1에만 열림).

## 동작
- 유튜브 자막이 있으면 그것을 번역 (STT 없음)
- 자막이 없으면 오디오를 받아 재생 속도의 수십 배로 받아쓰기 → 번역
- 재생 위치보다 약 12분 앞까지만 번역 (구독 한도 절약). 시간을 건너뛰면 그 지점부터 우선 처리
- 번역 결과는 영상별로 브라우저에, 받아쓰기 결과는 `host/cache/transcripts`에 캐시

## 환경변수 (host 실행 전에 설정)
- `CODEX_MODEL` 번역 모델 (기본: codex 기본값), `CODEX_EFFORT` 추론 강도 (기본 low)
- `WHISPER_MODEL` GPU용 음성 인식 모델 (기본 large-v3-turbo), `WHISPER_CPU_MODEL` CPU용 (기본 small)
- `CODEX_BIN` codex 실행 파일 경로 (PATH에 없을 때)
- `MAX_CONCURRENT` 동시 번역 수 (기본 3)

## 문제 해결
- 상태 표시(영상 왼쪽 위)가 빨간색이면 그 문구가 원인입니다.
- 유튜브가 바뀌어 오디오 다운로드가 실패하면: `host\.venv\Scripts\python.exe -m pip install -U yt-dlp` (또는 `uv pip install -U yt-dlp --python host\.venv\Scripts\python.exe`)
- 라이브 스트림, 멤버십 전용/연령 제한 영상은 음성 인식이 안 될 수 있습니다.
- 보안: 호스트는 127.0.0.1에만 열리고 `chrome-extension://` 출처의 요청만 받습니다.
