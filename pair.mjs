import { constants } from 'node:fs';
import { open, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const { values } = parseArgs({
  options: {
    serial: { type: 'string' },
    url: { type: 'string' },
    ssid: { type: 'string' },
    pair: { type: 'string', default: 'pairing.json' },
    init: { type: 'boolean' },
    probe: { type: 'boolean' },
    network: { type: 'boolean' },
    scan: { type: 'boolean' },
    'rename-ssid': { type: 'string' },
  },
});

async function getKey() {
  try {
    await writeFile(values.pair, JSON.stringify({ token: randomBytes(24).toString('hex') }) + '\n',
      { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const { token } = JSON.parse(await readFile(values.pair, 'utf8'));
  if (!/^[a-f0-9]{48}$/.test(token ?? '')) throw new Error('Invalid pairing file');
  return token;
}

function readPassword() {
  if (process.env.STICK_WIFI_PASSWORD !== undefined) return process.env.STICK_WIFI_PASSWORD;
  if (!process.stdin.isTTY) throw new Error('Use a terminal or set STICK_WIFI_PASSWORD');
  process.stderr.write('Wi-Fi password (hidden): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let password = '';
    const finish = (error) => {
      process.stdin.off('data', receive);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(password);
    };
    function receive(chunk) {
      for (const character of chunk) {
        if (character === '\u0003') return finish(new Error('Pairing cancelled'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') password = [...password].slice(0, -1).join('');
        else password += character;
      }
    }
    process.stdin.on('data', receive);
  });
}

async function pairDevice() {
  const { serial, ssid, url } = values;
  const newSsid = values['rename-ssid'];
  const needsPassword = !(values.probe || values.network || values.scan || newSsid);
  if (!/^\/dev\/cu\.usbmodem[\w.-]+$/.test(serial ?? '') || (needsPassword && (!ssid || !url))) {
    throw new Error('Usage: node pair.mjs --serial /dev/cu.usbmodem... --ssid SSID --url http://MAC_IP:8765');
  }
  let endpoint, password, token;
  if (newSsid && (/[\t\r\n\u0000]/.test(newSsid) || Buffer.byteLength(newSsid) > 32)) {
    throw new Error('Invalid new Wi-Fi name');
  }
  if (needsPassword) {
    endpoint = new URL(url);
    if (endpoint.protocol !== 'http:' || endpoint.username || endpoint.password ||
        endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.origin.length > 100) {
      throw new Error('Use a plain HTTP origin such as http://192.168.1.20:8765');
    }
    password = await readPassword();
    if (/[\t\r\n\u0000]/.test(ssid + password) || Buffer.byteLength(ssid) > 32 ||
        Buffer.byteLength(password) > 63) throw new Error('Invalid SSID or password');
    token = await getKey();
  }
  const mode = spawnSync('stty', ['-f', serial, '115200', 'raw', '-echo'], { stdio: 'inherit' });
  if (mode.status !== 0) throw new Error('Could not configure USB serial');
  const usb = await open(serial, constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK);
  let incoming = '';
  async function waitForLine(target, timeout) {
    const buffer = Buffer.alloc(512);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const { bytesRead } = await usb.read(buffer, 0, buffer.length, null);
        incoming += buffer.toString('utf8', 0, bytesRead);
        const lines = incoming.split('\n');
        incoming = lines.pop().slice(-512);
        for (const line of lines) {
          const result = line.trim();
          if (typeof target === 'function' ? target(result) : result === target) return result;
          if (['INVALID SETTINGS', 'SAVE FAILED'].includes(result)) throw new Error(result);
        }
      } catch (error) {
        if (error.code !== 'EAGAIN' && error.code !== 'EWOULDBLOCK') throw error;
      }
      await delay(35);
    }
    return false;
  }
  try {
    let matched = false;
    for (let attempt = 0; attempt < 5 && !matched; attempt++) {
      await usb.write('\nHELLO\n');
      matched = await waitForLine('STICK-QODER/1', 700);
    }
    if (!matched) throw new Error('No response from StickQoder firmware. Close other serial monitors.');
    if (values.network) {
      await usb.write('NET\n');
      const status = await waitForLine(line => line.startsWith('NET '), 1300);
      if (!status) throw new Error('No network status response');
      console.log(status);
      return;
    }
    if (values.scan) {
      await usb.write('NETSCAN\n');
      const status = await waitForLine(line => {
        if (line.startsWith('MATCH ')) console.log(line);
        return line.startsWith('NETSCAN ');
      }, 10000);
      if (!status) throw new Error('No Wi-Fi scan response');
      console.log(status);
      return;
    }
    if (values.probe) {
      console.log('StickQoder firmware replied over USB');
      return;
    }
    await usb.write(newSsid ? `PAIRSSID\t${newSsid}\n` :
      `PAIR\t${ssid}\t${password}\t${endpoint.origin}\t${token}\n`);
    if (!await waitForLine('PAIR OK', 2500)) throw new Error('Board did not confirm saved settings');
    console.log('Pairing saved. StickS3 is restarting.');
  } finally {
    await usb.close();
  }
}

if (values.init) {
  await getKey();
  console.log(`Pairing file ready at ${values.pair}`);
} else {
  await pairDevice();
}
