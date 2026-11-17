const defaults = YTKO_DEFAULTS; // defaults.js
const $ = (id) => document.getElementById(id);

// 고를 수 있는 언어 (YouTube 자막 코드 / Whisper 코드와 앞부분이 같도록)
const LANGS = ['ko', 'en', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'de', 'ru', 'pt', 'it', 'vi', 'th', 'id', 'hi', 'ar', 'tr'];
const names = new Intl.DisplayNames(['ko'], { type: 'language' });
const langName = (c) => {
  try { return names.of(c) || c; } catch (_) { return c; }
};

function fill(sel, withAuto) {
  if (withAuto) sel.add(new Option('자동 감지', 'auto'));
  // 원문 쪽은 중국어 간체/번체 구분이 필요 없어서 하나로
  const codes = withAuto ? LANGS.filter((c) => c !== 'zh-Hant').map((c) => (c === 'zh-Hans' ? 'zh' : c)) : LANGS;
  for (const c of codes) sel.add(new Option(`${langName(c)} (${c})`, c));
}
fill($('sourceLang'), true);
fill($('targetLang'), false);

// 설정 칸: id 가 저장 키와 같음
const TOGGLES = ['enabled', 'sttEnabled', 'preferStt', 'showOriginal'];
const SELECTS = ['sourceLang', 'targetLang', 'sttEngine', 'translator', 'style'];
chrome.storage.sync.get(defaults, (s) => {
  for (const k of TOGGLES) $(k).checked = s[k];
  for (const k of SELECTS) $(k).value = s[k];
  $('fontSize').value = s.fontSize;
  $('fsv').textContent = `${s.fontSize}px`;
  $('subPos').value = s.subPos;
  $('spv').textContent = `${s.subPos}%`;
});
for (const k of TOGGLES) $(k).onchange = (e) => chrome.storage.sync.set({ [k]: e.target.checked });
for (const k of SELECTS) $(k).onchange = (e) => chrome.storage.sync.set({ [k]: e.target.value });
$('subPos').oninput = (e) => {
  $('spv').textContent = `${e.target.value}%`;
  chrome.storage.sync.set({ subPos: Number(e.target.value) });
};
$('fontSize').oninput = (e) => {
  $('fsv').textContent = `${e.target.value}px`;
  chrome.storage.sync.set({ fontSize: Number(e.target.value) });
};

let hostOk = false;
function checkHost() {
  if (hostOk) return; // 연결 확인되면 더 묻지 않음 (꺼져 있을 때만 다시 확인)
  chrome.runtime.sendMessage({ type: 'health' }, (r) => {
    void chrome.runtime.lastError;
    hostOk = !!(r && r.ok);
    const el = $('host');
    el.classList.remove('ok', 'bad');
    if (r && r.ok) {
      $('hostText').textContent = r.stt ? '호스트 연결됨' : '연결됨 · 음성 인식 없음';
      el.title = r.stt ? '번역 + 음성 인식 사용 가능' : 'host/.venv 가 없어 음성 인식을 쓸 수 없습니다';
      el.classList.add('ok');
      // 설치되지 않은 음성 인식 모델·번역 엔진은 고를 수 없게
      // 저장된 선택이 이 PC에 없는 것이면 설치된 첫 항목으로 바꿔 저장 (설정은 PC 사이에 동기화되므로)
      const mark = (sel, ready, keyOf) => {
        for (const o of sel.options) {
          const ok = !ready || ready[keyOf(o.value)];
          o.disabled = !ok;
          o.textContent = o.textContent.replace(/ \(미설치\)$/, '') + (ok ? '' : ' (미설치)');
        }
        const cur = sel.options[sel.selectedIndex];
        const first = [...sel.options].find((o) => !o.disabled);
        if (cur && cur.disabled && first) {
          sel.value = first.value;
          chrome.storage.sync.set({ [sel.id]: first.value });
        }
      };
      mark($('sttEngine'), r.engines, (v) => v);
      mark($('translator'), r.translators, (v) => v.split('-')[0]);
    } else {
      $('hostText').textContent = '호스트 꺼짐';
      el.title = 'Linux: systemctl --user status yt-ko / Windows: start.bat';
      el.classList.add('bad');
    }
  });
}
checkHost();

// ---------- 현재 영상의 원문/번역 언어 표시 ----------
const ENGINE_NAMES = { haas: 'Haas-ja', qwen: 'Qwen3-ASR', whisper: 'Whisper', nemotron: 'Nemotron' };
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const trackLabel = (t) => `${langName(t.lang)}${t.kind === 'asr' ? ' (자동 생성)' : ''}`;
const chip = (text, muted) => `<span class="chip${muted ? ' muted' : ''}">${esc(text)}</span>`;
const note = (text, kind) => `<div class="note ${kind}">${esc(text)}</div>`;
const meta = (text) => `<div class="meta">${esc(text)}</div>`;
const bar = (pct, dim) => `<div class="bar${dim ? ' dim' : ''}"><i style="width:${pct}%"></i></div>`;

function render(r) {
  const el = $('now');
  if (!r) return (el.innerHTML = '<div class="empty">유튜브 영상 탭이 아닙니다 (유튜브 탭이면 새로고침하세요)</div>');
  if (!r.enabled) return (el.innerHTML = '<div class="empty">번역 기능이 꺼져 있습니다</div>');
  if (!r.onWatch) return (el.innerHTML = '<div class="empty">재생 중인 영상이 없습니다</div>');
  if (!r.active) return (el.innerHTML = '<div class="empty">번역 꺼짐 — 플레이어 아래쪽 자막(CC) 버튼 옆의 번역 버튼을 누르면 켜집니다</div>');
  if (!r.info) return (el.innerHTML = '<div class="empty">준비 중…</div>');
  const i = r.info;
  const out = [];

  // 원문 -> 번역 칩
  let src, how;
  if (i.mode === 'stt') {
    const eng = ENGINE_NAMES[i.used || i.engine] || '음성 인식';
    if (i.source !== 'auto') { src = langName(i.source); how = `${eng} · 언어 지정`; }
    else if (i.detected) { src = langName(i.detected); how = `${eng} · 자동 감지`; }
    else { src = '감지 중…'; how = eng; }
    if (i.engine === 'haas' && i.used === 'whisper') how += ' (일본어가 아니라 Whisper 사용)';
  } else if (i.mode === 'captions') {
    src = trackLabel(i);
    how = `유튜브 자막 · ${i.source === 'auto' ? '자동 선택' : '언어 지정'}`;
  } else {
    src = '불러오는 중…';
    how = '';
  }
  out.push(`<div class="pair">${chip(src, i.mode !== 'captions' && !i.detected && i.source === 'auto')}<span>→</span>${chip(langName(i.target))}</div>`);
  if (how) out.push(meta(how));

  // 음성 인식 진행률
  if (i.stt) {
    const p = typeof i.stt.prog === 'number' ? Math.round(i.stt.prog * 100) : null;
    out.push(bar(p ?? 3, true));
    out.push(meta(`음성 인식: ${i.stt.msg || '준비 중…'}`));
  }

  // 진행률
  if (i.cues) {
    const pct = Math.round((i.translated / i.cues) * 100);
    out.push(bar(pct));
    out.push(meta(`번역 ${i.translated} / ${i.cues}줄 (재생 위치 기준으로 앞부분부터)`));
  }

  // 알림
  if (i.captionError) out.push(note('자막을 받지 못해 음성 인식으로 대체했습니다', 'warn'));
  if (i.viaPrefer) out.push(meta('유튜브 자동 생성 자막 대신 음성 인식을 사용 중'));
  if (i.sourceMissing) out.push(note(`지정한 ${langName(i.source)} 자막이 없어 자동 선택했습니다`, 'warn'));
  if (i.state === 'same') out.push(note('원문이 이미 번역 언어라 번역하지 않습니다', 'ok'));
  else if (i.state && !['active', 'loading', 'same'].includes(i.state)) out.push(note(i.state, 'bad'));

  // 진단 정보 (문제 생기면 이 줄을 캡처)
  if (i.debug) {
    const d = i.debug;
    out.push(`<div class="meta debug">대기 ${d.wait} · 요청중 ${d.inflight} · 실패 ${d.failed} · 동시 ${d.running} · 요청 ${d.sent}회<br>${esc(d.srcLang || '?')}→${esc(i.target)} · ${d.t}s${d.sttDone ? ' · 받아쓰기 완료' : ''}${d.blocked ? ` · 대기 ${d.blocked}s` : ''}${d.lastErr ? ` · 오류: ${esc(d.lastErr)}` : ''}</div>`);
  }

  // 사용 가능한 자막
  if (i.tracks && i.tracks.length) out.push(meta(`사용 가능한 자막: ${i.tracks.map(trackLabel).join(', ')}`));
  else if (i.mode === 'stt' && !i.captionError) out.push(meta('이 영상에는 자막이 없습니다'));

  const html = out.join('');
  if (el.innerHTML !== html) el.innerHTML = html;
}

// 팝업이 열려 있는 동안 활성 탭은 바뀌지 않으므로 한 번만 찾음
let tabId = null;
function refresh() {
  if (tabId == null) return render(null);
  chrome.tabs.sendMessage(tabId, { type: 'ytko-info' }, (r) => {
    void chrome.runtime.lastError; // 유튜브가 아닌 탭이면 응답 없음
    render(r && r.ok ? r : null);
  });
}
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  tabId = tab ? tab.id : null;
  refresh();
});
setInterval(refresh, 1500);
setInterval(checkHost, 5000);
