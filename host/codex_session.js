// 상주 codex: `codex app-server`(JSON-RPC over stdio)를 한 번 띄워 두고 번역 요청마다 새 대화(thread)로 묻는다.
// 요청마다 `codex exec`를 띄우는 것보다 요청당 약 0.5~2.5초 빠름 (프로세스 시작 + 긴 기본 지시문 생략).
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';

// 하위 프로세스까지 종료. Windows 에서 shell 로 띄운 프로세스는 kill() 하면 cmd.exe 만 끝나고
// 실제 프로그램(codex/claude)은 남으므로 taskkill /T 로 트리 전체를 끈다.
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  } else {
    try { child.kill(); } catch (_) {}
  }
}
// codex 에이전트의 긴 기본 지시문/도구 설명 대신 쓰는 짧은 지시문 (입력 토큰을 줄여 응답이 빨라짐)
const BASE_INSTRUCTIONS =
  'You are a subtitle translator. Follow the user instructions exactly and reply with only the requested JSON. Never use tools.';

class CodexSession {
  constructor({ bin, cwd, model, effort, log }) {
    Object.assign(this, { bin, cwd, model, effort, log });
    this.proc = null;
    this.ready = null; // 초기화 완료 Promise
    this.nextId = 1;
    this.pending = new Map(); // 요청 id -> { resolve, reject }
    this.turns = new Map(); // threadId -> { text, done }
  }

  get running() {
    return !!this.proc;
  }

  start() {
    if (this.ready) return this.ready;
    const args = ['app-server', '-c', `model_reasoning_effort="${this.effort}"`];
    if (this.model) args.push('-c', `model="${this.model}"`);
    const proc = spawn(this.bin, args, { cwd: this.cwd, shell: IS_WIN, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.onMessage(line);
      }
    });
    proc.stderr.on('data', () => {}); // 진행 로그는 버림 (오류는 응답으로 옴)
    const fail = (err) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.ready = null;
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      for (const t of this.turns.values()) t.done(err);
      this.turns.clear();
    };
    proc.on('error', (e) => fail(e));
    proc.on('exit', (code) => fail(new Error(`codex app-server 종료 (code ${code})`)));
    this.ready = this.rpc('initialize', { clientInfo: { name: 'yt-ko-translator', version: '1' } }).then(() => {
      this.send({ method: 'initialized' });
      this.log('[codex] 상주 세션 시작');
    });
    this.ready.catch(() => this.stop());
    return this.ready;
  }

  stop() {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    killTree(proc);
    this.log('[codex] 상주 세션 종료');
  }

  send(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  rpc(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('codex app-server 꺼짐'));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  onMessage(line) {
    let m;
    try { m = JSON.parse(line); } catch (_) { return; }
    // 내가 보낸 요청의 응답
    if (m.id != null && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      return m.error ? p.reject(new Error(m.error.message || JSON.stringify(m.error))) : p.resolve(m.result);
    }
    // 서버가 묻는 요청(명령 실행 승인 등): 번역에는 필요 없으므로 모두 거절
    if (m.id != null && m.method) {
      return this.send({ id: m.id, error: { code: -32601, message: 'not supported' } });
    }
    // 알림: 답변 글자 누적 / 턴 완료
    const t = m.params && this.turns.get(m.params.threadId);
    if (!t) return;
    if (m.method === 'item/agentMessage/delta') t.text += m.params.delta || '';
    else if (m.method === 'turn/completed') {
      const turn = m.params.turn || {};
      t.done(turn.status === 'failed' ? new Error((turn.error && turn.error.message) || 'codex 턴 실패') : null);
    } else if (m.method === 'error' && !m.params.willRetry) {
      t.done(new Error((m.params.error && m.params.error.message) || 'codex 오류'));
    }
  }

  // 프롬프트 하나를 새 대화로 보내고 최종 답변 텍스트를 돌려줌
  async ask(prompt, timeoutMs) {
    await this.start();
    const th = await this.rpc('thread/start', {
      ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', cwd: this.cwd, baseInstructions: BASE_INSTRUCTIONS,
    });
    const threadId = th.thread.id;
    let timer;
    const result = new Promise((resolve, reject) => {
      const t = { text: '', done: (err) => (err ? reject(err) : resolve(t.text)) };
      this.turns.set(threadId, t);
      timer = setTimeout(() => reject(new Error('codex 시간 초과')), timeoutMs);
    });
    try {
      await this.rpc('turn/start', { threadId, input: [{ type: 'text', text: prompt }], effort: this.effort });
      return await result;
    } finally {
      clearTimeout(timer);
      this.turns.delete(threadId);
    }
  }
}

module.exports = { CodexSession, killTree };
