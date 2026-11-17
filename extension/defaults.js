// 설정 기본값. 콘텐츠 스크립트(content.js)와 팝업(popup.js)이 함께 씀 — 새 설정은 여기에만 추가
globalThis.YTKO_DEFAULTS = Object.freeze({
  enabled: true,
  fontSize: 32,
  subPos: 2,
  showOriginal: false,
  sttEnabled: true,
  preferStt: false,
  sttEngine: 'whisper',
  translator: 'codex',
  style: 'natural',
  sourceLang: 'auto',
  targetLang: 'ko',
});
