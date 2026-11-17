// 로컬 번역 호스트: 확장 프로그램 -> (127.0.0.1) -> codex (ChatGPT 로그인 세션) -> 번역
// 플레이어의 번역 버튼이 켜져 있는 동안은 상주 codex(app-server)를, 그 외에는 요청마다 codex exec 를 사용.
// 실행: node server.js   (의존성 없음)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { CodexSession, killTree } = require('./codex_session');

const IS_WIN = process.platform === 'win32';
const PORT = Number(process.env.PORT || 17891);
const MODEL = process.env.CODEX_MODEL || ''; // 비우면 codex 기본 모델 사용
const EFFORT = process.env.CODEX_EFFORT || 'low'; // none 이 약 20% 빠르지만 번역 품질은 low 가 나음
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 3);
const TIMEOUT_MS = 120000;
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-ko-'));

// 동시 번역 수 제한. 재생 위치 가까운 요청(urgent)은 대기열 맨 앞에 서고, 한도가 차 있어도 한 칸 더 씀
// (먼 구간 30줄 번역이 칸을 다 차지하고 있어도 시간 이동 직후의 자막이 기다리지 않도록)
let running = 0;
const waiters = []; // { urgent, go }
const limitOf = (urgent) => MAX_CONCURRENT + (urgent ? 1 : 0);
async function acquire(urgent = false) {
  if (running < limitOf(urgent)) { running++; return; }
  await new Promise((go) => {
    const w = { urgent, go };
    const at = urgent ? waiters.findIndex((x) => !x.urgent) : -1; // urgent 는 다른 urgent 뒤, 일반 요청 앞
    waiters.splice(at < 0 ? waiters.length : at, 0, w);
  });
}
function release() {
  running--;
  const w = waiters[0];
  if (w && running < limitOf(w.urgent)) {
    waiters.shift();
    running++;
    w.go();
  }
}

// 언어 코드 -> 이름 (예: 'en' -> '영어', 'zh-Hans' -> '중국어(간체)')
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const langNames = new Intl.DisplayNames(['ko'], { type: 'language' });
function langName(code) {
  try { return langNames.of(code) || code; } catch (_) { return code; }
}

// 번역 말투 (팝업에서 고름). 확장 프로그램은 키만 보내고 지시문은 여기서 정함. natural = 기본(지시 없음)
const STYLES = {
  natural: '',
  polite: '친절하고 상냥한 존댓말로, 듣는 사람을 배려하는 따뜻한 말투로 번역합니다.',
  casual: '친한 친구끼리 편하게 말하는 반말로 번역합니다.',
  hiphop: '힙합 래퍼처럼 자신감 넘치고 허세 있는 스트릿 말투로 번역합니다. "요", "ㄹㅇ", "개쩐다", "플렉스", "리스펙" 같은 힙합·인터넷 슬랭과 영어 감탄사를 자연스럽게 섞고, 말끝에 리듬감을 줍니다.',
  aave: 'AAVE(African American Vernacular English, 미국 흑인 영어 방언) 슬랭으로, 텐션을 확 올려 오버하는 말투로 번역합니다. 번역 언어가 영어면 AAVE 의 실제 문법과 표현(habitual be, 생략된 copula, ain’t, finna, on God, no cap, deadass, bruh 등)을 씁니다. 다른 언어면 그 언어의 스트릿 슬랭으로 옮깁니다 (한국어면 "브로", "맨", "찐으로", "노캡", "레전드", "미쳤다", "개-", "ㄹㅇ" 같은 표현과 반말). 모든 줄에 슬랭이나 감탄사를 최소 하나 넣고, 평범한 말도 과장해서 크게 부풀립니다 ("조금 무섭다" → "와 브로 찐으로 개쫄려", "맵다" → "혀 녹아내린다 노캡", "불친절했다" → "태도 미쳤더라 ㄹㅇ"). 인종을 비하하거나 고정관념을 담은 내용은 넣지 않습니다.',
  gangster: '느와르·갱스터 영화의 조폭처럼 거칠고 위압적인 반말로 번역합니다. 시비조로 말하고, "새끼", "젠장", "씨발" 같은 욕설·비속어도 상황에 맞게 섞되 매 줄마다 넣지는 않습니다.',
  sageuk: '조선시대 사극 대사처럼 예스러운 말투(~하오, ~하시오, ~느니라 등)로 번역합니다.',
  news: '뉴스 앵커처럼 또박또박하고 격식 있는 보도 말투로 번역합니다.',
  cute: '귀엽고 애교 있는 말투로, 말끝을 부드럽게 하거나 귀여운 어미를 써서 번역합니다.',
  pretty: '"예쁜 말"로 번역합니다. 부정적이거나 거칠고 공격적인 표현은 긍정적이고 부드러운 표현으로 바꿉니다 (비난·불평은 바람이나 부탁으로, 욕설·비속어는 순화해서, 단정적인 말은 배려하는 말로). 무슨 일이 있었는지 같은 사실은 바꾸지 않습니다.',
  sexy: '듣는 사람을 유혹하듯 끈적하고 섹시한 말투로 번역합니다. 상대에게 바로 말을 거는 듯한 반말("자기야", "너"), 늘어지는 말끝("~해애", "~할까아?", "~잖아…"), 숨 고르는 말줄임표("하아…", "음…"), 은근히 떠보거나 도발하는 말("나 보고 싶었지?", "그렇게 보면 곤란한데…") 중 하나 이상을 매 줄 넣어 분위기가 확 나게 하되, 같은 호칭이나 표현을 줄마다 되풀이하지 말고 골고루 바꿔 씁니다 (예: "오늘 매운 라면 먹어볼게요" → "오늘은… 매운 거 먹어볼까? 감당할 수 있겠어, 자기야?"). 노골적인 성적 표현은 쓰지 않고 말투와 뉘앙스로만 표현합니다.',
};
const styleOf = (s) => (Object.hasOwn(STYLES, s) ? s : 'natural');

// 원문이 받아쓰기(유튜브 자동 생성 자막·음성 인식)일 때 붙이는 규칙. 비슷한 소리로 잘못 받아쓴 말이 섞여 있음
// (예: 일본어 "ベジータ兄さん(니상)" 을 숫자 "ベジータ23(니·산)" 으로 받아씀)
const ASR_RULE = '- 원문은 소리를 자동으로 받아쓴 것이라 비슷한 소리의 다른 말로 잘못 받아쓴 부분이 있을 수 있습니다 (숫자·동음이의어·고유명사 등). 문맥상 어색하면 원래 했을 말을 추측해 바로잡아 번역합니다 (예: 일본어 "ベジータ23" 은 "ベジータ兄さん" 을 잘못 받아쓴 것이므로 "베지터 형님").\n';

function buildPrompt({ title, channel, lines, context, sourceLang, targetLang, style, asr }) {
  const input = lines.map((l) => ({ i: l.i, t: l.t }));
  const target = LANG_RE.test(targetLang || '') ? targetLang : 'ko';
  const tName = langName(target);
  const srcLine = LANG_RE.test(sourceLang || '') ? `원문 언어: ${langName(sourceLang)}\n` : '';
  const styleRule = STYLES[styleOf(style)];
  return `당신은 유튜브 영상 자막 번역가입니다. 아래 자막 줄들을 자연스러운 ${tName} 구어체로 번역하세요.

규칙:
- 직역하지 말고, ${tName} 원어민이 실제로 말하는 것처럼 자연스럽게 의역합니다.
${asr === true ? ASR_RULE : ''}${styleRule ? `- 말투: ${styleRule} 내용과 의미는 그대로 두고 말투만 바꿉니다. 원문이 이미 ${tName}이어도 그대로 옮기지 말고 이 말투로 바꿔 다시 씁니다.\n` : ''}- 각 줄은 자막 한 줄이므로 짧고 읽기 쉽게 유지합니다. 한 줄이 문장 중간에서 끊겨 있어도 앞뒤 줄의 문맥을 보고 자연스럽게 이어지게 번역합니다.
- 고유명사, 브랜드, 기술 용어는 ${tName} 사용자들 사이에서 통용되는 표기를 쓰고, 통용 표기가 없으면 원문을 그대로 둡니다.
- 입력 줄 수와 출력 줄 수는 반드시 같아야 하며, 각 i 값을 그대로 유지합니다.
- 설명, 코드블록, 머리말 없이 JSON 배열만 출력합니다. 형식: [{"i":0,"t":"번역문"}, ...]
- 파일을 읽거나 명령을 실행하지 마세요. 오직 번역만 하세요.

${srcLine}번역 언어: ${tName}
영상 제목: ${title || '(알 수 없음)'}
채널: ${channel || '(알 수 없음)'}
${context ? `\n직전 문맥(참고용, 번역하지 않음):\n${context}\n` : ''}
번역할 줄:
${JSON.stringify(input)}`;
}

// ---------------- 상주 codex 세션 ----------------
// 번역 버튼을 켠 탭(holder)이 하나라도 있으면 유지. 끄기 요청이 없더라도(탭 닫힘 등) 신호가 끊기면 자동 종료.
const codex = new CodexSession({ bin: CODEX_BIN, cwd: WORKDIR, model: MODEL, effort: EFFORT, log: (...a) => console.log(...a) });
const holders = new Map(); // holder id -> { at: 마지막 신호 시각, translator: 그 탭이 고른 번역 엔진 }
const HOLDER_TTL_MS = 3 * 60 * 1000; // 확장 프로그램은 1분마다 ping

// 번역 버튼을 켠 탭 중 codex 를 쓰는 탭이 없으면 상주 codex 를 내리고,
// 켠 탭이 하나도 없으면 음성 인식 워커(GPU 메모리)도 내림. 중단된 받아쓰기는 다시 켜면 이어서 진행.
function releaseIfIdle() {
  if (![...holders.values()].some((h) => h.translator === 'codex')) codex.stop();
  if (holders.size) return;
  for (const [engine, p] of sttProcs) {
    console.log(`[stt:${engine}] 번역이 모두 꺼져 워커를 종료합니다`);
    try { p.kill(); } catch (_) {}
  }
}

// ---------------- 번역 엔진: codex(ChatGPT 구독) 또는 Claude(Claude 구독). 팝업에서 고름 ----------------
const TRANSLATORS = ['codex', 'claude-sonnet', 'claude-haiku'];
const binOf = (t) => (t.startsWith('claude-') ? CLAUDE_BIN : CODEX_BIN);

// 실행 파일이 있는지 — 요청 처리 중에 기다리지 않도록 백그라운드에서 확인해 두고 그 값을 씀 (시작 때 + 1분마다)
const binOk = new Map(); // bin -> true/false (확인 전에는 없음 = 있다고 봄)
function probeBin(bin) {
  const child = spawn(bin, ['--version'], { shell: IS_WIN, windowsHide: true, stdio: 'ignore' });
  const timer = setTimeout(() => killTree(child), 15000);
  child.on('error', () => { clearTimeout(timer); binOk.set(bin, false); });
  child.on('close', (code) => { clearTimeout(timer); binOk.set(bin, code === 0); });
}
const probeAll = () => [CODEX_BIN, CLAUDE_BIN].forEach(probeBin);
probeAll();
const translatorReady = (t) => binOk.get(binOf(t)) !== false;
const readyTranslators = () => ({ codex: translatorReady('codex'), claude: translatorReady('claude-sonnet') });

// 고른 엔진이 이 PC에 없으면 설치된 다른 엔진으로 대신 (설정은 PC 사이에 동기화되므로)
function translatorOf(t) {
  t = TRANSLATORS.includes(t) ? t : 'codex';
  if (translatorReady(t)) return t;
  return TRANSLATORS.find(translatorReady) || t;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, h] of holders) if (now - h.at > HOLDER_TTL_MS) holders.delete(id);
  releaseIfIdle();
}, 30000).unref();
setInterval(probeAll, 60000).unref();

async function session(action, id, translator = 'codex') {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) throw new Error('bad id');
  if (action === 'stop') {
    holders.delete(id);
    releaseIfIdle();
    return;
  }
  if (action !== 'start' && action !== 'ping') throw new Error('bad action');
  const t = translatorOf(translator) === 'codex' ? 'codex' : 'claude';
  holders.set(id, { at: Date.now(), translator: t });
  releaseIfIdle(); // Claude 로 바꿨으면 더는 쓰지 않는 상주 codex 를 내림
  // codex 는 미리 띄워 두어 첫 번역부터 빠르게 (Claude 는 요청마다 실행해도 빨라서 상주시키지 않음)
  if (action === 'start' && t === 'codex') await codex.start();
}

function runTranslator(prompt, translator) {
  if (translator.startsWith('claude-')) return runClaude(prompt, translator.slice('claude-'.length));
  return codex.running ? codex.ask(prompt, TIMEOUT_MS) : runCodexExec(prompt);
}

// Claude Code CLI 한 번 실행 (구독 로그인 사용). --safe-mode 로 사용자 설정(훅·MCP·CLAUDE.md·플러그인)을 끄고,
// 도구 없이 번역만 하게 한다. 10줄 번역 기준 Sonnet 약 4초, Haiku 약 3.6초.
// 모델은 엔진별 환경변수로 바꿀 수 있음: CLAUDE_MODEL_SONNET, CLAUDE_MODEL_HAIKU (기본: 별칭 sonnet / haiku)
const CLAUDE_SYSTEM = 'You are a subtitle translator. Follow the user instructions exactly and reply with only the requested JSON.';
function runClaude(prompt, model) {
  return new Promise((resolve, reject) => {
    const q = IS_WIN ? (s) => `"${s}"` : (s) => s;
    const args = ['-p', '--safe-mode', '--strict-mcp-config', '--tools', q(''), '--no-session-persistence',
      '--model', process.env[`CLAUDE_MODEL_${model.toUpperCase()}`] || model, '--system-prompt', q(CLAUDE_SYSTEM)];
    const child = spawn(CLAUDE_BIN, args, { shell: IS_WIN, windowsHide: true, cwd: WORKDIR });
    let out = '';
    let err = '';
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => { killTree(child); finish(reject, new Error('claude 시간 초과')); }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      // 로그인 안 됨·사용량 초과 등은 그 안내문을 stdout 에 쓰고 0이 아닌 코드로 끝남 — 그 문구를 그대로 오류로
      if (code !== 0) return finish(reject, new Error(`claude 오류: ${(out.trim() || err.trim()).slice(-300) || `종료 코드 ${code}`}`));
      finish(resolve, out);
    });
    child.stdin.end(prompt);
  });
}

function runCodexExec(prompt) {
  return new Promise((resolve, reject) => {
    const outFile = path.join(WORKDIR, `out-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    // Windows는 codex가 .cmd 래퍼라 shell이 필요하고 경로를 직접 따옴표로 감싸야 함.
    // Linux/macOS는 shell 없이 인자 배열로 그대로 전달.
    const q = IS_WIN ? (s) => `"${s}"` : (s) => s;
    const args = ['exec', '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never',
      '-C', q(WORKDIR), '-o', q(outFile),
      '-c', `model_reasoning_effort="${EFFORT}"`];
    if (MODEL) args.push('-m', MODEL);
    args.push('-');
    const child = spawn(CODEX_BIN, args, { shell: IS_WIN, windowsHide: true, cwd: WORKDIR });
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      killTree(child);
      reject(new Error('codex 시간 초과'));
    }, TIMEOUT_MS);
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', () => {});
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8'); fs.unlinkSync(outFile); } catch (_) {}
      if (code !== 0 && !text) return reject(new Error(`codex 종료 코드 ${code}: ${stderr.slice(-500)}`));
      resolve(text);
    });
    child.stdin.end(prompt);
  });
}

function parseResult(text, expected) {
  let s = text.trim();
  const m = s.match(/\[[\s\S]*\]/);
  if (m) s = m[0];
  const arr = JSON.parse(s);
  const map = new Map(arr.map((x) => [Number(x.i), String(x.t)]));
  const missing = expected.filter((i) => !map.has(i));
  return { map, missing };
}

async function translate(body) {
  const lines = body.lines;
  const expected = lines.map((l) => l.i);
  const prompt = buildPrompt(body);
  const translator = translatorOf(body.translator);
  await acquire(body.urgent === true);
  try {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await runTranslator(prompt, translator);
        const { map, missing } = parseResult(text, expected);
        if (missing.length === 0 || attempt === 1) {
          return lines.map((l) => ({ i: l.i, t: map.get(l.i) ?? '' }));
        }
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('번역 실패');
  } finally {
    release();
  }
}

// ---------------- STT (자막 없는 영상): yt-dlp + 음성 인식 엔진 워커 ----------------
const CACHE_DIR = path.join(__dirname, 'cache');
const TRANSCRIPT_DIR = path.join(CACHE_DIR, 'transcripts');
fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });

// 음성 인식 엔진: 엔진마다 자기 가상환경의 Python 으로 같은 stt_worker.py 를 실행 (STT_ENGINE 으로 구분)
const venvPython = (dir) => (IS_WIN ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python'));
const ENGINES = {
  whisper: path.join(__dirname, '.venv'), // faster-whisper (다국어)
  haas: path.join(__dirname, 'engines', 'Haas-ASR', '.venv'), // Haas-ja (일본어, 그 외 언어는 같은 환경의 Whisper)
  qwen: path.join(__dirname, 'engines', 'qwen', '.venv'), // Qwen3-ASR 1.7B (다국어)
  nemotron: path.join(__dirname, 'engines', 'nemotron', '.venv'), // Nemotron 3.5 ASR Streaming 0.6B (다국어)
};
const engineReady = (engine) => !!ENGINES[engine] && fs.existsSync(venvPython(ENGINES[engine]));
const readyEngines = () => Object.fromEntries(Object.keys(ENGINES).map((e) => [e, engineReady(e)]));

// Linux: pip로 설치한 CUDA 라이브러리(cuBLAS/cuDNN)는 LD_LIBRARY_PATH로 알려줘야 로드됨
function cudaLibPaths(venv) {
  if (IS_WIN) return [];
  const out = [];
  const libRoot = path.join(venv, 'lib');
  try {
    for (const py of fs.readdirSync(libRoot)) {
      const nv = path.join(libRoot, py, 'site-packages', 'nvidia');
      if (!fs.existsSync(nv)) continue;
      for (const pkg of fs.readdirSync(nv)) {
        const lib = path.join(nv, pkg, 'lib');
        if (fs.existsSync(lib)) out.push(lib);
      }
    }
  } catch (_) {}
  return out;
}

// 받아쓰기 작업: 영상 + 요청 언어('' = 자동 감지) + 엔진 단위
// jobKey -> { cues:[], seen, state, msg, prog, detected(감지된 언어), used(실제 쓴 엔진), lang, engine, touched }
const sttJobs = new Map();
const jobKey = (videoId, lang, engine) => `${videoId}|${lang || ''}|${engine}`;
const STT_LANG_RE = /^[a-z]{2,3}$/; // 언어 기본 코드 (예: 'en', 'ja', 'zh')
const sttProcs = new Map(); // engine -> 워커 프로세스

// 엔진 워커 실행. 다른 엔진 워커는 GPU 메모리를 비우려고 종료 (엔진을 바꾸면 이전 작업은 끝남)
function ensureSttWorker(engine) {
  if (sttProcs.has(engine)) return true;
  if (!engineReady(engine)) return false;
  for (const [other, p] of sttProcs) if (other !== engine) p.kill();
  const venv = ENGINES[engine];
  const proc = spawn(venvPython(venv), [path.join(__dirname, 'stt_worker.py')], {
    cwd: __dirname,
    windowsHide: true,
    env: {
      ...process.env,
      STT_ENGINE: engine,
      PYTHONIOENCODING: 'utf-8',
      LD_LIBRARY_PATH: [...cudaLibPaths(venv), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  sttProcs.set(engine, proc);
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { onSttEvent(JSON.parse(line), engine); } catch (_) {}
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => process.stderr.write(`[stt:${engine}] ${d}`));
  proc.on('exit', (code) => {
    console.error(`[stt:${engine}] 워커 종료 (code ${code})`);
    if (sttProcs.get(engine) === proc) sttProcs.delete(engine);
    for (const j of sttJobs.values()) {
      if (j.engine === engine && j.state !== 'done') { j.state = 'error'; j.msg = 'STT 워커가 종료되었습니다'; }
    }
  });
  return true;
}

function onSttEvent(ev, engine) {
  const job = sttJobs.get(jobKey(ev.videoId, ev.req, engine)); // 워커는 이벤트마다 요청 언어(req)를 붙임
  if (!job) return;
  if (ev.used) job.used = ev.used;
  if (ev.ev === 'cues') {
    const seen = job.seen;
    for (const c of ev.cues) {
      const key = Math.round(c.s * 10);
      if (seen.has(key)) continue;
      seen.add(key);
      job.cues.push(c);
    }
    job.detected = ev.lang || job.detected;
  } else if (ev.ev === 'status') {
    job.state = ev.state;
    job.msg = ev.msg;
    job.prog = typeof ev.prog === 'number' ? ev.prog : null;
    if (ev.state === 'done') {
      try {
        const sorted = [...job.cues].sort((a, b) => a.s - b.s);
        fs.writeFileSync(transcriptFile(ev.videoId, job.lang, engine), JSON.stringify({ lang: job.detected, used: job.used, cues: sorted }));
      } catch (_) {}
    }
  }
}

// 받아쓰기 캐시: <id>.<엔진>.<언어 또는 auto2>.json
// 언어 자동(auto2): 말소리 덩어리마다 언어를 감지하는 방식. 예전 auto 결과(영상 하나를 한 언어로 받아씀)는 다시 쓰지 않음
const transcriptFile = (videoId, lang, engine) => path.join(TRANSCRIPT_DIR, `${videoId}.${engine}.${lang || 'auto2'}.json`);

// lang: '' 이면 자동 감지, 아니면 언어 코드(예: 'en', 'ja')로 고정
function sttStart(videoId, from, lang = '', engine = 'whisper') {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) throw new Error('bad videoId');
  if (lang && !STT_LANG_RE.test(lang)) throw new Error('bad lang');
  if (!ENGINES[engine]) throw new Error('bad engine');
  // 이 PC에 없는 엔진이면 Whisper 로 대신 (예: Windows 에는 Whisper 만 설치)
  if (!engineReady(engine) && engine !== 'whisper' && engineReady('whisper')) engine = 'whisper';
  const key = jobKey(videoId, lang, engine);
  let job = sttJobs.get(key);
  if (!job) {
    const file = transcriptFile(videoId, lang, engine);
    job = { cues: [], seen: new Set(), state: 'queued', msg: '', prog: null, detected: '', used: '', lang, engine, touched: Date.now() };
    if (fs.existsSync(file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        Object.assign(job, { cues: saved.cues, detected: saved.lang, used: saved.used || engine, state: 'done', msg: '캐시', prog: 1 });
        sttJobs.set(key, job);
        return job;
      } catch (_) {}
    }
    sttJobs.set(key, job);
    if (sttJobs.size > 8) sttJobs.delete(sttJobs.keys().next().value);
  }
  job.touched = Date.now();
  if (job.state === 'done') return job;
  if (!ensureSttWorker(engine)) {
    job.state = 'error';
    job.msg = engine === 'whisper'
      ? 'STT 환경이 설치되지 않았습니다 (host/.venv 없음 — setup 스크립트를 실행하세요)'
      : `음성 인식 엔진(${engine})이 설치되지 않았습니다 — 팝업에서 다른 모델을 고르세요`;
    return job;
  }
  if (job.state === 'error') { job.state = 'queued'; job.msg = ''; }
  sttProcs.get(engine).stdin.write(JSON.stringify({ cmd: 'start', videoId, from: Number(from) || 0, lang }) + '\n');
  return job;
}

// POST 본문(JSON) 읽기. limit 바이트를 넘으면 연결을 끊음
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
      if (raw.length > limit) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); } catch (e) { reject(Object.assign(e, { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

const server = http.createServer((req, res) => {
  // 보안: DNS rebinding 방지 + 확장 프로그램 요청만 허용.
  // 확장 프로그램(background.js)은 모든 요청에 X-YTKO 헤더를 붙인다. 웹페이지가 이 헤더를 붙이면
  // 브라우저가 먼저 CORS 사전 요청(OPTIONS, 헤더 없음)을 보내는데 그것이 여기서 거부되므로 위조할 수 없음.
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'bad host' });
  const origin = req.headers.origin || '';
  const fromExt = req.headers['x-ytko'] === '1' && (!origin || origin.startsWith('chrome-extension://'));
  if (!fromExt && process.env.ALLOW_ANY_ORIGIN !== '1') {
    console.warn(`[거부] ${req.method} ${req.url} origin=${origin || '(없음)'}`);
    return send(res, 403, { error: 'forbidden origin' });
  }
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, stt: engineReady('whisper'), engines: readyEngines(), translators: readyTranslators(), codex: codex.running });
  }
  if (req.method === 'GET' && req.url.startsWith('/stt/poll')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const job = sttJobs.get(jobKey(u.searchParams.get('videoId') || '', u.searchParams.get('lang'), u.searchParams.get('engine') || 'whisper'));
    if (!job) return send(res, 404, { error: 'no job' });
    const since = Number(u.searchParams.get('since')) || 0;
    job.touched = Date.now();
    return send(res, 200, { state: job.state, msg: job.msg, prog: job.prog, lang: job.detected, used: job.used, total: job.cues.length, cues: job.cues.slice(since) });
  }
  if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
  const route = ROUTES[req.url];
  if (!route) return send(res, 404, { error: 'not found' });
  readJson(req, route.limit)
    .then(route.handle)
    .then((out) => send(res, 200, out))
    .catch((e) => {
      if (e.status !== 400) console.error('[오류]', e.message);
      send(res, e.status || 400, { error: e.message });
    });
});

const httpError = (status, message) => Object.assign(new Error(message), { status });

// POST 경로: 본문 크기 제한 + 처리 함수 (throw 하면 오류 응답, 기본 400)
const ROUTES = {
  '/session': {
    limit: 1e3,
    handle: async (b) => {
      try {
        await session(String(b.action || ''), String(b.id || ''), String(b.translator || 'codex'));
      } catch (e) {
        throw httpError(e.message.startsWith('bad ') ? 400 : 500, e.message);
      }
      return { ok: true, codex: codex.running };
    },
  },
  '/stt/start': {
    limit: 1e5,
    handle: async (b) => {
      const job = sttStart(String(b.videoId || ''), b.from, String(b.lang || ''), String(b.engine || 'whisper'));
      return { state: job.state, msg: job.msg, engine: job.engine };
    },
  },
  '/translate': {
    limit: 2e6,
    handle: async (body) => {
      if (!Array.isArray(body.lines) || body.lines.length === 0 || body.lines.length > 300) throw httpError(400, 'lines 형식 오류');
      const t0 = Date.now();
      const translator = translatorOf(body.translator);
      const via = translator !== 'codex' ? translator : codex.running ? 'codex 상주' : 'codex exec';
      let result;
      try {
        result = await translate(body);
      } catch (e) {
        throw httpError(500, e.message);
      }
      const pair = `${body.sourceLang || '?'}→${body.targetLang || 'ko'}`;
      console.log(`${new Date().toTimeString().slice(0, 8)} [번역] ${pair} ${body.lines.length}줄 ${((Date.now() - t0) / 1000).toFixed(1)}초 (${via}${body.urgent === true ? ', 우선' : ''})`);
      return { lines: result };
    },
  },
};

server.listen(PORT, '127.0.0.1', () => {
  console.log(`yt-ko 호스트 실행 중: http://127.0.0.1:${PORT}  (codex 모델: ${MODEL || '기본'})`);
});
process.on('exit', () => {
  codex.stop();
  for (const p of sttProcs.values()) try { p.kill(); } catch (_) {}
  try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch (_) {}
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0)); // systemctl stop/restart
