#!/usr/bin/env bash
# 번역 호스트 실행 (Linux). 종료: Ctrl+C
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
echo "YouTube 한글 번역 호스트를 시작합니다. (종료: Ctrl+C)"
exec node server.js
