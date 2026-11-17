// 콘텐츠 스크립트: 자막 수집(유튜브 자막 또는 STT) -> 선행 번역 스케줄링 -> 오버레이 표시
(() => {
  const BATCH = 30; // 한 번에 번역할 자막 줄 수 (먼 구간)
  const NEAR_BATCH = 10; // 재생 위치 가까운 구간은 작게 나눠 동시에 보냄 (codex 1회: 10줄 약 6초, 30줄 약 15초)
  const NEAR_SEC = 90;
  const FIRST_BATCH = 3; // 재생 위치 바로 앞은 몇 줄만 먼저 보내 첫 자막을 빨리 띄움 (1~3줄 약 2.5초)
  const FIRST_SEC = 12;
  const URGENT_SEC = 30; // 이 안쪽 번역은 동시 요청 한도가 차 있어도 한 칸 더 써서 바로 보냄 (시간 이동 직후 등)
  const CTX = 3; // 번역 시 참고용으로 붙이는 직전 줄 수
  const PARALLEL = 3; // 동시 번역 요청 수
  const LOOKAHEAD_SEC = 12 * 60; // 재생 위치보다 이만큼 앞까지만 번역 (구독 한도 절약)
  const MAX_TRIES = 3;

  let settings = { ...YTKO_DEFAULTS }; // 기본값은 defaults.js
  // [音楽] / [Music] / ♪ 처럼 소리 설명만 있는 줄 (번역하지 않고 ♪ 로 표시)
  const TAG_ONLY = /^[\s\[\(（【〔<>-]*(音楽|音樂|拍手|笑い?|歓声|music|applause|laughter|laughs|cheering|음악|박수|웃음|♪|♫|♬|～|〜|~|\s)+[\]\)）】〕>\s.。♪♫♬～〜~-]*$/i;
  const baseLang = (l) => String(l || '').toLowerCase().split('-')[0];
  let langNames = null;
  const langName = (code) => {
    try {
      langNames = langNames || new Intl.DisplayNames(['ko'], { type: 'language' });
      return langNames.of(code) || code;
    } catch (_) {
      return code;
    }
  };
  let st = null; // 현재 영상 상태
  // 플레이어 번역 버튼 상태. 페이지를 열거나 새로고침하면 항상 꺼짐에서 시작
  let active = false;
  const sessionId = Math.random().toString(36).slice(2, 12); // 호스트의 상주 codex 사용 신호용
  let pingTimer = null;
  let overlay = null;
  let statusEl = null;

  // ---------- 설정 ----------
  chrome.storage.sync.get(settings, (s) => {
    settings = { ...settings, ...s };
    applySettings();
  });
  // 이 설정이 바뀌면 번역을 새로 시작. 그중 KEEP_SHOWN_KEYS 만 바뀐 경우는 기존 번역을 임시로 계속 표시
  const RESTART_KEYS = ['sttEnabled', 'preferStt', 'sttEngine', 'translator', 'style', 'sourceLang', 'targetLang'];
  const KEEP_SHOWN_KEYS = ['translator', 'style'];
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const k in changes) settings[k] = changes[k].newValue;
    applySettings();
    lastShown = null;
    if ('enabled' in changes && !settings.enabled) setActive(false);
    else if (active && RESTART_KEYS.some((k) => k in changes)) {
      // 번역 엔진을 바꾸면 호스트에 알림 (codex 면 미리 띄우고, Claude 면 상주 codex 를 내림)
      if ('translator' in changes) send({ type: 'session', action: 'start', id: sessionId, translator: settings.translator });
      // 말투·번역 엔진만 바뀌었으면 원문이 같으므로, 새 번역이 올 때까지 지금 번역을 그대로 보여줌
      const keep = RESTART_KEYS.every((k) => !(k in changes) || KEEP_SHOWN_KEYS.includes(k));
      start(keep ? currentTranslations() : null);
    }
    ensureButton();
  });
  function applySettings() {
    if (!overlay) return;
    overlay.style.fontSize = `${settings.fontSize}px`;
    overlay.style.setProperty('--ytko-bottom', `${settings.subPos}%`); // 화면 아래에서 띄우는 거리
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

  // 확장 프로그램을 다시 로드/삭제하면 이미 열려 있던 탭의 이 스크립트는 연결이 끊김(Extension context invalidated).
  // 그때는 chrome.* 호출이 예외를 던지므로, 감지해서 조용히 정리하고 멈춘다.
  const alive = () => {
    try { return !!chrome.runtime?.id; } catch (_) { return false; }
  };
  let retired = false;
  function retire() {
    if (retired) return;
    retired = true;
    stop();
    clearInterval(checkTimer);
    document.removeEventListener('yt-navigate-finish', check);
    clearInterval(pingTimer);
    overlay?.remove();
    statusEl?.remove();
    document.getElementById('ytko-btn')?.remove();
  }

  const HOST_DOWN = '번역 호스트에 연결할 수 없습니다 (Linux: systemctl --user status yt-ko / Windows: start.bat)';
  // 연결이 끊겼으면 정리(retire -> stop 으로 s.dead)하고 실패를 돌려줌. 호출자는 기존 s.dead 검사로 멈춘다.
  const send = async (msg) => {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (!alive()) {
        retire();
        return { ok: false, dead: true };
      }
      return { ok: false, error: String(e.message || e), unreachable: true };
    }
  };

  // ---------- 유틸 ----------
  // 일반 영상(/watch?v=ID)과 숏츠(/shorts/ID). 숏츠는 플레이어가 #shorts-player 로 따로 있음
  const isShorts = () => location.pathname.startsWith('/shorts/');
  const videoIdNow = () => {
    if (location.pathname === '/watch') return new URLSearchParams(location.search).get('v');
    if (isShorts()) return location.pathname.split('/')[2] || null;
    return null;
  };
  const getPlayerEl = () => document.getElementById(isShorts() ? 'shorts-player' : 'movie_player');
  const getVideo = () => {
    const p = getPlayerEl();
    return p?.querySelector('video.html5-main-video') || p?.querySelector('video') || (isShorts() ? null : document.querySelector('video.html5-main-video'));
  };
  const curTime = () => getVideo()?.currentTime ?? 0;
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

  // prog: 0~1 이면 진행 막대, 'busy' 면 움직이는 막대, 없으면 막대 숨김
  function showStatus(text, err = false, prog = null) {
    if (!statusEl) return;
    if (!text) {
      statusEl.classList.add('ytko-hide');
      return;
    }
    if (!statusEl.firstChild) {
      const bar = document.createElement('div');
      bar.className = 'ytko-st-bar';
      bar.appendChild(document.createElement('i'));
      statusEl.append(document.createElement('div'), bar);
    }
    const [t, bar] = statusEl.children;
    t.textContent = text;
    bar.style.display = prog == null || err ? 'none' : '';
    bar.classList.toggle('ytko-busy', prog === 'busy');
    if (typeof prog === 'number') bar.firstChild.style.width = `${Math.round(Math.max(0.02, Math.min(1, prog)) * 100)}%`;
    statusEl.classList.toggle('ytko-err', err);
    statusEl.classList.remove('ytko-hide');
  }

  // 버튼을 누른 직후 잠깐 보여주는 안내 (번역 진행 상태가 곧 덮어씀)
  let flashTimer = null;
  function flashStatus(text) {
    if (!ensureOverlay()) return;
    showStatus(text);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => !active && showStatus(''), 1500);
  }

  const fmtSec = (sec) => {
    sec = Math.max(0, Math.round(sec));
    return sec >= 60 ? `${Math.floor(sec / 60)}분${sec % 60 ? ` ${sec % 60}초` : ''}` : `${sec}초`;
  };

  // ---------- 자막 목록 관리 ----------
  function normalizeCues(arr) {
    arr.sort((a, b) => a.s - b.s);
    for (let i = 0; i < arr.length - 1; i++) {
      if (arr[i].e > arr[i + 1].s) arr[i].e = Math.max(arr[i].s + 0.3, arr[i + 1].s);
    }
  }

  // 글자로 확실히 알 수 있는 언어 (글자의 절반 이상이 그 문자). 라틴 문자 언어끼리는 구분 못 하므로 ''
  const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const HANGUL = /\p{Script=Hangul}/u;
  const SCRIPTS = [['ko', /\p{Script=Hangul}/gu], ['ru', /\p{Script=Cyrillic}/gu], ['th', /\p{Script=Thai}/gu],
    ['ar', /\p{Script=Arabic}/gu], ['hi', /\p{Script=Devanagari}/gu]];
  function scriptLang(text) {
    text = String(text || '');
    const letters = (text.match(/\p{L}/gu) || []).length;
    if (!letters) return '';
    // 일본어는 한자가 대부분이어도 가나가 조금이라도 섞이면 일본어로 봄
    if (KANA.test(text) && !HANGUL.test(text)) return 'ja';
    for (const [lang, re] of SCRIPTS) if ((text.match(re) || []).length * 2 >= letters) return lang;
    return '';
  }
  // 줄 하나의 언어: 글자로 판단 -> 음성 인식이 준 줄별 언어(l) -> 영상 전체 원문 언어
  const lineLang = (s, c) => scriptLang(c.o) || c.l || s.srcLang;
  // 원문이 이미 번역 언어인 줄은 번역 없이 그대로 표시 (단, 번역 말투를 골랐으면 같은 언어라도 말투를 바꿔 다시 씀).
  // 줄마다 판단하므로 한국어 내레이션 + 일본어 대화처럼 섞인 영상에서도 한국어 줄만 그대로 둠
  const passLine = (s, c) => {
    const lang = !s.restyle && lineLang(s, c);
    return !!lang && baseLang(lang) === baseLang(s.target);
  };
  const setDone = (c, text) => {
    c.t = text;
    c.state = 2;
  };

  function addCues(s, incoming) {
    // incoming: [{s,e,o,l?}] (l: 음성 인식이 준 그 줄의 언어), 중복(시작 시각이 거의 같은 것)은 무시
    let added = 0;
    for (const c of incoming) {
      const k = keyOf(c);
      if (s.keys.has(k) || !c.o) continue;
      s.keys.add(k);
      const cue = { s: c.s, e: c.e, o: c.o, l: c.l || '', t: null, state: 0, tries: 0 };
      if (TAG_ONLY.test(c.o)) {
        setDone(cue, '♪');
        cue.tag = true;
      } else if (passLine(s, cue)) setDone(cue, c.o);
      else if (s.tcache[k]) setDone(cue, s.tcache[k]);
      else if (s.carry?.has(k)) cue.old = s.carry.get(k); // 새 번역이 올 때까지 보여줄 이전 번역
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
  // 번역 캐시는 영상 + 원문(자막 트랙 또는 음성 인식) + 번역 언어 + 번역 엔진 + 말투별로 따로 저장
  const cacheKey = (s) => `tr:${s.videoId}:${s.srcKey}:${s.target}:${s.translator}${s.style === 'natural' ? '' : ':' + s.style}`; // 기본 말투는 이전 캐시 그대로
  function loadCache(s) {
    return new Promise((resolve) => {
      const k = cacheKey(s);
      chrome.storage.local.get(k, (r) => resolve((r[k] && r[k].m) || {}));
    });
  }
  // 저장은 몰아서 (번역이 잦을 때 전체 맵을 매번 쓰지 않도록), 영상 전환/정지 시 즉시 저장
  let saveTimer = null;
  let savePending = null;
  function saveCache(s) {
    savePending = s;
    if (!saveTimer) saveTimer = setTimeout(flushCache, 5000);
  }
  function flushCache() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const s = savePending;
    savePending = null;
    if (s && alive()) chrome.storage.local.set({ [cacheKey(s)]: { m: s.tcache, at: Date.now() } });
  }

  // ---------- 시작/정지 ----------
  // 원문을 정하고 그 원문의 번역 캐시를 불러옴. 그 사이 영상이 바뀌었으면 false
  async function useSource(s, srcKey, srcLang) {
    s.srcKey = srcKey;
    s.srcLang = srcLang;
    s.tcache = await loadCache(s);
    return st === s;
  }
  const requestStt = (s, at) => send({ type: 'stt-start', videoId: s.videoId, from: Math.max(0, at - 5), lang: s.sttLang, engine: s.sttEngine });

  // 지금 영상의 번역 결과 (자막 시각 키 -> 번역문). 말투·엔진을 바꿀 때 새 번역이 올 때까지 임시로 표시
  function currentTranslations() {
    if (!st || st.videoId !== videoIdNow()) return null;
    return new Map(st.cues.filter((c) => c.t && !c.tag).map((c) => [keyOf(c), c.t]));
  }

  // carry: 새 번역이 올 때까지 대신 보여줄 이전 번역 (currentTranslations 결과, 없으면 null)
  async function start(carry = null) {
    stop();
    const videoId = videoIdNow();
    if (!active || !settings.enabled || !videoId) return;
    const source = settings.sourceLang || 'auto';
    const target = settings.targetLang || 'ko';
    const style = settings.style || 'natural';
    const s = {
      videoId, source, target, translator: settings.translator || 'codex', style, restyle: style !== 'natural', carry,
      cues: [], keys: new Set(), tcache: {}, running: 0, timers: [], dead: false,
      title: '', channel: '', lastTime: 0, mode: 'captions', srcKey: '', srcLang: '', asr: false, // asr: 원문이 받아쓰기(자동 생성 자막·음성 인식)
      sttLang: '', sttEngine: settings.sttEngine || 'whisper', sttSince: 0, sttDone: false, sttMsg: '', sttState: '', sttProg: null, sttPolling: false, lastSeekStart: 0,
      fatal: '', hostErr: '', blockedUntil: 0,
      stats: { sent: 0, lastErr: '' },
      // 팝업에 보여줄 정보
      info: { videoId, source, target, state: 'loading' },
    };
    st = s;
    if (!ensureOverlay()) {
      setTimeout(() => st === s && start(carry), 800);
      return;
    }
    showStatus('자막 불러오는 중…', false, 'busy');
    let cap;
    try {
      cap = await mainCall('getCaptions', { videoId, source, target, restyle: s.restyle });
    } catch (e) {
      if (st !== s) return;
      // 자막 트랙은 있는데 데이터를 못 받은 경우(유튜브 차단 등) -> 음성 인식으로 대체
      if (settings.sttEnabled) {
        cap = { none: true, captionError: e.message };
      } else {
        s.info.state = `자막 오류: ${e.message}`;
        return showStatus(s.info.state, true);
      }
    }
    if (st !== s) return;
    s.title = cap.title;
    s.channel = cap.channel;
    s.info.tracks = cap.tracks || [];
    s.info.sourceMissing = !!cap.sourceMissing;
    // 유튜브 자동 생성 자막뿐이면, 설정에 따라 음성 인식(Whisper)을 대신 사용
    if (!cap.none && !cap.skip && cap.kind === 'asr' && settings.preferStt && settings.sttEnabled) {
      cap = { ...cap, none: true, viaPrefer: true };
    }
    // 제목은 번역 언어인데 자막은 다른 언어의 자동 생성 자막뿐이면 번역 언어 내레이션이 섞인 영상일 가능성이 큼
    // (예: 한국 채널이 일본 영상에 한국어 설명을 붙인 숏츠). 자동 자막은 한 언어로만 받아써서 섞인 부분이 깨지므로,
    // 원문 언어가 자동 감지면 말소리 덩어리마다 언어를 감지하는 음성 인식을 대신 사용
    if (!cap.none && !cap.skip && settings.sttEnabled && source === 'auto' && cap.kind === 'asr' &&
        (cap.tracks || []).every((t) => t.kind === 'asr') && baseLang(cap.lang) !== baseLang(target) &&
        scriptLang(cap.title) === baseLang(target)) {
      cap = { ...cap, none: true, viaMixed: true };
    }
    const capInfo = (state) => Object.assign(s.info, { mode: 'captions', lang: cap.lang, kind: cap.kind, state });
    if (cap.skip === 'same') {
      capInfo('same');
      return showStatus(`원문 자막이 이미 ${langName(target)}입니다 (팝업에서 번역 말투를 고르면 그 말투로 바꿔 줍니다)`);
    }

    if (cap.none) {
      s.info.mode = 'stt';
      s.info.captionError = cap.captionError || '';
      s.info.viaPrefer = !!cap.viaPrefer;
      s.info.viaMixed = !!cap.viaMixed;
      if (!settings.sttEnabled) {
        s.info.state = '자막 없음 (음성 인식 꺼짐)';
        return showStatus('이 영상에는 자막이 없습니다 (음성 인식이 꺼져 있음)', true);
      }
      s.mode = 'stt';
      s.asr = true;
      s.sttLang = source !== 'auto' ? baseLang(source) : ''; // '' = Whisper 자동 감지
      s.info.engine = s.sttEngine;
      if (!(await useSource(s, `stt-${s.sttEngine}-${s.sttLang || 'auto'}`, s.sttLang))) return;
      const r = await requestStt(s, curTime());
      if (st !== s) return;
      // 고른 엔진이 이 PC에 설치되지 않았으면 호스트가 Whisper 로 대신함 (설정은 PC 사이에 동기화되므로)
      if (r.ok && r.engine && r.engine !== s.sttEngine) s.sttEngine = s.info.engine = r.engine;
      if (!r.ok) {
        s.fatal = r.unreachable ? HOST_DOWN : `음성 인식 오류: ${r.error}`;
        showStatus(s.fatal, true);
        return;
      }
      s.info.state = 'active';
      document.documentElement.classList.add('ytko-active');
      pollStt(s);
    } else {
      capInfo('active');
      s.asr = cap.kind === 'asr';
      if (!(await useSource(s, `${cap.lang}${cap.kind ? '.' + cap.kind : ''}`, cap.lang))) return;
      addCues(s, ytEventsToCues(cap.events));
      if (!s.cues.length) return showStatus('자막이 비어 있습니다', true);
      document.documentElement.classList.add('ytko-active');
    }

    s.timers.push(setInterval(() => render(s), 120));
    s.timers.push(setInterval(() => pump(s), 1500));
    pump(s);
  }

  function stop() {
    flushCache();
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
      const r = await send({ type: 'stt-poll', videoId: s.videoId, lang: s.sttLang, engine: s.sttEngine, since: s.sttSince });
      if (s.dead || st !== s) break;
      if (r.status === 404) {
        // 호스트가 재시작돼 작업이 사라진 경우: 지금 위치부터 다시 요청
        s.sttMsg = '호스트 재시작됨, 음성 인식 다시 요청 중…';
        s.sttSince = 0; // 새 작업은 0번부터 다시 셈 (이미 받은 줄은 addCues에서 중복 제거)
        await requestStt(s, curTime());
      } else if (!r.ok) {
        fails++;
        s.sttMsg = r.unreachable ? '호스트 연결 끊김, 재시도 중…' : r.error;
        if (fails > 20) {
          s.fatal = `음성 인식 오류: ${r.error}`;
          break;
        }
      } else {
        fails = 0;
        s.sttMsg = r.msg || '';
        s.sttState = r.state;
        s.sttProg = typeof r.prog === 'number' ? r.prog : null;
        if (r.used) s.info.used = r.used;
        if (r.lang) {
          s.info.detected = r.lang;
          if (!s.srcLang) {
            s.srcLang = r.lang;
            // 감지 전에 들어온 줄도 원문 그대로 표시할 대상이면 정리
            for (const c of s.cues) if (c.state === 0 && passLine(s, c)) setDone(c, c.o);
          }
        }
        if (r.cues && r.cues.length) {
          addCues(s, r.cues);
          s.sttSince += r.cues.length;
          pump(s);
        }
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
  // 정렬된 cues 에서 c.s >= t 인 첫 위치
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
  // c.s <= t 인 마지막 위치 (없으면 -1)
  const lastStartedAt = (cues, t) => firstIndexAtOrAfter(cues, t + 1e-6) - 1;

  function pump(s) {
    if (s.dead || s !== st) return;
    const now = curTime();
    refreshStatus(s, now);
    if (Date.now() < s.blockedUntil) return;
    const horizon = now + LOOKAHEAD_SEC;
    const start = firstIndexAtOrAfter(s.cues, now - 8);
    for (;;) {
      const batch = [];
      let limit = BATCH;
      for (let j = start; j < s.cues.length && s.cues[j].s < horizon && batch.length < limit; j++) {
        if (s.cues[j].state !== 0) continue;
        if (!batch.length) {
          const gap = s.cues[j].s - now;
          limit = gap < FIRST_SEC ? FIRST_BATCH : gap < NEAR_SEC ? NEAR_BATCH : BATCH;
        }
        batch.push(s.cues[j]);
      }
      if (!batch.length) break;
      // 재생 위치 가까운 묶음은 먼 구간 번역이 칸을 다 차지하고 있어도 한 칸 더 써서 바로 보냄
      const urgent = batch[0].s - now < URGENT_SEC;
      if (s.running >= PARALLEL + (urgent ? 1 : 0)) break;
      // STT가 아직 진행 중이면 소량 호출을 줄임: 먼 구간은 줄이 모일 때까지, 가까운 구간도 몇 줄짜리는 한 번에 하나만
      if (s.mode === 'stt' && !s.sttDone) {
        const far = batch[0].s - now > 20;
        if ((far && batch.length < Math.min(limit, 15)) || (!far && batch.length < Math.min(limit, 4) && s.running > 0)) break;
      }
      runBatch(s, batch, urgent);
    }
  }

  function refreshStatus(s, now) {
    if (s.fatal) return showStatus(s.fatal, true);
    if (s.hostErr) return showStatus(s.hostErr, true);

    // 1) 음성 인식 단계 (받아쓰기가 지금 위치까지 아직 안 왔을 때)
    if (s.mode === 'stt' && !s.sttDone) {
      const last = s.cues[s.cues.length - 1];
      const reached = !!last && last.s >= now - 2;
      if (s.sttState === 'downloading') return showStatus(`① ${s.sttMsg || '오디오 받는 중…'}`, false, s.sttProg ?? 'busy');
      if (s.sttState === 'loading' || s.sttState === 'queued' || !s.sttState) return showStatus(`② ${s.sttMsg || '음성 인식 준비 중…'}`, false, 'busy');
      if (!reached) return showStatus(`③ ${s.sttMsg || '받아쓰기 중…'} · 지금 위치 받아쓰는 중`, false, s.sttProg ?? 'busy');
    }

    // 2) 번역 단계: 지금 위치부터 앞쪽(LOOKAHEAD) 번역 진행률
    let total = 0, done = 0, ahead = null;
    for (let j = firstIndexAtOrAfter(s.cues, now - 8); j < s.cues.length && s.cues[j].s < now + LOOKAHEAD_SEC; j++) {
      total++;
      if (s.cues[j].state >= 2) done++;
      else if (ahead == null) ahead = s.cues[j].s - now; // 여기까지는 끊김 없이 준비됨
    }
    const sttNote = s.mode === 'stt' && !s.sttDone && s.sttMsg ? ` · ${s.sttMsg}` : '';
    if (total && done < total) {
      const i = findCue(s.cues, now);
      const curWaiting = i >= 0 && s.cues[i].state < 2;
      const where = curWaiting || (ahead != null && ahead <= 1) ? '지금 위치 번역 대기 중' : `${fmtSec(ahead)} 앞까지 준비됨`;
      return showStatus(`번역 ${Math.round((done / total) * 100)}% · ${where}${sttNote}`, false, done / total);
    }
    if (sttNote) return showStatus(`음성 인식${sttNote}`, false, s.sttProg ?? 'busy');
    showStatus('');
  }

  async function runBatch(s, batch, urgent = false) {
    batch.forEach((c) => (c.state = 1));
    s.running++;
    s.stats.sent++;
    const lines = batch.map((c, i) => ({ i, t: c.o }));
    const idx = s.cues.indexOf(batch[0]);
    const context = s.cues.slice(Math.max(0, idx - CTX), idx).map((c) => c.o).join('\n');
    // 응답 시간 제한은 background.js 의 fetch 에서 (요청 자체를 취소)
    // 원문 언어는 묶음의 줄들이 모두 같은 언어일 때만 알려줌 (섞여 있으면 번역 모델이 줄마다 판단)
    const langs = new Set(batch.map((c) => baseLang(lineLang(s, c))));
    const sourceLang = langs.size === 1 ? [...langs][0] : '';
    const res = await send({ type: 'translate', body: { title: s.title, channel: s.channel, lines, context, sourceLang, targetLang: s.target, translator: s.translator, style: s.style, asr: s.asr, urgent } });
    s.running--;
    if (s.dead || s !== st) return;
    if (res.ok) {
      s.hostErr = '';
      const got = new Set();
      for (const l of res.lines) {
        const c = batch[l.i];
        if (c && l.t) {
          setDone(c, l.t);
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
      s.stats.lastErr = res.error || '알 수 없음';
      batch.forEach(failCue);
      if (res.unreachable) {
        s.blockedUntil = Date.now() + 8000;
        s.hostErr = HOST_DOWN;
      } else {
        s.blockedUntil = Date.now() + 3000;
        s.hostErr = `번역 오류: ${res.error}`;
      }
    }
  }
  function failCue(c) {
    c.tries++;
    c.state = c.tries >= MAX_TRIES ? 3 : 0; // 3 = 포기(원문 표시)
  }

  // ---------- 렌더링 ----------
  function findCue(cues, t) {
    const i = lastStartedAt(cues, t);
    return i >= 0 && t < cues[i].e ? i : -1;
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
          requestStt(s, t);
          if (!s.sttPolling) pollStt(s);
        }
      }
    }
    s.lastTime = t;

    // 표시 내용은 (보이는 줄, 각 줄의 상태)로 결정됨. 번역문은 상태가 바뀔 때만 바뀜
    const shown = visibleCues(s.cues, t);
    const key = shown.map((i) => i * 4 + s.cues[i].state).join(',') + (settings.showOriginal ? '+' : '');
    if (key === lastShown) return;
    lastShown = key;
    overlay.textContent = '';
    shown.forEach((i, n) => {
      const c = s.cues[i];
      const prev = n < shown.length - 1; // 위에 남아 있는 이전 줄
      const main = document.createElement('div');
      const translated = !!(c.t || c.old); // 아니면 번역 전/실패라 원문을 흐리게 표시
      main.className = 'ytko-line' + (translated ? '' : ' ytko-pending') + (prev ? ' ytko-prev' : '') + (c.tag ? ' ytko-tag' : '');
      main.textContent = shownText(c);
      overlay.appendChild(main);
      if (settings.showOriginal && translated && !c.tag) {
        const o = document.createElement('div');
        o.className = 'ytko-line ytko-orig' + (prev ? ' ytko-prev' : '');
        o.textContent = c.o;
        overlay.appendChild(o);
      }
    });
  }

  // 화면에 보여줄 글: 번역문 -> (말투·엔진을 바꾼 직후) 이전 번역 -> 원문
  const shownText = (c) => c.t || c.old || c.o;
  // 자막을 읽을 시간 보장: 말이 짧게 끝나도 글자 수에 맞춰 더 오래 보여줌 (초당 약 10자, 1.5~8초)
  const readTime = (text) => Math.min(8, Math.max(1.5, 0.8 + String(text || '').length / 10));
  const OVERLAP = 1.0; // 다음 자막이 나온 뒤에도 이전 자막을 위에 남겨두는 최대 시간(초)
  const shownUntil = (c, next) => {
    const want = Math.max(c.e + 0.4, c.s + readTime(shownText(c)));
    return next ? Math.min(want, Math.max(c.e, next.s + OVERLAP)) : want;
  };
  const MAX_LINES = 1; // 2로 바꾸면 이전 자막을 위에 OVERLAP초 동안 함께 표시

  // 지금 보여줄 자막들(최대 MAX_LINES줄). 최신 자막이 끝났으면 더 이전 자막도 표시하지 않음
  function visibleCues(cues, t) {
    const last = lastStartedAt(cues, t);
    const out = [];
    for (let j = last; j >= 0 && out.length < MAX_LINES; j--) {
      if (t >= shownUntil(cues[j], cues[j + 1])) break;
      out.unshift(j);
    }
    return out;
  }

  // ---------- 팝업에 현재 상태 알려주기 ----------
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (retired || !msg || msg.type !== 'ytko-info') return;
      if (!st) {
        sendResponse({ ok: true, info: null, active, enabled: settings.enabled, onWatch: !!videoIdNow() });
        return;
      }
      const by = [0, 0, 0, 0];
      for (const c of st.cues) by[c.state]++;
      sendResponse({ ok: true, active, enabled: settings.enabled, onWatch: true, info: {
        ...st.info, state: st.fatal || st.hostErr || st.info.state, cues: st.cues.length, translated: by[2],
        stt: st.mode === 'stt' && !st.sttDone ? { msg: st.sttMsg, prog: st.sttProg } : null,
        debug: { wait: by[0], inflight: by[1], failed: by[3], running: st.running, sent: st.stats.sent,
          lastErr: st.stats.lastErr, srcLang: st.srcLang, sttDone: st.sttDone, t: Math.round(curTime()),
          blocked: Math.max(0, Math.round((st.blockedUntil - Date.now()) / 1000)) },
      } });
    });
  } catch (_) {}

  // ---------- 플레이어 번역 버튼 ----------
  // 켜면 호스트의 상주 codex 를 띄우고 번역 시작, 끄면(버튼/영상 끝/다른 영상·페이지) 번역과 codex 를 함께 끈다.
  function setActive(on) {
    if (on === active) return;
    active = on;
    clearInterval(pingTimer);
    if (on) {
      send({ type: 'session', action: 'start', id: sessionId, translator: settings.translator });
      pingTimer = setInterval(() => send({ type: 'session', action: 'ping', id: sessionId, translator: settings.translator }), 60000);
      start();
    } else {
      stop();
      send({ type: 'session', action: 'stop', id: sessionId });
    }
    flashStatus(on ? 'AI 번역 켜짐' : 'AI 번역 꺼짐');
    ensureButton();
  }

  // "AICC" 네모 아이콘. 높이는 CC 버튼의 네모에 맞춰 sizeButton 에서 정함 (켜짐/꺼짐 모양은 overlay.css)
  const BTN_W = 34, BTN_H = 16; // viewBox (가로:세로 비율)
  const BTN_SVG =
    `<svg viewBox="0 0 ${BTN_W} ${BTN_H}">` +
    `<rect class="ytko-box" x="1" y="1" width="${BTN_W - 2}" height="${BTN_H - 2}" rx="3"/>` +
    `<text class="ytko-txt" x="${BTN_W / 2}" y="11.6" text-anchor="middle">AICC</text></svg>`;

  // 같은 줄의 CC 버튼을 재서 버튼 높이와 네모 높이를 똑같이 맞춤 (플레이어 버전마다 크기가 달라서)
  function sizeButton(btn, cc) {
    const ccBox = cc && cc.querySelector('svg path, svg rect');
    const boxH = ccBox ? ccBox.getBoundingClientRect().height : 0;
    const h = boxH >= 8 ? boxH : 14; // CC 를 못 재면 기본 14px
    const svg = btn.querySelector('svg');
    if (!svg) return;
    svg.style.height = `${h}px`;
    svg.style.width = `${(h * BTN_W) / BTN_H}px`;
    if (cc && cc.offsetHeight) btn.style.height = `${cc.offsetHeight}px`;
  }

  // 플레이어 하단 컨트롤 바에서 버튼을 넣을 위치: CC(자막) 버튼 바로 앞 -> 오른쪽 컨트롤 맨 앞 -> 컨트롤 바 끝
  // (CC 버튼이 컨트롤 안에서 한 겹 더 감싸져 있는 플레이어도 있으므로 CC 버튼의 실제 부모에 넣음)
  function buttonSlot() {
    const player = getPlayerEl();
    if (!player) return null;
    // 숏츠: 플레이어 위쪽 오른쪽 컨트롤(CC·더보기·전체화면 묶음) 맨 앞
    if (isShorts()) {
      const right = player.closest('ytd-reel-video-renderer')?.querySelector('#right-controls');
      return right ? { parent: right, before: right.firstChild, shorts: true } : null;
    }
    const cc = player.querySelector('.ytp-subtitles-button');
    if (cc && cc.parentNode) return { parent: cc.parentNode, before: cc };
    const right = player.querySelector('.ytp-right-controls');
    if (right) return { parent: right, before: right.firstChild };
    const bar = player.querySelector('.ytp-chrome-controls');
    return bar ? { parent: bar, before: null } : null;
  }

  // 버튼을 넣고 상태를 맞춤 (유튜브가 컨트롤을 다시 그려도 매초 확인). 실패해도 다른 동작은 계속
  function ensureButton() {
    try {
      placeButton();
    } catch (e) {
      console.warn('[ytko] 번역 버튼을 넣지 못함:', e); // 플레이어 구조가 바뀐 경우. 다음 확인 때 다시 시도
    }
  }
  function placeButton() {
    let btn = document.getElementById('ytko-btn');
    const slot = settings.enabled && videoIdNow() ? buttonSlot() : null;
    if (!slot) {
      btn?.remove();
      return;
    }
    if (!btn || btn.parentNode !== slot.parent) {
      btn?.remove();
      btn = document.createElement('button');
      btn.id = 'ytko-btn';
      btn.className = slot.shorts ? 'ytko-shorts' : 'ytp-button';
      btn.innerHTML = BTN_SVG;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setActive(!active);
      });
      slot.parent.insertBefore(btn, slot.before);
    }
    const cc = slot.before && slot.before.classList && slot.before.classList.contains('ytp-subtitles-button') ? slot.before : null;
    if (!slot.shorts) sizeButton(btn, cc);
    btn.setAttribute('aria-pressed', String(active));
    btn.title = active ? 'AI 자막 번역 끄기' : 'AI 자막 번역 켜기';
    btn.setAttribute('aria-label', btn.title);
    // 영상이 끝까지 재생되면 자동으로 끔 (video 요소는 유튜브가 재사용하므로 한 번만 연결)
    const v = getVideo();
    if (v && !v.ytkoEnded) {
      v.ytkoEnded = true;
      v.addEventListener('ended', () => setActive(false));
    }
  }

  // ---------- 영상 전환 감지 (유튜브는 SPA) ----------
  let lastId = null;
  function check() {
    if (!alive()) return retire();
    const id = videoIdNow();
    if (id !== lastId) {
      lastId = id;
      setActive(false); // 다른 영상(다음 숏츠 포함)이나 페이지로 가면 번역 끔
      stop();
    }
    ensureButton();
  }
  // 탭을 닫거나 다른 사이트로 가면 호스트에 알림 (못 보내도 호스트가 3분 뒤 정리)
  window.addEventListener('pagehide', () => active && send({ type: 'session', action: 'stop', id: sessionId }));
  document.addEventListener('yt-navigate-finish', check);
  const checkTimer = setInterval(check, 1000);
  check();
})();
