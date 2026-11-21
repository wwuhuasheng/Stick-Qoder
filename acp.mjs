import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class ACP {
  constructor(binary, cwd, onUpdate, onPermission, onExit) {
    this.nextId = 0;
    this.pending = new Map();
    this.permissions = new Map();
    this.child = spawn(binary, ['--acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.pipe(process.stderr, { end: false });
    this.child.stdin.on('error', () => {});
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch {
        if (line.trim()) console.error('[Qoder]', line.slice(0, 500));
        return;
      }
      if (message.method === 'session/update') {
        onUpdate(message.params);
      } else if (message.method === 'session/request_permission' && message.id != null) {
        this.permissions.set(message.id, message.params);
        onPermission(message.id, message.params);
      } else if (message.method && message.id != null) {
        this.write({ id: message.id, error: { code: -32601, message: 'Unsupported client method' } });
      } else if (!message.method && this.pending.has(message.id)) {
        const request = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message ?? 'Qoder RPC error'));
        else request.resolve(message.result);
      }
    });
    const exited = error => {
      if (this.closed) return;
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.pending.clear();
      this.permissions.clear();
      onExit(error);
    };
    this.child.once('error', exited);
    this.child.once('close', (code, signal) => exited(new Error(`Qoder exited (${signal ?? code})`)));
  }

  write(message) {
    if (this.closed || !this.child.stdin.writable) return false;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    return true;
  }

  request(method, params, timeout = 30000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Qoder timed out during ${method}`));
      }, timeout) : null;
      this.pending.set(id, { resolve, reject, timer });
      if (!this.write({ id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Qoder process is unavailable'));
      }
    });
  }

  async start(cwd) {
    const hello = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'stick-qoder', version: '0.1.0' },
    });
    if (hello?.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version');
    const session = await this.request('session/new', { cwd, mcpServers: [] }, 60000);
    if (!session?.sessionId) throw new Error('Qoder did not return a session ID');
    return session.sessionId;
  }

  decide(id, kind) {
    const entry = this.permissions.get(id);
    if (!entry) return false;
    const option = entry.options?.find(candidate => candidate.kind === kind);
    if (!option && kind !== 'cancelled') return false;
    this.permissions.delete(id);
    this.write({ id, result: { outcome: option
      ? { outcome: 'selected', optionId: option.optionId }
      : { outcome: 'cancelled' } } });
    return true;
  }

  prompt(sessionId, text) {
    return this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 0);
  }

  cancel(sessionId) {
    this.write({ method: 'session/cancel', params: { sessionId } });
    for (const [id, params] of this.permissions) {
      if (params.sessionId === sessionId) this.decide(id, 'cancelled');
    }
  }

  close() {
    if (!this.closed) this.child.kill();
  }
}
