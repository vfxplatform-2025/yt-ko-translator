@echo off
rem Windows 최초 설치 스크립트 (setup.sh 와 같은 일). Windows 에서는 음성 인식 모델로 Whisper 만 사용합니다.
rem 하는 일: 필수 프로그램 확인 -> uv 설치(사용자 영역) -> host\.venv 생성(Python 3.12) -> yt-dlp, faster-whisper 등 설치
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo == 1) 필수 프로그램 확인 ==
set MISSING=
where node >nul 2>nul || (echo [없음] node 18 이상: https://nodejs.org 에서 설치& set MISSING=1)
rem 번역 엔진: codex(ChatGPT 구독) 또는 Claude Code(Claude 구독) 중 하나 이상 (팝업에서 고름)
set HAVE_TR=
where codex >nul 2>nul && set HAVE_TR=1
where claude >nul 2>nul && set HAVE_TR=1
if not defined HAVE_TR (
  echo [없음] 번역 엔진. 둘 중 하나 이상 설치 후 로그인:
  echo        ChatGPT: npm install -g @openai/codex 후 codex login
  echo        Claude : https://claude.com/claude-code 에서 Claude Code 설치 후 claude 실행해 로그인
  set MISSING=1
)
if defined MISSING (
  echo.
  echo 위 항목을 먼저 설치한 뒤 이 스크립트를 다시 실행하세요.
  pause
  exit /b 1
)

echo == 2) uv 확인 ==
where uv >nul 2>nul
if errorlevel 1 (
  echo uv 가 없어 사용자 영역에 설치합니다 ^(https://astral.sh/uv^)
  powershell -NoProfile -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
)
set "PATH=%USERPROFILE%\.local\bin;%PATH%"

echo == 3) 가상환경 + 패키지 설치 (host\.venv) ==
uv venv --python 3.12 .venv || goto :fail
rem PyAV 17 이상은 faster-whisper 와 맞지 않음
set PKGS="yt-dlp[default]" faster-whisper "av>=14,<17" imageio-ffmpeg
nvidia-smi >nul 2>nul
if errorlevel 1 (
  echo NVIDIA GPU 없음 -^> CPU 모드로 동작합니다 ^(음성 인식 모델은 기본 small^)
) else (
  echo NVIDIA GPU 감지 -^> CUDA 라이브러리도 설치합니다 ^(약 1.2GB^)
  set PKGS=%PKGS% nvidia-cublas-cu12 nvidia-cudnn-cu12
)
uv pip install --python .venv\Scripts\python.exe %PKGS% || goto :fail

echo == 4) 확인 ==
.venv\Scripts\python.exe -c "import ctranslate2, yt_dlp; print('yt-dlp', yt_dlp.version.__version__); print('CUDA 장치 수:', ctranslate2.get_cuda_device_count())"
echo.
echo 완료. start.bat 로 호스트를 실행하세요.
pause
exit /b 0

:fail
echo 설치 중 오류가 났습니다. 위 메시지를 확인하세요.
pause
exit /b 1
