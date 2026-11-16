#!/usr/bin/env bash
# 추가 음성 인식 엔진 설치 (Linux + NVIDIA GPU 전용). setup.sh 를 먼저 실행해 둘 것.
#   ./setup_engines.sh                 # Haas-ja + Qwen3-ASR + Nemotron 모두
#   ./setup_engines.sh haas nemotron   # 골라서
# 각 엔진은 host/engines/ 아래 자기 가상환경에 설치됨 (각 6~7GB). 지우려면 그 폴더만 삭제.
# TORCH_CUDA: 그래픽 드라이버가 지원하는 CUDA 버전용 PyTorch (기본 cu126 — 드라이버 560 이상).
#   최신 PyTorch 기본 빌드는 CUDA 13 용이라 드라이버 580 미만에서는 GPU를 못 씀 (nvidia-smi 의 "CUDA Version" 확인)
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
TORCH_CUDA="${TORCH_CUDA:-cu126}"
TORCH_INDEX="https://download.pytorch.org/whl/$TORCH_CUDA"
WANT="${*:-haas qwen nemotron}"
mkdir -p engines

# 지정한 CUDA 빌드로 같은 버전의 torch 를 다시 설치
swap_torch() {
  local py="$1" ver
  ver=$("$py" -c "import torch; print(torch.__version__.split('+')[0])")
  echo "  torch $ver -> $ver+$TORCH_CUDA"
  uv pip install --python "$py" -q --index-url "$TORCH_INDEX" --extra-index-url https://pypi.org/simple \
    --index-strategy unsafe-best-match "torch==$ver+$TORCH_CUDA" ||
    uv pip install --python "$py" -q --index-url "$TORCH_INDEX" --extra-index-url https://pypi.org/simple \
      --index-strategy unsafe-best-match "torch<=$ver"
}

if [[ " $WANT " == *" haas "* ]]; then
  echo "== Haas-ja (engines/Haas-ASR) =="
  [ -d engines/Haas-ASR ] || git clone --depth 1 https://github.com/third-intelligence/Haas-ASR.git engines/Haas-ASR
  (cd engines/Haas-ASR && uv sync --python 3.12)
  PY=engines/Haas-ASR/.venv/bin/python
  swap_torch "$PY"
  # 일본어가 아닐 때 쓰는 Whisper + 오디오 다운로드 (PyAV 17 이상은 faster-whisper 와 맞지 않음)
  uv pip install --python "$PY" -q faster-whisper "yt-dlp[default]" imageio-ffmpeg "av>=14,<17"
fi

if [[ " $WANT " == *" qwen "* ]]; then
  echo "== Qwen3-ASR (engines/qwen) =="
  mkdir -p engines/qwen
  [ -x engines/qwen/.venv/bin/python ] || uv venv --python 3.12 engines/qwen/.venv -q
  PY=engines/qwen/.venv/bin/python
  uv pip install --python "$PY" -q qwen-asr faster-whisper "yt-dlp[default]" imageio-ffmpeg "av>=14,<17"
  swap_torch "$PY"
fi

if [[ " $WANT " == *" nemotron "* ]]; then
  echo "== Nemotron 3.5 ASR Streaming 0.6B (engines/nemotron) — NeMo 최신판(main) 필요 =="
  mkdir -p engines/nemotron
  [ -x engines/nemotron/.venv/bin/python ] || uv venv --python 3.12 engines/nemotron/.venv -q
  PY=engines/nemotron/.venv/bin/python
  uv pip install --python "$PY" -q Cython packaging
  uv pip install --python "$PY" -q "nemo_toolkit[asr] @ git+https://github.com/NVIDIA/NeMo.git@main"
  # 설치된 torch 버전에 해당 CUDA 빌드가 없을 수 있어 (예: 2.15 에는 cu126 없음) 있는 버전으로 고정
  uv pip install --python "$PY" -q --index-url "$TORCH_INDEX" --extra-index-url https://pypi.org/simple \
    --index-strategy unsafe-best-match "torch==${NEMOTRON_TORCH:-2.14.1}+$TORCH_CUDA"
  uv pip install --python "$PY" -q faster-whisper "yt-dlp[default]" imageio-ffmpeg "av>=14,<17"
fi

echo "== 확인 =="
for e in Haas-ASR qwen nemotron; do
  py=engines/$e/.venv/bin/python
  [ -x "$py" ] && "$py" -c "import torch; print('$e: torch', torch.__version__, 'GPU', torch.cuda.is_available())" 2>/dev/null | tail -1
done
echo "완료. 호스트를 재시작하면 팝업의 '음성 인식 모델'에서 고를 수 있습니다 (처음 사용할 때 모델을 내려받아 1~3분 걸림)."
