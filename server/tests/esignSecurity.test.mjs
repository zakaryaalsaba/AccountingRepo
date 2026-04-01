import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSignToken,
  hashSignToken,
  timingSafeEqualHex,
  getSignTokenTtlMs,
  signTokenExpiresAt,
} from '../src/modules/documents/security/signToken.js';

test('generateSignToken returns unique plain + matching hash', () => {
  const a = generateSignToken();
  const b = generateSignToken();
  assert.equal(a.plainToken.length > 40, true);
  assert.notEqual(a.plainToken, b.plainToken);
  assert.equal(a.tokenHash, hashSignToken(a.plainToken));
  assert.equal(a.tokenHash.length, 64);
});

test('timingSafeEqualHex', () => {
  const h = hashSignToken('x');
  assert.equal(timingSafeEqualHex(h, h), true);
  assert.equal(timingSafeEqualHex(h, hashSignToken('y')), false);
  assert.equal(timingSafeEqualHex('short', 'nope'), false);
});

test('sign token TTL defaults to positive range', () => {
  const ms = getSignTokenTtlMs();
  assert.equal(ms >= 24 * 60 * 60 * 1000, true);
  const exp = signTokenExpiresAt(new Date(0));
  assert.equal(exp.getTime() > 0, true);
});
