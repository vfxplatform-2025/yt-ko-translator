// 로컬 번역 호스트: 확장 프로그램 -> (127.0.0.1) -> codex exec (ChatGPT 로그인 세션) -> 한국어 번역
// 실행: node server.js   (의존성 없음)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const PORT = Number(process.env.PORT || 17891);
const MODEL = process.env.CODEX_MODEL || ''; // 비우면 codex 기본 모델 사용
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 3);
const TIMEOUT_MS = 120000;
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-ko-'));

let running = 0;
const waiters = [];
async function acquire() {
  if (running < MAX_CONCURRENT) { running++; return; }
  await new Promise((r) => waiters.push(r));
  running++;
}
function release() {
  running--;
  const next = waiters.shift();
  if (next) next();
}

function buildPrompt({ title, channel, lines, context }) {
  const input = lines.map((l) => ({ i: l.i, t: l.t }));
  return `당신은 유튜브 영상 자막 번역가입니다. 아래 자막 줄들을 자연스러운 한국어 구어체로 번역하세요.

규칙:
- 직역하지 말고, 한국어 화자가 실제로 말하는 것처럼 자연스럽게 의역합니다.
- 각 줄은 자막 한 줄이므로 짧고 읽기 쉽게 유지합니다. 한 줄이 문장 중간에서 끊겨 있어도 앞뒤 줄의 문맥을 보고 자연스럽게 이어지게 번역합니다.
- 고유명사, 브랜드, 기술 용어는 한국에서 통용되는 표기를 쓰고, 통용 표기가 없으면 원문을 그대로 둡니다.
- 입력 줄 수와 출력 줄 수는 반드시 같아야 하며, 각 i 값을 그대로 유지합니다.
- 설명, 코드블록, 머리말 없이 JSON 배열만 출력합니다. 형식: [{"i":0,"t":"번역문"}, ...]
- 파일을 읽거나 명령을 실행하지 마세요. 오직 번역만 하세요.

영상 제목: ${title || '(알 수 없음)'}
채널: ${channel || '(알 수 없음)'}
${context ? `\n직전 문맥(참고용, 번역하지 않음):\n${context}\n` : ''}
번역할 줄:
${JSON.stringify(input)}`;
}

function runCodex(prompt) {
  return new Promise((resolve, reject) => {
    const outFile = path.join(WORKDIR, `out-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    // Windows는 codex가 .cmd 래퍼라 shell이 필요하고 경로를 직접 따옴표로 감싸야 함.
    // Linux/macOS는 shell 없이 인자 배열로 그대로 전달.
    const q = IS_WIN ? (s) => `"${s}"` : (s) => s;
    const args = ['exec', '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never',
      '-C', q(WORKDIR), '-o', q(outFile),
      '-c', `model_reasoning_effort="${process.env.CODEX_EFFORT || 'low'}"`];
    if (MODEL) args.push('-m', MODEL);
    args.push('-');
    const child = spawn(process.env.CODEX_BIN || 'codex', args, { shell: IS_WIN, windowsHide: true, cwd: WORKDIR });
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
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
  await acquire();
  try {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await runCodex(prompt);
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

// ---------------- STT (자막 없는 영상): yt-dlp + faster-whisper 워커 ----------------
const CACHE_DIR = path.join(__dirname, 'cache');
const TRANSCRIPT_DIR = path.join(CACHE_DIR, 'transcripts');
fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
const PYTHON = IS_WIN
  ? path.join(__dirname, '.venv', 'Scripts', 'python.exe')
  : path.join(__dirname, '.venv', 'bin', 'python');

// Linux: pip로 설치한 CUDA 라이브러리(cuBLAS/cuDNN)는 LD_LIBRARY_PATH로 알려줘야 로드됨
function cudaLibPaths() {
  if (IS_WIN) return [];
  const out = [];
  const libRoot = path.join(__dirname, '.venv', 'lib');
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
const sttJobs = new Map(); // videoId -> { cues:[], state, msg, lang, touched }
let sttProc = null;
let sttBuf = '';

function ensureSttWorker() {
  if (sttProc) return true;
  if (!fs.existsSync(PYTHON)) return false;
  sttProc = spawn(PYTHON, [path.join(__dirname, 'stt_worker.py')], {
    cwd: __dirname,
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      LD_LIBRARY_PATH: [...cudaLibPaths(), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  sttProc.stdout.setEncoding('utf8');
  sttProc.stdout.on('data', (chunk) => {
    sttBuf += chunk;
    let nl;
    while ((nl = sttBuf.indexOf('\n')) >= 0) {
      const line = sttBuf.slice(0, nl).trim();
      sttBuf = sttBuf.slice(nl + 1);
      if (!line) continue;
      try { onSttEvent(JSON.parse(line)); } catch (_) {}
    }
  });
  sttProc.stderr.setEncoding('utf8');
  sttProc.stderr.on('data', (d) => process.stderr.write(`[stt] ${d}`));
  sttProc.on('exit', (code) => {
    console.error(`[stt] 워커 종료 (code ${code})`);
    for (const j of sttJobs.values()) {
      if (j.state !== 'done') { j.state = 'error'; j.msg = 'STT 워커가 종료되었습니다'; }
    }
    sttProc = null;
  });
  return true;
}

function onSttEvent(ev) {
  const job = sttJobs.get(ev.videoId);
  if (!job) return;
  if (ev.ev === 'cues') {
    const seen = job.seen;
    for (const c of ev.cues) {
      const key = Math.round(c.s * 10);
      if (seen.has(key)) continue;
      seen.add(key);
      job.cues.push(c);
    }
    job.lang = ev.lang || job.lang;
  } else if (ev.ev === 'status') {
    job.state = ev.state;
    job.msg = ev.msg;
    if (ev.state === 'done') {
      try {
        const sorted = [...job.cues].sort((a, b) => a.s - b.s);
        fs.writeFileSync(path.join(TRANSCRIPT_DIR, `${ev.videoId}.json`), JSON.stringify({ lang: job.lang, cues: sorted }));
      } catch (_) {}
    }
  }
}

function sttStart(videoId, from) {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) throw new Error('bad videoId');
  let job = sttJobs.get(videoId);
  if (!job) {
    const file = path.join(TRANSCRIPT_DIR, `${videoId}.json`);
    job = { cues: [], seen: new Set(), state: 'queued', msg: '', lang: '', touched: Date.now() };
    if (fs.existsSync(file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        job.cues = saved.cues;
        job.lang = saved.lang;
        job.state = 'done';
        job.msg = '캐시';
        sttJobs.set(videoId, job);
        return job;
      } catch (_) {}
    }
    sttJobs.set(videoId, job);
    if (sttJobs.size > 8) sttJobs.delete(sttJobs.keys().next().value);
  }
  job.touched = Date.now();
  if (job.state === 'done') return job;
  if (!ensureSttWorker()) {
    job.state = 'error';
    job.msg = 'STT 환경이 설치되지 않았습니다 (host/.venv 없음 — setup 스크립트를 실행하세요)';
    return job;
  }
  if (job.state === 'error') { job.state = 'queued'; job.msg = ''; }
  sttProc.stdin.write(JSON.stringify({ cmd: 'start', videoId, from: Number(from) || 0 }) + '\n');
  return job;
}

function send(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

const server = http.createServer((req, res) => {
  // 보안: 확장 프로그램에서 온 요청만 허용 (웹페이지는 Origin을 위조할 수 없음) + DNS rebinding 방지
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'bad host' });
  const origin = req.headers.origin || '';
  if (!origin.startsWith('chrome-extension://') && process.env.ALLOW_ANY_ORIGIN !== '1') {
    return send(res, 403, { error: 'forbidden origin' });
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, stt: fs.existsSync(PYTHON) });
  if (req.method === 'POST' && req.url === '/stt/start') {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const b = JSON.parse(raw);
        const job = sttStart(String(b.videoId || ''), b.from);
        send(res, 200, { state: job.state, msg: job.msg });
      } catch (e) {
        send(res, 400, { error: e.message });
      }
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/stt/poll')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const job = sttJobs.get(u.searchParams.get('videoId') || '');
    if (!job) return send(res, 404, { error: 'no job' });
    const since = Number(u.searchParams.get('since')) || 0;
    job.touched = Date.now();
    return send(res, 200, { state: job.state, msg: job.msg, lang: job.lang, total: job.cues.length, cues: job.cues.slice(since) });
  }
  if (req.method === 'POST' && req.url === '/translate') {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
      if (raw.length > 2e6) req.destroy();
    });
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw);
        if (!Array.isArray(body.lines) || body.lines.length === 0 || body.lines.length > 300) {
          return send(res, 400, { error: 'lines 형식 오류' });
        }
        const t0 = Date.now();
        const result = await translate(body);
        console.log(`[번역] ${body.lines.length}줄 ${((Date.now() - t0) / 1000).toFixed(1)}초`);
        send(res, 200, { lines: result });
      } catch (e) {
        console.error('[오류]', e.message);
        send(res, 500, { error: e.message });
      }
    });
    return;
  }
  send(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`yt-ko 호스트 실행 중: http://127.0.0.1:${PORT}  (codex 모델: ${MODEL || '기본'})`);
});
process.on('exit', () => {
  try { if (sttProc) sttProc.kill(); } catch (_) {}
  try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch (_) {}
});
process.on('SIGINT', () => process.exit(0));
