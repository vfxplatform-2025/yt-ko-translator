// 페이지(MAIN world)에서 실행: 유튜브 플레이어의 자막 데이터를 꺼내 콘텐츠 스크립트에 전달합니다.
(() => {
  if (window.__ytko) return;
  window.__ytko = true;

  const captured = {}; // `${videoId}|${lang}|${kind}` -> events

  const capKey = (v, lang, kind) => `${v}|${lang || ''}|${kind || ''}`;
  const baseLang = (l) => String(l || '').toLowerCase().split('-')[0];

  function parseJson3(text) {
    try {
      const j = JSON.parse(text);
      return Array.isArray(j.events) ? j.events : null;
    } catch (_) {
      return null;
    }
  }

  function onTimedText(url, text) {
    try {
      const u = new URL(url, location.href);
      if (!u.pathname.includes('/api/timedtext')) return;
      if (u.searchParams.get('tlang')) return; // 유튜브 자동 번역본은 제외
      const events = parseJson3(text);
      if (!events || !events.length) return;
      const v = u.searchParams.get('v');
      captured[capKey(v, u.searchParams.get('lang'), u.searchParams.get('kind'))] = events;
    } catch (_) {}
  }

  // 플레이어가 직접 가져오는 자막 응답을 가로채기 (PO 토큰이 붙은 정상 요청이라 가장 안정적)
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0] && args[0].url;
      if (url && url.includes('/api/timedtext')) {
        p.then((r) => r.clone().text().then((t) => onTimedText(url, t))).catch(() => {});
      }
    } catch (_) {}
    return p;
  };
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ytkoUrl = String(url);
    this.addEventListener('load', () => {
      try {
        if (this.__ytkoUrl.includes('/api/timedtext')) onTimedText(this.__ytkoUrl, this.responseText);
      } catch (_) {}
    });
    return origOpen.call(this, method, url, ...rest);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function getPlayer() {
    return document.getElementById('movie_player');
  }

  function getPlayerResponse(videoId) {
    const p = getPlayer();
    let pr = p && p.getPlayerResponse && p.getPlayerResponse();
    if (!pr || !pr.videoDetails || pr.videoDetails.videoId !== videoId) pr = window.ytInitialPlayerResponse;
    if (!pr || !pr.videoDetails || pr.videoDetails.videoId !== videoId) return null;
    return pr;
  }

  // source: 'auto' 또는 언어 코드, target: 번역할 언어 코드
  function pickTrack(tracks, source, target) {
    const manual = tracks.filter((t) => t.kind !== 'asr');
    const asr = tracks.filter((t) => t.kind === 'asr');
    if (source && source !== 'auto') {
      const want = baseLang(source);
      const hit = manual.find((t) => baseLang(t.languageCode) === want) || asr.find((t) => baseLang(t.languageCode) === want);
      if (hit) return { track: hit, sourceMissing: false };
    }
    const tb = baseLang(target);
    const track = manual.find((t) => baseLang(t.languageCode) !== tb) || asr[0] || manual[0] || tracks[0];
    return { track, sourceMissing: !!(source && source !== 'auto') };
  }

  // 가로챈 자막 찾기: 정확히 같은 트랙 -> 같은 언어의 다른 종류(수동/자동) 순
  function findCaptured(videoId, track) {
    const exact = captured[capKey(videoId, track.languageCode, track.kind)];
    if (exact) return exact;
    const want = baseLang(track.languageCode);
    for (const k in captured) {
      const [v, lang] = k.split('|');
      if (v === videoId && baseLang(lang) === want) return captured[k];
    }
    return null;
  }

  async function getCaptions(videoId, source = 'auto', target = 'ko') {
    // 플레이어 응답이 준비될 때까지 잠시 대기
    let pr = null;
    for (let i = 0; i < 30 && !pr; i++) {
      pr = getPlayerResponse(videoId);
      if (!pr) await sleep(300);
    }
    if (!pr) throw new Error('플레이어 정보를 가져오지 못했습니다');
    const title = pr.videoDetails.title || '';
    const channel = pr.videoDetails.author || '';
    const tracks =
      (pr.captions &&
        pr.captions.playerCaptionsTracklistRenderer &&
        pr.captions.playerCaptionsTracklistRenderer.captionTracks) ||
      [];
    const list = tracks.map((t) => ({ lang: t.languageCode, kind: t.kind || '' }));
    if (!tracks.length) return { title, channel, none: true, tracks: list };

    const { track, sourceMissing } = pickTrack(tracks, source, target);
    const base = { title, channel, lang: track.languageCode, kind: track.kind || '', tracks: list, sourceMissing };
    if (baseLang(track.languageCode) === baseLang(target)) return { ...base, skip: 'same' };

    // 1) 이미 가로챈 자막이 있으면 사용
    let got = findCaptured(videoId, track);
    if (got) return { ...base, events: got };

    // 2) 직접 요청
    try {
      const url = track.baseUrl + (track.baseUrl.includes('fmt=') ? '' : '&fmt=json3');
      const r = await fetch(url, { credentials: 'include' });
      const events = parseJson3(await r.text());
      if (events && events.length) return { ...base, events };
    } catch (_) {}

    // 3) 플레이어의 자막(CC)을 켜서 플레이어가 직접 요청하게 만든 뒤 가로채기
    const player = getPlayer();
    if (player) {
      try {
        if (player.loadModule) player.loadModule('captions');
        if (player.setOption) {
          const opt = { languageCode: track.languageCode };
          if (track.kind) opt.kind = track.kind;
          player.setOption('captions', 'track', opt);
        }
        if (player.toggleSubtitlesOn) player.toggleSubtitlesOn();
      } catch (_) {}
      for (let i = 0; i < 30; i++) {
        if ((got = findCaptured(videoId, track))) return { ...base, events: got };
        await sleep(300);
      }
    }
    throw new Error('자막 데이터를 가져오지 못했습니다');
  }

  window.addEventListener('message', async (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.ytko !== 'req') return;
    try {
      let result;
      if (d.type === 'getCaptions') result = await getCaptions(d.payload.videoId, d.payload.source, d.payload.target);
      else throw new Error('unknown type');
      window.postMessage({ ytko: 'res', id: d.id, result }, '*');
    } catch (e) {
      window.postMessage({ ytko: 'res', id: d.id, error: String(e.message || e) }, '*');
    }
  });
})();
