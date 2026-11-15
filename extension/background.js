// 서비스 워커: 콘텐츠 스크립트 -> 로컬 호스트(127.0.0.1) 중계.
// 호스트는 Origin이 chrome-extension:// 인 요청만 받으므로 반드시 여기서 fetch 해야 합니다.
const HOST = 'http://127.0.0.1:17891';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'translate') {
    fetch(`${HOST}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.body),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        sendResponse({ ok: true, lines: j.lines });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e), unreachable: e instanceof TypeError }));
    return true;
  }
  if (msg.type === 'health') {
    fetch(`${HOST}/health`)
      .then(async (r) => sendResponse({ ok: r.ok, ...(await r.json().catch(() => ({}))) }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'stt-start') {
    fetch(`${HOST}/stt/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: msg.videoId, from: msg.from }),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        sendResponse({ ok: true, ...j });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e), unreachable: e instanceof TypeError }));
    return true;
  }
  if (msg.type === 'stt-poll') {
    fetch(`${HOST}/stt/poll?videoId=${encodeURIComponent(msg.videoId)}&since=${Number(msg.since) || 0}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        sendResponse({ ok: true, ...j });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e), unreachable: e instanceof TypeError }));
    return true;
  }
});
