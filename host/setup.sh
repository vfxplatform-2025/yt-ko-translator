#!/usr/bin/env bash
# Linux(Rocky 9 등) 최초 설치 스크립트. 시스템 패키지는 설치하지 않고 필요한 명령만 안내합니다.
# 하는 일: uv 설치(사용자 영역) -> host/.venv 생성(Python 3.12) -> yt-dlp, faster-whisper 등 설치
set -euo pipefail
cd "$(dirname "$0")"

echo "== 1) 필수 프로그램 확인 =="
missing=0
if ! command -v node >/dev/null 2>&1; then
  echo "[없음] node (18 이상 필요). Rocky 9:"
  echo "       sudo dnf module enable -y nodejs:20 && sudo dnf install -y nodejs"
  missing=1
else
  echo "[OK] node $(node --version)"
fi
if ! command -v codex >/dev/null 2>&1; then
  echo "[없음] codex CLI. 설치 후 'codex login' 으로 ChatGPT 로그인:"
  echo "       sudo npm install -g @openai/codex   (또는 npm config set prefix ~/.npm-global 후 -g 없이 사용자 설치)"
  missing=1
else
  echo "[OK] codex $(codex --version 2>/dev/null | head -1)"
fi
if [ "$missing" = "1" ]; then
  echo
  echo "위 항목을 먼저 설치한 뒤 이 스크립트를 다시 실행하세요."
  exit 1
fi

echo "== 2) uv 확인 =="
if ! command -v uv >/dev/null 2>&1; then
  if [ -x "$HOME/.local/bin/uv" ]; then
    export PATH="$HOME/.local/bin:$PATH"
  else
    echo "uv가 없어 사용자 영역(~/.local/bin)에 설치합니다 (https://astral.sh/uv)"
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
  fi
fi
echo "[OK] $(uv --version)"

echo "== 3) 가상환경 + 패키지 설치 (host/.venv) =="
uv venv --python 3.12 .venv
PKGS=("yt-dlp[default]" faster-whisper "av>=14,<17" imageio-ffmpeg)
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
  echo "NVIDIA GPU 감지 -> CUDA 라이브러리도 설치합니다 (용량이 큽니다, 약 1.2GB)"
  PKGS+=(nvidia-cublas-cu12 nvidia-cudnn-cu12)
else
  echo "NVIDIA GPU 없음 -> CPU 모드로 동작합니다 (음성 인식 모델은 기본 'small')"
fi
uv pip install --python .venv/bin/python "${PKGS[@]}"

echo "== 4) 확인 =="
.venv/bin/python - <<'PY'
import ctranslate2, yt_dlp
print("yt-dlp", yt_dlp.version.__version__)
print("CUDA 장치 수:", ctranslate2.get_cuda_device_count())
PY
echo
echo "완료. 'codex login status' 로 로그인 상태를 확인한 뒤 ./start.sh 로 호스트를 실행하세요."
