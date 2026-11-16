import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import { extractUser } from './tradingview.mjs';
export { extractUser } from './tradingview.mjs';

// Return fixed labels only: untrusted field values must never enter logs.
export function messageType(data) {
  let envelope;
  try { envelope = JSON.parse(data.toString()); }
  catch { return 'non-JSON'; }
  if (!envelope || typeof envelope !== 'object') return 'unknown structure';
  if (envelope.id === -2) return 'transport: channel removed';
  if (!(typeof envelope.id === 'number' && envelope.id > 0)) return 'transport/control';
  if (envelope.text?.channel === 'pushstream_set_user_channel') return 'private channel update';
  if (envelope.text?.channel !== 'pricealerts') return 'other channel';
  const content = envelope.text.content;
  const types = ['alert_fired', 'alerts_created', 'alerts_updated', 'alerts_deleted', 'fires_deleted', 'fires_updated'];
  if (!types.includes(content?.m)) return 'pricealerts: unknown type';
  if (content.m === 'alert_fired') {
    const p = content.p;
    const valid = p && typeof p.message === 'string'
      && (typeof p.fire_id === 'string' || typeof p.fire_id === 'number');
    return valid ? 'pricealerts: alert_fired (message and trigger ID present)'
      : 'pricealerts: alert_fired (expected fields missing)';
  }
  return `pricealerts: ${content.m}`;
}

async function main() {
  try { process.loadEnvFile('.env'); }
  catch {
    console.error('Cannot read .env. Copy .env.example to .env and enter both cookies.');
    process.exitCode = 1;
    return;
  }
  const values = [process.env.TV_SESSIONID, process.env.TV_SESSIONID_SIGN];
  if (values.some(value => !value || !/^[\x21-\x7e]+$/.test(value) || /[;,]/.test(value))) {
    console.error('Both cookie values are required and must not contain spaces, control characters, commas or semicolons.');
    process.exitCode = 1;
    return;
  }
  const cookie = `sessionid=${values[0]}; sessionid_sign=${values[1]}`;
  console.log('Fetching chart page with both session cookies.');
  let response;
  try {
    response = await fetch('https://www.tradingview.com/chart/', {
      headers: { Cookie: cookie },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    console.log(`Chart page: HTTP ${response.status}`);
    if (!response.ok) throw new Error();
    const user = extractUser(await response.text());
    if (!user) {
      console.error('No readable server-provided user JSON found. The page format is not confirmed for this response.');
      process.exitCode = 1;
      return;
    }
    if (typeof user.private_channel !== 'string' || !user.private_channel) {
      console.error('The user object has no private_channel. Check that both cookies belong to the same active TradingView session.');
      process.exitCode = 1;
      return;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(user.private_channel)) {
      console.error('Unexpected private channel format; no URL constructed.');
      process.exitCode = 1;
      return;
    }
    console.log('Personal channel found (value hidden).');
    await connect(user.private_channel, cookie);
  } catch {
    console.error('Fetching or connecting failed; technical error details are hidden. HTTP status is shown above when available.');
    process.exitCode = 1;
  }
}

function connect(channel, cookie) {
  return new Promise(resolve => {
    console.log('Starting WebSocket with both cookies and TradingView Origin.');
    const socket = new WebSocket(
      `wss://pushstream.tradingview.com/message-pipe-ws/private_${channel}`,
      {
        headers: { Cookie: cookie, Origin: 'https://www.tradingview.com' },
        handshakeTimeout: 15000,
        followRedirects: false,
        maxPayload: 1024 * 1024,
      },
    );
    let opened = false;
    let finished = false;
    let stopping = false;
    let forceClose;
    const timer = setTimeout(() => {
      console.log('Ten-minute timeout reached; no alert payload saved.');
      stop();
    }, 10 * 60 * 1000);
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(forceClose);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    }
    function stop() {
      if (finished || stopping) return;
      stopping = true;
      console.log('Stopping probe.');
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000);
        forceClose = setTimeout(() => socket.terminate(), 2000);
      } else socket.terminate();
    }
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    socket.on('upgrade', response => console.log(`WebSocket-handshake: HTTP ${response.statusCode}`));
    socket.on('open', () => {
      opened = true;
      console.log('WebSocket OPEN: direct connection established. Waiting for messages; no subscribe frame sent.');
    });
    socket.on('message', data => {
      if (stopping) return;
      console.log(`Received type: ${messageType(data)}`);
      let envelope;
      try { envelope = JSON.parse(data.toString()); }
      catch { return; }
      if (!(typeof envelope?.id === 'number' && envelope.id > 0)
        || envelope.text?.channel !== 'pricealerts'
        || envelope.text.content?.m !== 'alert_fired') return;
      const payload = envelope.text.content.p;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        console.error('alert_fired has no payload object; nothing saved.');
        return;
      }
      try {
        mkdirSync('debug', { recursive: true, mode: 0o700 });
        writeFileSync('debug/alert-fired.json', JSON.stringify(payload, null, 2) + '\n', {
          flag: 'wx', mode: 0o600,
        });
        console.log('One alert payload saved to debug/alert-fired.json (content hidden).');
      } catch (error) {
        console.error(error.code === 'EEXIST'
          ? 'debug/alert-fired.json already exists; existing recording not overwritten.'
          : 'Could not save alert payload; error details hidden.');
        process.exitCode = 1;
      }
      stop();
    });
    socket.on('unexpected-response', (_request, response) => {
      console.error(`WebSocket handshake rejected: HTTP ${response.statusCode}`);
      process.exitCode = 1;
      response.resume();
      socket.terminate();
      finish();
    });
    socket.on('error', error => {
      const codes = ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'];
      console.error(`WebSocket error: ${codes.includes(error.code) ? error.code : 'details hidden'}`);
      process.exitCode = 1;
    });
    socket.on('close', code => {
      console.log(`WebSocket CLOSED: code ${code}; ${stopping ? 'closed locally' : 'closed remotely'}.`);
      if (!opened || !stopping) process.exitCode = 1;
      finish();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Probe failed; error details hidden.');
    process.exitCode = 1;
  });
}
