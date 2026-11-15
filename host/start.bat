@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo YouTube 한글 번역 호스트를 시작합니다. (이 창을 닫으면 번역이 중단됩니다)
node server.js
pause
