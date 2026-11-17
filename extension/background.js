// 서비스 워커: 콘텐츠 스크립트 -> 로컬 호스트(127.0.0.1) 중계.
// 호스트는 X-YTKO 헤더가 있는 확장 프로그램 요청만 받으므로 반드시 여기서 fetch 해야 합니다.
const HOST = 'http://127.0.0.1:17891';
const TRANSLATE_TIMEOUT_MS = 300000; // 호스트 최악의 경우(대기 + codex 2회 시도)보다 길게

// 호스트 호출: body 가 있으면 POST(JSON), 없으면 GET.
// 결과: { ok: true, ...응답 } 또는 { ok: false, error, status, unreachable }
async function call(path, body, timeoutMs = 30000) {
  try {
    const r = await fetch(`${HOST}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'X-YTKO': '1', 'Content-Type': 'application/json' } : { 'X-YTKO': '1' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, error: j.error || `HTTP ${r.status}` };
    return { ok: true, ...j };
  } catch (e) {
    const timedOut = e.name === 'TimeoutError';
    return { ok: false, error: timedOut ? '응답 시간 초과' : String(e.message || e), unreachable: !timedOut };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  let p;
  if (msg.type === 'translate') p = call('/translate', msg.body, TRANSLATE_TIMEOUT_MS);
  else if (msg.type === 'health') p = call('/health', null, 5000);
  else if (msg.type === 'session') p = call('/session', { action: msg.action, id: msg.id, translator: msg.translator || 'codex' }, 20000);
  else if (msg.type === 'stt-start') p = call('/stt/start', { videoId: msg.videoId, from: msg.from, lang: msg.lang || '', engine: msg.engine || 'whisper' });
  else if (msg.type === 'stt-poll') {
    const q = new URLSearchParams({ videoId: msg.videoId, lang: msg.lang || '', engine: msg.engine || 'whisper', since: String(Number(msg.since) || 0) });
    p = call(`/stt/poll?${q}`);
  } else return;
  p.then(sendResponse);
  return true;
});
