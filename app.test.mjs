import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { alertNotification, readEvent, fetchChannel, openFeed } from './tradingview.mjs';
import { Delivery } from './notifications.mjs';
import { saveCookies } from './settings.mjs';
import { Relay } from './relay.mjs';
import { createApp } from './app.mjs';
import { EventEmitter } from 'node:events';

const payload = { fire_id: 42, message: 'Prijs €12\nTweede regel', pro_symbol: '={"symbol":"BINANCE:BLESSUSDT.P","session":"regular"}' };
const frame = (m, p = payload) => JSON.stringify({ id: 1, text: { channel: 'pricealerts', content: { m, p } } });

test('only alert_fired becomes an exact-text notification with decoded ticker and a button', () => {
  assert.equal(readEvent(frame('alerts_updated')), null);
  assert.equal(readEvent('not json'), null);
  assert.equal(readEvent(JSON.stringify({ id: 1, text: { channel: 'other', content: { m: 'alert_fired', p: payload } } })), null);
  const result = alertNotification(readEvent(frame('alert_fired')).payload);
  assert.equal(result.title, 'BINANCE:BLESSUSDT.P');
  assert.equal(result.message, payload.message);
  assert.equal(result.actions[0].label, 'TradingView');
  assert.equal(new URL(result.actions[0].url).searchParams.get('symbol'), 'BINANCE:BLESSUSDT.P');
  assert.equal('click' in result, false);
  assert.throws(() => alertNotification({ ...payload, pro_symbol: '={broken' }));
});

test('cookie updates preserve other settings and reject header injection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, '.env');
  const { writeFile, stat } = await import('node:fs/promises');
  await writeFile(path, '# instellingen\nNTFY_URL=https://example.test\nTV_SESSIONID=old\n');
  await saveCookies(path, { sessionid: 'abc', sessionid_sign: 'def:ghi' });
  const text = await readFile(path, 'utf8');
  assert.match(text, /NTFY_URL=https:\/\/example.test/);
  assert.match(text, /TV_SESSIONID='abc'/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(saveCookies(path, { sessionid: 'bad\r\nHeader: x', sessionid_sign: 'ok' }));
  assert.equal(await readFile(path, 'utf8'), text);
});

test('real local HTTP publishing deduplicates concurrent events and survives restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-delivery-'));
  const received = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    received.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'ntfy-id', event: 'message' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true, force: true }); });
  const options = { url: `http://127.0.0.1:${server.address().port}`, topic: 'tradingview-alerts', statePath: join(dir, 'seen.json'), retryMs: 1 };
  const delivery = new Delivery(options);
  await delivery.load();
  await Promise.all([delivery.alert(payload), delivery.alert(payload)]);
  assert.equal(received.length, 1);
  assert.equal(received[0].message, payload.message);
  assert.equal(received[0].topic, 'tradingview-alerts');
  const next = new Delivery(options);
  await next.load();
  await next.alert(payload);
  assert.equal(received.length, 1);
  await next.alert({ ...payload, fire_id: 43 });
  assert.equal(received.length, 2, 'same text with a new trigger is not a duplicate');
  const saved = await readFile(options.statePath, 'utf8');
  assert.equal(saved.includes(payload.message), false);
});

test('local chart and WebSocket verify handshake cookies, Origin and event receipt', async t => {
  let headers;
  const server = createServer((req, res) => {
    if (req.headers.cookie !== 'sessionid=test; sessionid_sign=sign') { res.writeHead(401); res.end(); return; }
    res.end('<script>var user = {"private_channel":"fixture"};</script>');
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, req) => {
    headers = req.headers;
    setTimeout(() => socket.send(frame('alert_fired')), 10);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { for (const socket of wss.clients) socket.terminate(); wss.close(); server.closeAllConnections(); server.close(); });
  const base = `127.0.0.1:${server.address().port}`;
  const cookies = { sessionid: 'test', sessionid_sign: 'sign' };
  assert.equal(await fetchChannel(cookies, `http://${base}`), 'fixture');
  await assert.rejects(fetchChannel({ sessionid: 'wrong', sessionid_sign: 'sign' }, `http://${base}`), { code: 'AUTH' });
  const socket = await openFeed('fixture', cookies, `ws://${base}/`);
  const [data] = await once(socket, 'message');
  assert.equal(readEvent(data).payload.fire_id, 42);
  assert.equal(headers.origin, 'https://www.tradingview.com');
  assert.equal(headers.cookie, 'sessionid=test; sessionid_sign=sign');
  socket.terminate();
});

test('connection loss reconnects, reports sustained outage once, and still delivers alerts', async t => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const notices = [], alerts = [];
  const delivery = { notice: async text => notices.push(text), alert: async p => alerts.push(p) };
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let connections = 0;
  const relay = new Relay(delivery, {
    getChannel: async () => 'fixture',
    connect: async (channel, cookies) => {
      connections++;
      return openFeed(channel, cookies, `ws://127.0.0.1:${server.address().port}/`);
    },
    retryMs: 30, outageMs: 5, heartbeatMs: 10,
  });
  t.after(() => { relay.stop(); for (const socket of wss.clients) socket.terminate(); wss.close(); server.close(); });
  const waitState = state => new Promise(resolve => {
    const check = () => { if (relay.state.connection === state) { relay.off('change', check); resolve(); } };
    relay.on('change', check); check();
  });
  relay.start({ sessionid: 'test', sessionid_sign: 'sign' });
  await waitState('connected');
  const disconnected = waitState('retrying');
  for (const socket of wss.clients) socket.terminate();
  await disconnected; await waitState('connected');
  assert.equal(connections, 2);
  assert.equal(notices.filter(text => text.includes('disconnected')).length, 1);
  assert.ok(notices.includes('TradingView connection restored.'));
  const received = new Promise(resolve => { delivery.alert = async p => { alerts.push(p); resolve(); }; });
  for (const socket of wss.clients) socket.send(frame('alert_fired'));
  await received;
  assert.equal(alerts[0].fire_id, 42);
});

test('confirmed invalid session stops reconnecting and emits one cookie-renewal notice', async t => {
  let attempts = 0;
  const notices = [];
  const relay = new Relay({ notice: async text => notices.push(text) }, {
    getChannel: async () => { attempts++; throw Object.assign(new Error(), { code: 'AUTH' }); }, retryMs: 1,
  });
  t.after(() => relay.stop());
  const rejected = new Promise(resolve => relay.on('change', () => { if (relay.state.connection === 'auth') resolve(); }));
  relay.start({ sessionid: 'test', sessionid_sign: 'sign' });
  await rejected;
  assert.equal(attempts, 1);
  assert.equal(relay.retryTimer, undefined);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /session is invalid/);
});

test('settings API protects writes and keeps existing cookies after a failed connection test', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-api-'));
  const envPath = join(dir, '.env');
  await saveCookies(envPath, { sessionid: 'old', sessionid_sign: 'sign' });
  const relay = new EventEmitter();
  relay.state = { connection: 'connected' };
  relay.prepare = async () => { throw Object.assign(new Error('Invalid session.'), { code: 'AUTH' }); };
  const delivery = { status: {} };
  const server = createApp({ relay, delivery, config: { url: 'https://example.test', topic: 'test' }, envPath });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); server.close(); await rm(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const body = JSON.stringify({ sessionid: 'new-secret', sessionid_sign: 'new-sign' });
  const denied = await fetch(`${url}/api/cookies`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.test' }, body });
  assert.equal(denied.status, 403);
  const rejected = await fetch(`${url}/api/cookies`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body });
  assert.equal(rejected.status, 502);
  assert.match(await readFile(envPath, 'utf8'), /TV_SESSIONID='old'/);
  const state = await (await fetch(`${url}/api/status`)).text();
  assert.equal(state.includes('secret'), false);
  relay.prepare = async () => ({ readyState: 1 });
  let activated = false;
  relay.activate = () => { activated = true; };
  const saved = await fetch(`${url}/api/cookies`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body });
  assert.equal(saved.status, 200);
  assert.equal(activated, true);
  assert.match(await readFile(envPath, 'utf8'), /TV_SESSIONID='new-secret'/);
});

test('forwarded address accepts its own origin but rejects other hosts and cross-origin writes', async t => {
  const relay = new EventEmitter();
  relay.state = { connection: 'waiting' };
  const server = createApp({ relay, delivery: { status: {} }, config: {
    url: 'https://example.test', topic: 'test', publicUrl: 'http://192.168.8.234:40003',
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeStreams(); server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { Host: '192.168.8.234:40003', Origin: 'http://192.168.8.234:40003', 'Content-Type': 'application/json' };
  const status = (path, method, headers) => new Promise((resolve, reject) => {
    const req = request(url + path, { method, headers }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end(method === 'POST' ? '{}' : undefined);
  });
  assert.equal(await status('/', 'GET', headers), 200);
  assert.equal(await status('/api/cookies', 'POST', headers), 400, 'reaches cookie validation rather than origin rejection');
  assert.equal(await status('/api/cookies', 'POST', { ...headers, Origin: 'http://evil.test' }), 403);
  assert.equal(await status('/', 'GET', { Host: 'evil.test' }), 403);
});

test('ntfy rejects are reported and never marked as delivered; known HTTP failures can retry', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-retry-'));
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume(); calls++;
    res.writeHead(calls < 3 ? 503 : 403); res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true, force: true }); });
  const delivery = new Delivery({ url: `http://127.0.0.1:${server.address().port}`, topic: 'test', statePath: join(dir, 'seen.json'), retryMs: 1 });
  await delivery.load();
  await assert.rejects(delivery.alert(payload), /HTTP 403/);
  assert.equal(calls, 3);
  assert.equal(delivery.seen.size, 0);
  assert.match(delivery.status.error, /HTTP 403/);
});

test('end-to-end: WebSocket frames reach ntfy once with only the original alert and ticker action', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-flow-'));
  const published = [];
  const ntfy = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    published.push(JSON.parse(body));
    res.end(JSON.stringify({ id: 'receipt', event: 'message' }));
  });
  ntfy.listen(0, '127.0.0.1'); await once(ntfy, 'listening');
  const feed = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(feed, 'listening');
  const delivery = new Delivery({ url: `http://127.0.0.1:${ntfy.address().port}`, topic: 'tradingview-alerts', statePath: join(dir, 'seen.json') });
  await delivery.load();
  const relay = new Relay(delivery, { getChannel: async () => 'fixture', connect: (channel, cookies) => openFeed(channel, cookies, `ws://127.0.0.1:${feed.address().port}/`) });
  t.after(async () => { relay.stop(); for (const socket of feed.clients) socket.terminate(); feed.close(); ntfy.closeAllConnections(); ntfy.close(); await rm(dir, { recursive: true, force: true }); });
  const delivered = new Promise(resolve => { delivery.onChange = () => { if (delivery.status.lastSent && delivery.pending.size === 0) resolve(); }; });
  feed.on('connection', socket => {
    setTimeout(() => {
      socket.send(frame('alerts_created'));
      socket.send(frame('alerts_updated'));
      socket.send(frame('alert_fired'));
      socket.send(frame('alert_fired'));
    }, 10);
  });
  relay.start({ sessionid: 'fake-session', sessionid_sign: 'fake-sign' });
  await delivered;
  const alerts = published.filter(message => message.title === 'BINANCE:BLESSUSDT.P');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].message, payload.message);
  assert.equal(alerts[0].actions[0].label, 'TradingView');
  assert.equal(JSON.stringify(published).includes('fake-session'), false);
  assert.equal(published.length, 2, 'one connection notice and one alert');
});
