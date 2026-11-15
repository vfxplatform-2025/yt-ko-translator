const defaults = { enabled: true, fontSize: 26, showOriginal: false, sttEnabled: true };
const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(defaults, (s) => {
  $('enabled').checked = s.enabled;
  $('sttEnabled').checked = s.sttEnabled;
  $('showOriginal').checked = s.showOriginal;
  $('fontSize').value = s.fontSize;
  $('fsv').textContent = `${s.fontSize}px`;
});
$('enabled').onchange = (e) => chrome.storage.sync.set({ enabled: e.target.checked });
$('sttEnabled').onchange = (e) => chrome.storage.sync.set({ sttEnabled: e.target.checked });
$('showOriginal').onchange = (e) => chrome.storage.sync.set({ showOriginal: e.target.checked });
$('fontSize').oninput = (e) => {
  $('fsv').textContent = `${e.target.value}px`;
  chrome.storage.sync.set({ fontSize: Number(e.target.value) });
};

chrome.runtime.sendMessage({ type: 'health' }, (r) => {
  const el = $('host');
  if (r && r.ok) {
    el.textContent = r.stt ? '번역 호스트 연결됨 (음성 인식 사용 가능)' : '번역 호스트 연결됨 (음성 인식 미설치)';
    el.classList.add('ok');
  } else {
    el.textContent = '호스트 꺼짐 — host\\start.bat 실행 필요';
    el.classList.add('bad');
  }
});
