# YouTube AI 자막 번역 (개인용)

유튜브 영상의 자막(또는 음성)을 로컬 `codex` CLI(ChatGPT 로그인) 또는 Claude Code(Claude 로그인)로 원하는 언어(기본 한국어)로 자연스럽게 번역해 영상 위에 오버레이로 보여줍니다.

## 구성
- `host/server.js` — 로컬 서버 (127.0.0.1:17891). 번역은 codex, 음성 인식은 `stt_worker.py`에 위임
- `host/codex_session.js` — 번역 버튼이 켜져 있는 동안 띄워 두는 상주 codex(`codex app-server`)
- `host/stt_worker.py` — `yt-dlp`로 오디오를 받아 음성 인식 엔진(GPU)으로 받아쓰기. 자막이 없는 영상용
  - 엔진: Whisper(`host/.venv`), Haas-ja(`host/engines/Haas-ASR`), Qwen3-ASR(`host/engines/qwen`),
    Nemotron(`host/engines/nemotron`) — 엔진마다 자기 가상환경으로 실행
- `extension/` — Chrome 확장 프로그램 (MV3)

## Windows에서 사용 (음성 인식은 Whisper 만)
1. Node 18+ 와 번역 엔진 하나 이상: ChatGPT 구독이면 `npm install -g @openai/codex` 후 `codex login`, Claude 구독이면 Claude Code 설치 후 `claude` 를 한 번 실행해 로그인
2. 최초 1회: `host\setup.bat` 실행 — `host\.venv`(Python 3.12)에 yt-dlp, faster-whisper 등을 설치
   (NVIDIA GPU가 있으면 CUDA 라이브러리까지, 없으면 CPU 모드)
3. 실행: `host\start.bat` (창을 띄워 둠)
- Haas/Qwen/Nemotron 은 Linux 전용입니다. Linux 에서 고른 모델 설정이 동기화돼 와도 Windows 호스트는 Whisper 로 처리합니다.

## 사용
1. 호스트 실행 (Windows: 위 참고 / Linux: 아래 참고)
2. `chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램 로드" → `extension` 폴더
3. 유튜브 영상의 **플레이어 컨트롤(자막 CC 버튼 옆)에 있는 번역 버튼**을 누르면 번역이 시작됩니다.
   - 기본은 꺼짐이며, 새로고침해도 꺼진 상태로 시작합니다.
   - 영상이 끝나거나 다른 영상/페이지로 이동하면 자동으로 꺼집니다.
   - 숏츠(`/shorts/...`)는 위쪽 오른쪽 컨트롤(CC 버튼 옆)에 버튼이 있습니다. 다음 숏츠로 넘기면 일반 영상처럼 꺼집니다.
4. 확장 프로그램 팝업: 원문/번역 언어, 번역 엔진·말투, 음성 인식 사용·모델, 자동 생성 자막 대신 음성 인식, 원문 병기, 글자 크기, 자막 위치, 현재 영상 상태

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
3. 실행: `./start.sh` (터미널을 띄워 둠). 로그인할 때 자동으로 띄우려면 systemd 사용자 서비스로 등록:
   ```ini
   # ~/.config/systemd/user/yt-ko.service
   [Service]
   WorkingDirectory=<저장소>/host
   Environment=PATH=<node 경로>:%h/.npm-global/bin:%h/.local/bin:/usr/bin:/bin
   # 사내 프록시가 있으면 http_proxy/https_proxy 도 지정, no_proxy=127.0.0.1,localhost
   ExecStart=<node 경로>/node server.js
   StandardOutput=append:<저장소>/host/host.log
   StandardError=inherit
   Restart=on-failure
   [Install]
   WantedBy=default.target
   ```
   `systemctl --user enable --now yt-ko` (상태: `systemctl --user status yt-ko`, 로그: `tail -f host/host.log`).
   로그인 없이 부팅 시 시작하려면 `sudo loginctl enable-linger $USER`.
4. 서버의 Chrome에서 `chrome://extensions` → 개발자 모드 → `extension` 폴더 로드
5. (선택) 추가 음성 인식 엔진: `./setup_engines.sh` (Haas-ja + Qwen3-ASR + Nemotron, 각 6~7GB, NVIDIA GPU 필요) 후 호스트 재시작.
   드라이버가 CUDA 12.x 까지만 지원하면 기본값(`TORCH_CUDA=cu126`)으로 두고, 최신 드라이버면 `TORCH_CUDA=cu128` 등으로 지정
- GPU 없는 CPU 서버: 자막이 있는 영상은 영향이 없고, 자막 없는 영상의 받아쓰기만 느려집니다 (코어 수에 따라 재생 속도의 1~5배 수준).
  `WHISPER_CPU_MODEL=base` 로 더 가볍게, `medium` 으로 더 정확하게 바꿀 수 있습니다.
- Windows PC의 Chrome에서 원격 Rocky 서버의 호스트를 쓰는 구성은 지원하지 않습니다 (호스트는 127.0.0.1에만 열림).

## 동작
- 유튜브 자막이 있으면 그것을 번역 (STT 없음). 원문 언어를 지정하면 그 언어 자막을 우선 사용
- 자막이 없거나 받을 수 없으면 오디오를 받아 재생 위치부터 받아쓰기 → 번역 (GPU 기준 21분 영상 약 25초, 첫 자막 수 초)
- 재생 위치 바로 앞은 3줄씩 먼저 보내 첫 자막을 빨리 띄우고(약 2.5~3초), 가까운 구간은 작은 묶음, 먼 구간은 큰 묶음으로 번역.
  시간을 건너뛴 직후의 번역은 동시 요청 한도가 차 있어도 우선 처리. 재생 위치보다 약 12분 앞까지만 번역 (구독 한도 절약)
- 번역 버튼이 켜져 있는 동안 codex를 상주시켜 요청마다 프로세스를 띄우는 비용을 줄임. 꺼지면(버튼/영상 끝/이동) codex도 종료,
  탭을 그냥 닫아도 3분 뒤 자동 종료. 음성 인식 워커도 같이 종료해 GPU 메모리를 비움 (다시 켜면 받아쓰기를 이어서 진행)
- `[音楽]`, `[Music]`, `♪` 처럼 소리 설명만 있는 줄은 번역하지 않고 ♪ 로 표시
- 자막은 글자 수에 맞춰 읽을 시간(1.5~8초)만큼 표시, 한 번에 한 줄. 위치는 팝업의 "자막 위치"(화면 아래에서 0~30%),
  플레이어 컨트롤 바가 보일 때는 그 위로 자동으로 올라감
- 번역 결과는 영상별로 브라우저에, 받아쓰기 결과는 `host/cache/transcripts`에 캐시

## 번역 엔진 (팝업에서 선택, 기본 ChatGPT)
| 엔진 | 필요한 것 | 비고 |
|---|---|---|
| ChatGPT (codex) | ChatGPT 구독 + `codex login` | 번역 버튼을 켜 둔 동안 상주시켜 빠르게 |
| Claude Sonnet / Haiku | Claude 구독 + Claude Code 로그인 | 요청마다 `claude -p --safe-mode` 실행 (사용자 설정·훅·MCP 끔). 2줄 기준 2.4~2.7초 |
- 번역 사용량은 각 구독 한도에서 차감됩니다. Claude 모델을 직접 지정하려면 `CLAUDE_MODEL_SONNET` / `CLAUDE_MODEL_HAIKU`, 실행 파일 경로는 `CLAUDE_BIN`.
- 이 PC에 없는 엔진을 고르면(설정이 다른 PC에서 동기화된 경우 등) 설치된 다른 엔진으로 대신하고, 팝업도 설치된 엔진으로 바꿉니다.
- 엔진을 바꾸면 그 영상은 재생 위치부터 새 엔진으로 다시 번역합니다 (번역 캐시는 엔진별). 새 번역이 올 때까지는 기존 번역을 그대로 보여 줍니다.

## 번역 말투 (팝업에서 선택, 기본 "기본")
- 기본(자연스러운 구어체), 친절한 존댓말, 친구 반말, 힙합·스트릿, AAVE(미국 흑인 영어 슬랭, 영어로 번역할 때 실제 AAVE 문법 사용), 갱스터 영화(욕설 섞인 거친 말투), 사극, 뉴스 앵커, 귀여운 말투, 예쁜 말(부정적인 말을 순화), 섹시한 말투
- 지시문은 `host/server.js` 의 `STYLES` 에 있고, 팝업 목록은 `extension/popup.html` 의 `#style` 에 있습니다 (말투를 추가할 때 둘 다 수정)
- 말투를 바꾸면 재생 위치부터 새 말투로 다시 번역하고, 그동안은 기존 번역을 그대로 보여 줍니다. 번역 캐시는 말투별이라 써 본 말투로 돌아가면 바로 나옵니다.
- 말투를 고르면 원문이 이미 번역 언어(예: 한국어 영상)여도 그 말투로 바꿔 줍니다. "기본"이면 같은 언어 영상은 그대로 둡니다.

## 음성 인식 모델 (팝업에서 선택, 기본 Whisper)
| 모델 | 언어 | 특징 |
|---|---|---|
| Haas-ja v1.0 | 일본어 | 일본어 전용. 일본어가 아니면(자동 감지) 같은 환경의 Whisper 로 처리 |
| Qwen3-ASR 1.7B | 다국어 | 언어 자동 감지 내장, ForcedAligner 로 단어 단위 시간 |
| Whisper large-v3 | 다국어 | 기본 환경(`setup.sh`)만으로 사용 가능 |
| Nemotron 3.5 ASR Streaming 0.6B | 다국어 40개 로케일 | 작고 빠름. NeMo 최신판(main) 필요 |
- 일본어 애니메이션 한 구간 비교에서는 Whisper ≥ Haas > Qwen ≈ Nemotron 이었습니다 (배경음악이 큰 영상은 영상마다 다를 수 있음).
- Haas/Qwen 은 처음 쓸 때 모델을 내려받고 올리는 데 20초~3분 걸리고, 이후에는 빠릅니다.
- 받아쓰기 캐시는 `host/cache/transcripts/<영상>.<엔진>.<언어|auto>.json`.

## 환경변수 (host 실행 전에 설정)
- `CODEX_MODEL` 번역 모델 (기본: codex 기본값)
- `CODEX_EFFORT` 추론 강도 (기본 low. 속도를 우선하면 none — 약 20% 빠르지만 품질이 조금 떨어질 수 있음)
- `WHISPER_MODEL` GPU용 음성 인식 모델 (기본 large-v3, 더 빠르게는 large-v3-turbo), `WHISPER_CPU_MODEL` CPU용 (기본 small)
- `HAAS_MODEL`, `QWEN_MODEL`, `QWEN_ALIGNER` 다른 체크포인트를 쓸 때
- `CODEX_BIN` codex 실행 파일 경로 (PATH에 없을 때)
- `MAX_CONCURRENT` 동시 번역 수 (기본 3)

## 문제 해결
- 상태 표시(영상 왼쪽 위)가 빨간색이면 그 문구가 원인입니다. 팝업의 "현재 영상" 아래 회색 진단 줄도 참고하세요.
- 확장 프로그램을 다시 로드한 뒤에는 열려 있던 유튜브 탭을 새로고침(F5)하세요.
- 유튜브가 바뀌어 오디오 다운로드가 실패하면 yt-dlp 업데이트:
  - Windows: `uv pip install -U yt-dlp --python host\.venv\Scripts\python.exe`
  - Linux: `uv pip install -U yt-dlp --python host/.venv/bin/python`
- 라이브 스트림, 멤버십 전용/연령 제한 영상, 일부 "봇 확인"이 걸린 영상은 음성 인식이 안 될 수 있습니다.
- 보안: 호스트는 127.0.0.1에만 열리고, 확장 프로그램이 붙이는 `X-YTKO` 헤더가 있는 요청만 받습니다
  (웹페이지는 이 헤더를 붙이면 CORS 사전 요청에서 차단됨).
