import { createServer } from 'node:http';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { readFile, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseArgs, promisify } from 'node:util';
import { ACP } from './acp.mjs';

const exec = promisify(execFile);
const { values } = parseArgs({
  options: {
    cwd: { type: 'string', default: process.cwd() },
    cli: { type: 'string', default: 'qodercn' },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '8765' },
    pair: { type: 'string', default: 'pairing.json' },
    'whisper-model': { type: 'string' },
    whisper: { type: 'string', default: 'whisper-cli' },
    speech: { type: 'string' },
    'connect-on-start': { type: 'boolean' },
    'connection-status': { type: 'string' },
    demo: { type: 'boolean' },
  },
});
const cwd = resolve(values.cwd);
const cli = values.cli.includes('/') ? resolve(values.cli) : values.cli;
if (!(await stat(cwd)).isDirectory()) throw new Error('The Qoder working directory must be a directory');
const { token } = JSON.parse(await readFile(values.pair, 'utf8'));
if (!/^[a-f0-9]{48}$/.test(token ?? '')) throw new Error('Invalid pairing key');
const expectedAuth = Buffer.from(`Bearer ${token}`);
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
if (values['whisper-model'] && !(await stat(values['whisper-model'])).isFile()) {
  throw new Error('Invalid whisper model file');
}

function clip(value, limit) {
  let bytes = 0;
  let result = '';
  for (const glyph of String(value ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim()) {
    bytes += Buffer.byteLength(glyph);
    if (bytes > limit) break;
    result += glyph;
  }
  return result;
}

let state = 'IDLE', detail = 'Start a task in the Mac terminal', turnId = 0;
let draft = null, note = '', noteExpires = 0, recognizing = false;
let acp, opening, sessionId, pauseRequested = false, demoFinish;
let latestMessage = '', active = false;
let alertId = 0, alertKind = '';
let boardIP = '';
const canVoice = Boolean(values.speech || values['whisper-model']);

function connectionStatus() {
  const filename = values['connection-status'];
  if (!filename) return;
  const data = { listening: server.listening, qoder: Boolean(sessionId), boardIP };
  try {
    writeFileSync(filename + '.tmp', JSON.stringify(data) + '\n', { mode: 0o600 });
    renameSync(filename + '.tmp', filename);
  } catch (error) {
    console.error('[Connection status]', error.message);
  }
}

function transition(next, description) {
  if (state !== next) console.log(`[${next}] ${description}`);
  state = next;
  detail = description;
  if (['DONE', 'ERROR', 'NETWORK ERROR'].includes(next)) signal(next);
}

function signal(kind) {
  alertId = randomInt(1, 0x100000000);
  alertKind = kind;
}

function voiceNote(message) {
  note = message;
  noteExpires = Date.now() + 5000;
}

function status(message = '') {
  if (draft && Date.now() >= draft.expires) draft = null;
  const description = recognizing ? 'Transcribing on the Mac...' :
    noteExpires > Date.now() ? note : detail;
  return [
    'STICK-QODER/1', state, turnId, draft?.id ?? 0, Number(canVoice),
    clip(description, 150), draft?.text ?? '', clip(message, 100), alertId, alertKind,
  ].join('\t');
}

function showUpdate(params) {
  if (!active || params?.sessionId !== sessionId || pauseRequested) return;
  const update = params.update;
  if (!update) return;
  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
    latestMessage = (latestMessage + update.content.text).slice(-1500);
    detail = clip(latestMessage.trim().split(/\n+/).filter(Boolean).at(-1), 150) || 'Qoder is responding';
    process.stdout.write(update.content.text);
  } else if (update.sessionUpdate === 'agent_thought_chunk') {
    if (detail === 'Qoder is working') detail = 'Qoder is thinking';
  } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    if (update.status === 'failed') signal('ERROR');
    detail = `${update.title ?? 'Tool'}${update.status ? ' / ' + update.status : ''}`;
  }
}

async function connect() {
  if (sessionId && acp && !acp.closed) return;
  if (opening) return opening;
  const transport = new ACP(cli, cwd, showUpdate, (id, params) => {
    if (pauseRequested || params.sessionId !== sessionId || !active) {
      transport.decide(id, 'cancelled');
      return;
    }
    detail = 'Permission requested. See Mac.';
    console.log(`\n[PERMISSION ${id}] ${clip(params.toolCall?.title, 320)}`);
    const allowed = params.options?.some(option => option.kind === 'allow_once');
    const rejected = params.options?.some(option => option.kind === 'reject_once');
    console.log([allowed && `/allow ${id}`, rejected ? `/deny ${id}` : `/cancel ${id}`].filter(Boolean).join(' / '));
  }, () => {
    if (acp === transport) {
      sessionId = null;
      connectionStatus();
    }
  });
  acp = transport;
  opening = transport.start(cwd).then(id => {
    sessionId = id;
    connectionStatus();
  }).catch(error => {
    transport.close();
    throw error;
  }).finally(() => { opening = null; });
  return opening;
}

function reportError(error) {
  const message = clip(error.message, 150);
  console.error(`\n[Qoder] ${error.message}`);
  const network = /econnreset|econnrefused|enotfound|eai_again|etimedout|socket hang up|network|fetch failed|请求超时|网络|\b(?:502|503|504)\b/i.test(message);
  transition(network ? 'NETWORK ERROR' : 'ERROR', message);
}

async function run(prompt, requireSession = false) {
  active = true;
  pauseRequested = false;
  latestMessage = '';
  turnId = randomInt(1, 0x100000000);
  transition('RUNNING', 'Qoder is working');
  try {
    let result;
    if (values.demo) {
      result = await new Promise(resolveResult => {
        const fail = prompt === '/network';
        const timer = setTimeout(() => {
          demoFinish = null;
          resolveResult(fail ? { error: 'Network error: demo timeout' } : { stopReason: 'end_turn' });
        }, 7500);
        demoFinish = () => {
          clearTimeout(timer);
          demoFinish = null;
          resolveResult({ stopReason: 'cancelled' });
        };
      });
    } else {
      if (requireSession && !sessionId) throw new Error('Qoder session has closed');
      await connect();
      result = pauseRequested ? { stopReason: 'cancelled' } : await acp.prompt(sessionId, prompt);
    }
    console.log();
    if (result?.error || result?.isError) {
      reportError(new Error(result.error?.message ?? result.error ?? 'Qoder reported a turn error'));
    } else if (result?.stopReason === 'cancelled') {
      transition('PAUSED', 'Press A to continue the session');
    } else if (result?.stopReason === 'end_turn') {
      transition('DONE', clip(latestMessage, 150) || 'Turn complete');
    } else {
      transition('ERROR', `Qoder stopped: ${result?.stopReason ?? 'unknown result'}`);
    }
  } catch (error) {
    reportError(error);
  } finally {
    active = false;
  }
}

function action(command, target) {
  if (command === 'send' || command === 'discard') {
    if (!draft || draft.id !== target || Date.now() >= draft.expires) throw new Error('Voice draft expired');
    if (command === 'discard') {
      draft = null;
      return 'Draft discarded';
    }
    if (active) throw new Error('Pause Qoder before sending');
    const text = draft.text;
    draft = null;
    void run(text);
    return 'Voice update sent';
  }
  if (!turnId || target !== turnId) throw new Error('Task changed; press A again');
  if (command === 'pause' && state === 'RUNNING' && active) {
    pauseRequested = true;
    transition('PAUSING', 'Waiting for Qoder to stop');
    if (values.demo) demoFinish();
    else if (sessionId) acp.cancel(sessionId);
    return '';
  }
  if (command === 'resume' && !active && (state === 'PAUSED' || state === 'NETWORK ERROR')) {
    if (!values.demo && !sessionId) throw new Error('Session closed. Start a new task on the Mac.');
    void run('请从当前工作状态继续刚才的任务。已经成功完成的步骤无需重复。', true);
    return '';
  }
  throw new Error('Action unavailable for the current task');
}

function respond(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req, limit) {
  const length = Number(req.headers['content-length']);
  if (!Number.isInteger(length) || length <= 0 || length > limit) {
    req.resume();
    throw new Error('Invalid payload size');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Payload too large');
    chunks.push(chunk);
  }
  if (size !== length) throw new Error('Incomplete payload');
  return Buffer.concat(chunks, size);
}

function validWav(wav) {
  return wav.length >= 16044 && wav.toString('ascii', 0, 4) === 'RIFF' &&
    wav.readUInt32LE(4) === wav.length - 8 &&
    wav.toString('ascii', 8, 16) === 'WAVEfmt ' && wav.readUInt32LE(16) === 16 &&
    wav.readUInt16LE(20) === 1 && wav.readUInt16LE(22) === 1 &&
    wav.readUInt32LE(24) === 16000 && wav.readUInt16LE(34) === 16 &&
    wav.toString('ascii', 36, 40) === 'data' && wav.readUInt32LE(40) === wav.length - 44;
}

async function recognize(wav) {
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'stick-qoder-'));
    const recording = join(directory, 'voice.wav');
    await writeFile(recording, wav, { mode: 0o600 });
    let recognized;
    if (values.speech) {
      recognized = (await exec(values.speech, [recording], { timeout: 30000 })).stdout;
    } else {
      const output = join(directory, 'transcript');
      await exec(values.whisper, ['-m', resolve(values['whisper-model']), '-f', recording,
        '-l', 'zh', '-otxt', '-of', output], { timeout: 60000 });
      recognized = await readFile(output + '.txt', 'utf8');
    }
    const fullText = recognized.replace(/\s+/g, ' ').trim();
    const displayText = clip(fullText, 120);
    if (!displayText) throw new Error('No speech recognized');
    if (displayText !== fullText) throw new Error('Voice draft is too long. Try a shorter update.');
    draft = { id: randomInt(1, 0x100000000), text: displayText, expires: Date.now() + 90000 };
    console.log(`\n[Voice preview] ${draft.text}`);
  } catch (error) {
    console.error('[Voice]', error.message);
    voiceNote(error.code === 'ENOENT' ? 'Speech tool unavailable on Mac' : 'Transcription failed. Check Mac.');
  } finally {
    recognizing = false;
    if (directory) await rm(directory, { recursive: true, force: true }).catch(console.error);
  }
}

const server = createServer({ requestTimeout: 10000, headersTimeout: 7000 }, async (req, res) => {
  const supplied = Buffer.from(req.headers.authorization ?? '');
  if (supplied.length !== expectedAuth.length || !timingSafeEqual(supplied, expectedAuth)) {
    req.resume();
    return respond(res, 401, 'Pairing key rejected');
  }
  try {
    if (req.method === 'GET' && req.url === '/status') {
      const remote = req.socket.remoteAddress;
      if (remote && remote !== values.host && !remote.startsWith('127.') && remote !== '::1' && remote !== boardIP) {
        boardIP = remote;
        console.log('[StickS3] Connected from ' + boardIP);
        connectionStatus();
      }
      return respond(res, 200, status());
    }
    if (req.method === 'POST' && req.url === '/action') {
      const body = (await readBody(req, 32)).toString();
      const parsed = /^(pause|resume|send|discard)\t([1-9][0-9]{0,9})$/.exec(body);
      if (!parsed) return respond(res, 400, 'Invalid action');
      return respond(res, 200, status(action(parsed[1], Number(parsed[2]))));
    }
    if (req.method === 'POST' && req.url === '/voice') {
      if (!canVoice) { req.resume(); return respond(res, 409, 'Voice unavailable'); }
      if (recognizing || (draft && Date.now() < draft.expires)) {
        req.resume();
        return respond(res, 409, 'Voice draft already in progress');
      }
      recognizing = true;
      try {
        const wav = await readBody(req, 256044);
        if (!validWav(wav)) throw new Error('Unsupported audio format');
        void recognize(wav);
      } catch (error) {
        recognizing = false;
        throw error;
      }
      return respond(res, 200, status());
    }
    req.resume();
    respond(res, 404, 'Unknown route');
  } catch (error) {
    respond(res, 409, clip(error.message, 100));
  }
});
server.listen(port, values.host, () => {
  console.log(`StickS3 bridge http://${values.host}:${port} | ${values.demo ? 'DEMO' : cwd}`);
  console.log('Type a task and press Enter. /pause, /resume, /quit');
  connectionStatus();
  if (values['connect-on-start'] && !values.demo) {
    transition('CONNECTING', 'Connecting to Qoder CN');
    active = true;
    connect().then(() => {
      transition('IDLE', 'Qoder connected. Enter a task or hold B.');
    }).catch(reportError).finally(() => { active = false; });
  }
});
function stop() {
  acp?.close();
  if (demoFinish) demoFinish();
  input.close();
  server.close(connectionStatus);
}
const input = createInterface({ input: process.stdin, terminal: Boolean(process.stdin.isTTY) });
input.on('line', line => {
  const text = line.trim();
  if (!text) return;
  try {
    const permission = /^\/(allow|deny|cancel) (\d+)$/.exec(text);
    if (permission) {
      const kind = { allow: 'allow_once', deny: 'reject_once', cancel: 'cancelled' }[permission[1]];
      if (!acp?.decide(Number(permission[2]), kind)) console.log('Permission option unavailable');
      else detail = 'Qoder is working';
    } else if (text === '/quit') stop();
    else if (text === '/pause' || text === '/resume') action(text.slice(1), turnId);
    else if (active) console.log('Qoder is busy. Pause or wait before sending an update.');
    else void run(text);
  } catch (error) {
    console.error(error.message);
  }
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
