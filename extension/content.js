// 콘텐츠 스크립트: 자막 수집(유튜브 자막 또는 STT) -> 선행 번역 스케줄링 -> 오버레이 표시
(() => {
  const BATCH = 30; // 한 번에 번역할 자막 줄 수
  const CTX = 3; // 번역 시 참고용으로 붙이는 직전 줄 수
  const PARALLEL = 3; // 동시 번역 요청 수
  const LOOKAHEAD_SEC = 12 * 60; // 재생 위치보다 이만큼 앞까지만 번역 (구독 한도 절약)
  const MAX_TRIES = 3;

  let settings = { enabled: true, fontSize: 26, showOriginal: false, sttEnabled: true };
  let st = null; // 현재 영상 상태
  let overlay = null;
  let statusEl = null;

  // ---------- 설정 ----------
  chrome.storage.sync.get(settings, (s) => {
    settings = { ...settings, ...s };
    applySettings();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const k in changes) settings[k] = changes[k].newValue;
    applySettings();
    lastShown = null;
    if ('enabled' in changes || 'sttEnabled' in changes) {
      if (settings.enabled) start();
      else stop();
    }
  });
  function applySettings() {
    if (overlay) overlay.style.fontSize = `${settings.fontSize}px`;
  }

  // ---------- MAIN world 브리지 ----------
  function mainCall(type, payload) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      const h = (ev) => {
        const d = ev.data;
        if (ev.source !== window || !d || d.ytko !== 'res' || d.id !== id) return;
        window.removeEventListener('message', h);
        d.error ? reject(new Error(d.error)) : resolve(d.result);
      };
      window.addEventListener('message', h);
      window.postMessage({ ytko: 'req', id, type, payload }, '*');
    });
  }

  const send = (msg) =>
    chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: String(e.message || e), unreachable: true }));

  // ---------- 유틸 ----------
  const videoIdNow = () => new URLSearchParams(location.search).get('v');
  const getVideo = () => document.querySelector('#movie_player video.html5-main-video, video.html5-main-video');
  const getPlayerEl = () => document.getElementById('movie_player');
  const keyOf = (c) => Math.round(c.s * 10);

  function ensureOverlay() {
    const player = getPlayerEl();
    if (!player) return false;
    if (!overlay || !overlay.isConnected) {
      overlay = document.createElement('div');
      overlay.id = 'ytko-overlay';
      player.appendChild(overlay);
    }
    if (!statusEl || !statusEl.isConnected) {
      statusEl = document.createElement('div');
      statusEl.id = 'ytko-status';
      statusEl.classList.add('ytko-hide');
      player.appendChild(statusEl);
    }
    applySettings();
    return true;
  }

  function showStatus(text, err = false) {
    if (!statusEl) return;
    if (!text) {
      statusEl.classList.add('ytko-hide');
      return;
    }
    statusEl.textContent = text;
    statusEl.classList.toggle('ytko-err', err);
    statusEl.classList.remove('ytko-hide');
  }

  // ---------- 자막 목록 관리 ----------
  function normalizeCues(arr) {
    arr.sort((a, b) => a.s - b.s);
    for (let i = 0; i < arr.length - 1; i++) {
      if (arr[i].e > arr[i + 1].s) arr[i].e = Math.max(arr[i].s + 0.3, arr[i + 1].s);
    }
  }

  function addCues(s, incoming) {
    // incoming: [{s,e,o}], 중복(시작 시각이 거의 같은 것)은 무시
    const have = new Set(s.cues.map(keyOf));
    let added = 0;
    for (const c of incoming) {
      const k = Math.round(c.s * 10);
      if (have.has(k) || !c.o) continue;
      have.add(k);
      const cue = { s: c.s, e: c.e, o: c.o, t: null, state: 0, tries: 0 };
      const cached = s.tcache[k];
      if (cached) {
        cue.t = cached;
        cue.state = 2;
      }
      s.cues.push(cue);
      added++;
    }
    if (added) normalizeCues(s.cues);
  }

  function ytEventsToCues(events) {
    const out = [];
    for (const ev of events) {
      if (!ev.segs) continue;
      const text = ev.segs.map((x) => x.utf8 || '').join('').replace(/\s*\n\s*/g, ' ').trim();
      if (!text) continue;
      const sec = ev.tStartMs / 1000;
      out.push({ s: sec, e: sec + (ev.dDurationMs || 2000) / 1000, o: text });
    }
    // 연속으로 같은 문구인 경우 합치기
    out.sort((a, b) => a.s - b.s);
    const merged = [];
    for (const c of out) {
      const prev = merged[merged.length - 1];
      if (prev && prev.o === c.o && c.s <= prev.e + 0.5) prev.e = Math.max(prev.e, c.e);
      else merged.push(c);
    }
    return merged;
  }

  // ---------- 캐시 (영상별 번역 결과) ----------
  const cacheKey = (id) => `tr:${id}`;
  function loadCache(videoId) {
    return new Promise((resolve) => {
      chrome.storage.local.get(cacheKey(videoId), (r) => resolve((r[cacheKey(videoId)] && r[cacheKey(videoId)].m) || {}));
    });
  }
  let saveTimer = null;
  function saveCache(s) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      chrome.storage.local.set({ [cacheKey(s.videoId)]: { m: s.tcache, at: Date.now() } });
    }, 1500);
  }

  // ---------- 시작/정지 ----------
  async function start() {
    stop();
    const videoId = videoIdNow();
    if (!settings.enabled || !videoId || location.pathname !== '/watch') return;
    const s = {
      videoId, cues: [], tcache: {}, running: 0, timers: [], dead: false,
      title: '', channel: '', lastTime: 0, mode: 'captions',
      sttSince: 0, sttDone: false, sttMsg: '', sttPolling: false, lastSeekStart: 0,
      fatal: '', hostErr: '', blockedUntil: 0,
    };
    st = s;
    if (!ensureOverlay()) {
      setTimeout(() => st === s && start(), 800);
      return;
    }
    showStatus('자막 불러오는 중…');
    s.tcache = await loadCache(videoId);
    let cap;
    try {
      cap = await mainCall('getCaptions', { videoId });
    } catch (e) {
      if (st === s) showStatus(`자막 오류: ${e.message}`, true);
      return;
    }
    if (st !== s) return;
    s.title = cap.title;
    s.channel = cap.channel;
    if (cap.skip === 'ko') return showStatus('한국어 자막이 있는 영상입니다');

    if (cap.none) {
      if (!settings.sttEnabled) return showStatus('이 영상에는 자막이 없습니다 (음성 인식이 꺼져 있음)', true);
      s.mode = 'stt';
      const v = getVideo();
      const from = Math.max(0, (v ? v.currentTime : 0) - 5);
      const r = await send({ type: 'stt-start', videoId, from });
      if (st !== s) return;
      if (!r.ok) {
        s.fatal = r.unreachable ? '번역 호스트에 연결할 수 없습니다. host\\start.bat 을 실행하세요' : `음성 인식 오류: ${r.error}`;
        showStatus(s.fatal, true);
        return;
      }
      document.documentElement.classList.add('ytko-active');
      pollStt(s);
    } else {
      addCues(s, ytEventsToCues(cap.events));
      if (!s.cues.length) return showStatus('자막이 비어 있습니다', true);
      document.documentElement.classList.add('ytko-active');
    }

    s.timers.push(setInterval(() => render(s), 120));
    s.timers.push(setInterval(() => pump(s), 1500));
    pump(s);
  }

  function stop() {
    if (st) {
      st.dead = true;
      st.timers.forEach(clearInterval);
      st = null;
    }
    lastShown = null;
    document.documentElement.classList.remove('ytko-active');
    if (overlay) overlay.textContent = '';
    if (statusEl) statusEl.classList.add('ytko-hide');
  }

  // ---------- STT 폴링 ----------
  async function pollStt(s) {
    if (s.sttPolling) return;
    s.sttPolling = true;
    let fails = 0;
    while (!s.dead && st === s && !s.sttDone) {
      const r = await send({ type: 'stt-poll', videoId: s.videoId, since: s.sttSince });
      if (s.dead || st !== s) break;
      if (!r.ok) {
        fails++;
        s.sttMsg = r.unreachable ? '호스트 연결 끊김, 재시도 중…' : r.error;
        if (fails > 20) {
          s.fatal = `음성 인식 오류: ${r.error}`;
          break;
        }
      } else {
        fails = 0;
        if (r.cues && r.cues.length) {
          addCues(s, r.cues);
          s.sttSince += r.cues.length;
        }
        s.sttMsg = r.msg || '';
        if (r.state === 'error') {
          s.fatal = `음성 인식 오류: ${r.msg}`;
          break;
        }
        if (r.state === 'done' && s.sttSince >= r.total) s.sttDone = true;
      }
      await new Promise((res) => setTimeout(res, 1500));
    }
    s.sttPolling = false;
  }

  // ---------- 번역 스케줄러 ----------
  function firstIndexAtOrAfter(cues, t) {
    let lo = 0;
    let hi = cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].s < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function pump(s) {
    if (s.dead || s !== st) return;
    refreshStatus(s);
    if (Date.now() < s.blockedUntil) return;
    const v = getVideo();
    const now = v ? v.currentTime : 0;
    const horizon = now + LOOKAHEAD_SEC;
    const start = firstIndexAtOrAfter(s.cues, now - 8);
    while (s.running < PARALLEL) {
      const batch = [];
      for (let j = start; j < s.cues.length && s.cues[j].s < horizon && batch.length < BATCH; j++) {
        if (s.cues[j].state === 0) batch.push(s.cues[j]);
      }
      if (!batch.length) break;
      // STT가 아직 진행 중이면, 먼 구간은 줄이 충분히 모일 때까지 기다림 (소량 호출 낭비 방지)
      if (s.mode === 'stt' && !s.sttDone && batch.length < 15 && batch[0].s - now > 20) break;
      runBatch(s, batch);
    }
  }

  function refreshStatus(s) {
    if (s.fatal) return showStatus(s.fatal, true);
    if (s.hostErr) return showStatus(s.hostErr, true);
    const parts = [];
    if (s.mode === 'stt' && !s.sttDone && s.sttMsg) parts.push(`음성 인식: ${s.sttMsg}`);
    const v = getVideo();
    const i = findCue(s.cues, v ? v.currentTime : 0);
    if (s.running > 0 && (i < 0 || s.cues[i].state !== 2)) parts.push('번역 중…');
    if (s.mode === 'stt' && !s.cues.length && !parts.length) parts.push('음성 인식 준비 중…');
    showStatus(parts.join(' · '));
  }

  async function runBatch(s, batch) {
    batch.forEach((c) => (c.state = 1));
    s.running++;
    const lines = batch.map((c, i) => ({ i, t: c.o }));
    const idx = s.cues.indexOf(batch[0]);
    const context = s.cues.slice(Math.max(0, idx - CTX), idx).map((c) => c.o).join('\n');
    const res = await send({ type: 'translate', body: { title: s.title, channel: s.channel, lines, context } });
    s.running--;
    if (s.dead || s !== st) return;
    if (res && res.ok) {
      s.hostErr = '';
      const got = new Set();
      for (const l of res.lines) {
        const c = batch[l.i];
        if (c && l.t) {
          c.t = l.t;
          c.state = 2;
          s.tcache[keyOf(c)] = l.t;
          got.add(l.i);
        }
      }
      batch.forEach((c, i) => {
        if (!got.has(i)) failCue(c);
      });
      saveCache(s);
      pump(s);
    } else {
      batch.forEach(failCue);
      if (res && res.unreachable) {
        s.blockedUntil = Date.now() + 8000;
        s.hostErr = '번역 호스트에 연결할 수 없습니다. host\\start.bat 을 실행하세요';
      } else {
        s.blockedUntil = Date.now() + 3000;
        s.hostErr = `번역 오류: ${res && res.error}`;
      }
    }
  }
  function failCue(c) {
    c.tries++;
    c.state = c.tries >= MAX_TRIES ? 3 : 0; // 3 = 포기(원문 표시)
  }

  // ---------- 렌더링 ----------
  function findCue(cues, t) {
    let lo = 0;
    let hi = cues.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].s <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found >= 0 && t < cues[found].e) return found;
    return -1;
  }

  let lastShown = null;
  function render(s) {
    if (s.dead || s !== st) return;
    if (!ensureOverlay()) return;
    const v = getVideo();
    if (!v) return;
    const t = v.currentTime;

    // 큰 폭의 시간 이동 감지
    if (Math.abs(t - s.lastTime) > 5) {
      pump(s);
      // STT: 이동한 위치 근처에 아직 받아쓰기 결과가 없으면 그 위치부터 우선 처리 요청
      if (s.mode === 'stt' && !s.sttDone && Date.now() - s.lastSeekStart > 8000) {
        const k = firstIndexAtOrAfter(s.cues, t - 3);
        const near = s.cues[k] && s.cues[k].s < t + 40;
        if (!near) {
          s.lastSeekStart = Date.now();
          send({ type: 'stt-start', videoId: s.videoId, from: Math.max(0, t - 5) });
          if (!s.sttPolling) pollStt(s);
        }
      }
    }
    s.lastTime = t;

    const i = findCue(s.cues, t);
    const c = i >= 0 ? s.cues[i] : null;
    const key = c ? `${i}:${c.state}:${settings.showOriginal ? 1 : 0}:${c.t || ''}` : '';
    if (key === lastShown) return;
    lastShown = key;
    overlay.textContent = '';
    if (!c) return;
    const main = document.createElement('div');
    main.className = 'ytko-line' + (c.t ? '' : ' ytko-pending');
    main.textContent = c.t || c.o; // 번역 전/실패 시 원문
    overlay.appendChild(main);
    if (settings.showOriginal && c.t) {
      const o = document.createElement('div');
      o.className = 'ytko-line ytko-orig';
      o.textContent = c.o;
      overlay.appendChild(o);
    }
  }

  // ---------- 영상 전환 감지 (유튜브는 SPA) ----------
  let lastId = null;
  function check() {
    const id = location.pathname === '/watch' ? videoIdNow() : null;
    if (id !== lastId) {
      lastId = id;
      if (id && settings.enabled) start();
      else stop();
    }
  }
  document.addEventListener('yt-navigate-finish', check);
  setInterval(check, 1000);
  check();
})();
