import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUser, messageType } from './probe.mjs';

test('extracts server JSON with nested objects and escaped quotes without executing code', () => {
  const user = { private_channel: 'fixture-only', nested: { text: 'a } " b' } };
  assert.deepEqual(extractUser(`<script>var user = ${JSON.stringify(user)}; throw Error();</script>`), user);
  assert.equal(extractUser('var user = {private_channel: execute()};'), null);
  assert.equal(extractUser('var user = {"unfinished":'), null);
  assert.equal(extractUser('<html>Login required</html>'), null);
});

test('recognizes confirmed envelope and never returns payload contents', () => {
  const event = { id: 1, text: { channel: 'pricealerts', content: {
    m: 'alert_fired', p: { message: 'SECRET MESSAGE', fire_id: 'SECRET ID' },
  } } };
  assert.equal(messageType(JSON.stringify(event)), 'pricealerts: alert_fired (message and trigger ID present)');
  event.text.content.p = {};
  assert.equal(messageType(JSON.stringify(event)), 'pricealerts: alert_fired (expected fields missing)');
  event.text.content.m = 'SECRET TYPE';
  assert.equal(messageType(JSON.stringify(event)), 'pricealerts: unknown type');
  event.text.channel = 'SECRET CHANNEL';
  assert.equal(messageType(JSON.stringify(event)), 'other channel');
});

test('handles malformed and control frames', () => {
  assert.equal(messageType('not json'), 'non-JSON');
  assert.equal(messageType('null'), 'unknown structure');
  assert.equal(messageType('{"id":-2}'), 'transport: channel removed');
  assert.equal(messageType('{"id":0}'), 'transport/control');
});
