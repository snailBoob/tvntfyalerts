import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Relay } from './relay.mjs';
import { Delivery } from './notifications.mjs';

test('log output has UTC timestamps and routes warnings/errors to stderr', () => {
  const source = `import {logEvent} from ${JSON.stringify(new URL('./logging.mjs', import.meta.url).href)}; logEvent('INFO','App started.');`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
  assert.match(output, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z INFO App started\.\n$/);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source.replace("logEvent('INFO','App started.');", "logEvent('WARN','Retry scheduled.'); logEvent('ERROR','Delivery failed.');")], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Z WARN Retry scheduled\.\n/);
  assert.match(result.stderr, /Z ERROR Delivery failed\.\n/);
});

test('connection transitions omit detail text and repeated states', () => {
  const logs = [];
  const relay = new Relay({}, { log: (...args) => logs.push(args) });
  relay.update('connected', 'PRIVATE CHANNEL AND COOKIE');
  relay.update('connected', 'SECRET ALERT TEXT');
  relay.update('retrying', 'REMOTE ERROR WITH TOKEN');
  relay.update('auth', 'PRIVATE SESSION');
  assert.deepEqual(logs.map(([level]) => level), ['INFO', 'WARN', 'ERROR']);
  assert.match(logs[2][1], /replace both cookies/);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|SECRET|REMOTE/);
});

test('ntfy logs HTTP errors, bounded retries and recovery without payloads or tokens', async t => {
  const logs = [];
  let status = 403;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) {}
    res.writeHead(status);
    res.end(JSON.stringify(status === 200 ? { id: 'SECRET_RECEIPT', event: 'message' } : { error: 'SECRET_RESPONSE' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const delivery = new Delivery({ url: `http://127.0.0.1:${server.address().port}`, topic: 'SECRET_TOPIC', token: 'SECRET_TOKEN', retryMs: 1, log: (...args) => logs.push(args) });
  const notification = { title: 'SECRET_TICKER', message: 'SECRET_ALERT' };
  await assert.rejects(delivery.publish(notification));
  status = 503;
  await assert.rejects(delivery.publish(notification));
  status = 200;
  await delivery.publish(notification);
  await delivery.publish(notification);
  assert.equal(logs.filter(([level]) => level === 'WARN').length, 2);
  assert.equal(logs.filter(([, message]) => message.includes('recovered')).length, 1);
  assert.ok(logs.some(([, message]) => message.includes('HTTP 403')));
  assert.ok(logs.some(([, message]) => message.includes('HTTP 503')));
  assert.doesNotMatch(JSON.stringify(logs), /SECRET/);
});
