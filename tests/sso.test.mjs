import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const SECRET = 'test-sso-secret-long-enough-for-signing';
process.env.CHISHOKAN_SSO_SECRET = SECRET;

const { verifySsoToken, isSsoEnabled } = await import('../lib/sso.js');

let passed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

// 智翔館アプリ(meeting_support の lib/interviewSso.ts)と同じ作り方
function makeToken(payload, secret = SECRET) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}
const now = Math.floor(Date.now() / 1000);
const valid = { aud: 'interview-admin', dept: 'red', name: '福元崇恭', campus: 'RED個別', iat: now, exp: now + 60 };

console.log('\n== 智翔館アプリからの自動ログイン ==');

test('正しいトークンなら部門と氏名が取り出せる', () => {
  assert.deepEqual(verifySsoToken(makeToken(valid)), { dept: 'red', name: '福元崇恭', campus: 'RED個別' });
});

test('別の鍵で署名されたトークンは通らない', () => {
  assert.equal(verifySsoToken(makeToken(valid, 'another-secret-long-enough-xxxx')), null);
});

test('中身を書き換えると通らない', () => {
  const [, sig] = makeToken(valid).split('.');
  const forged = Buffer.from(JSON.stringify({ ...valid, dept: 'chutobu' })).toString('base64url');
  assert.equal(verifySsoToken(`${forged}.${sig}`), null);
});

test('期限切れ・寿命が長すぎる・未来の発行は通らない', () => {
  assert.equal(verifySsoToken(makeToken({ ...valid, iat: now - 120, exp: now - 1 })), null);
  assert.equal(verifySsoToken(makeToken({ ...valid, exp: now + 3600 })), null);
  assert.equal(verifySsoToken(makeToken({ ...valid, iat: now + 300, exp: now + 360 })), null);
});

test('宛先が違うトークン・部門名がおかしいトークンは通らない', () => {
  assert.equal(verifySsoToken(makeToken({ ...valid, aud: 'other' })), null);
  assert.equal(verifySsoToken(makeToken({ ...valid, dept: '../red' })), null);
});

test('壊れたトークンは通らない', () => {
  assert.equal(verifySsoToken(''), null);
  assert.equal(verifySsoToken('abc'), null);
  assert.equal(verifySsoToken('a.b.c'), null);
});

test('鍵が未設定・短すぎるときは自動ログインを無効にする', () => {
  const token = makeToken(valid);
  delete process.env.CHISHOKAN_SSO_SECRET;
  assert.equal(isSsoEnabled(), false);
  assert.equal(verifySsoToken(token), null);
  process.env.CHISHOKAN_SSO_SECRET = 'short';
  assert.equal(verifySsoToken(token), null);
  process.env.CHISHOKAN_SSO_SECRET = SECRET;
  assert.notEqual(verifySsoToken(token), null);
});

console.log(`\n${passed} 件のテストが通りました。`);
