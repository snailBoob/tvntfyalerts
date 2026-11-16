import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Delivery, networkFailure } from './notifications.mjs';

test('network diagnostics recognize nested and aggregate failures without reflecting secrets', () => {
  const secret = 'SECRET_TOKEN_COOKIE_ALERT';
  assert.match(networkFailure({ cause: { code: 'ENOTFOUND', message: secret } }), /DNS lookup failed/);
  assert.match(networkFailure({ cause: { errors: [{ code: 'ENETUNREACH' }, { code: 'ETIMEDOUT' }] } }), /ENETUNREACH.*ETIMEDOUT/);
  assert.match(networkFailure({ cause: { code: 'CERT_HAS_EXPIRED' } }), /certificate expired/);
  assert.match(networkFailure({ name: 'TimeoutError' }), /timed out/);
  assert.equal(networkFailure({ code: secret, message: secret }), null);
  assert.doesNotMatch(networkFailure({ code: 'ECONNREFUSED', message: secret }), /SECRET/);
});

test('startup failures reach status and logs; successful startup has no action or alert timestamp', async t => {
  const logs = [], received = [];
  let status = 403;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body));
    res.writeHead(status, status === 302 ? { Location: 'http://secret.invalid/SECRET_TOKEN' } : {});
    res.end(JSON.stringify(status === 200 ? { id: 'receipt', event: 'message' } : { error: 'SECRET_REMOTE_BODY' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const delivery = new Delivery({ url: `http://127.0.0.1:${server.address().port}`, topic: 'test', log: (...args) => logs.push(args) });
  await assert.rejects(delivery.started()); await delivery.chain;
  assert.match(delivery.status.error, /HTTP 403/);
  status = 302;
  await assert.rejects(delivery.started()); await delivery.chain;
  assert.match(delivery.status.error, /redirect/);
  assert.equal(received.length, 2, 'redirect is not followed or retried');
  status = 200;
  await delivery.started();
  assert.equal(delivery.status.error, null);
  assert.equal(delivery.status.lastSent, null);
  assert.equal(received[2].title, 'TV ntfy started');
  assert.equal(received[2].actions, undefined);
  assert.equal(received[2].click, undefined);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET/);
});

test('network startup errors are logged and exposed without a blind retry', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw Object.assign(new Error('SECRET_URL'), { cause: { code: 'ECONNREFUSED', message: 'SECRET_TOKEN' } });
  });
  const logs = [];
  const delivery = new Delivery({ url: 'http://unused.test', topic: 'test', log: (...args) => logs.push(args) });
  await assert.rejects(delivery.started()); await delivery.chain;
  assert.equal(calls, 1);
  assert.match(delivery.status.error, /ECONNREFUSED/);
  assert.doesNotMatch(JSON.stringify({ logs, status: delivery.status }), /SECRET/);
});
