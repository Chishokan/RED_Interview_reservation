import assert from 'node:assert/strict';

process.env.ADMIN_ID = 'staff';
process.env.ADMIN_PASSWORD = 'secret-pw';
process.env.SESSION_SECRET = 'test-secret-key-long-enough-for-signing';

const auth = await import('../lib/auth.js');

let passed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('\n== 管理画面の認証 ==');

test('正しいIDとパスワードなら認証が通る', () => {
  assert.equal(auth.verifyCredentials('staff', 'secret-pw'), true);
});

test('パスワードが違えば通らない', () => {
  assert.equal(auth.verifyCredentials('staff', 'wrong'), false);
  assert.equal(auth.verifyCredentials('staff', ''), false);
  assert.equal(auth.verifyCredentials('staff', 'secret-pw2'), false);
});

test('IDが違えば通らない', () => {
  assert.equal(auth.verifyCredentials('other', 'secret-pw'), false);
});

test('環境変数が未設定なら例外になる(認証成功と取り違えない)', () => {
  const saved = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  assert.throws(() => auth.verifyCredentials('staff', 'secret-pw'), /ADMIN_ID と ADMIN_PASSWORD/);
  process.env.ADMIN_PASSWORD = saved;
});

test('署名鍵が未設定・短すぎる場合はエラーになる', () => {
  const saved = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  assert.throws(() => auth.createSessionToken(), /SESSION_SECRET が設定されていません/);
  process.env.SESSION_SECRET = 'short';
  assert.throws(() => auth.createSessionToken(), /短すぎます\(5文字\)/);
  process.env.SESSION_SECRET = saved;
  // 十分な長さがあれば通る
  assert.equal(typeof auth.createSessionToken(), 'string');
});

test('発行したセッショントークンは検証を通る', () => {
  assert.equal(auth.verifySessionToken(auth.createSessionToken()), true);
});

test('改ざんされたトークンは弾かれる', () => {
  const token = auth.createSessionToken();
  const [payload, sig] = token.split('.');
  assert.equal(auth.verifySessionToken(payload + '.' + sig.slice(0, -1) + 'x'), false);
  assert.equal(auth.verifySessionToken('deadbeef.' + sig), false);
  assert.equal(auth.verifySessionToken(''), false);
  assert.equal(auth.verifySessionToken('not-a-token'), false);
  assert.equal(auth.verifySessionToken(undefined), false);
});

test('別の秘密鍵で署名されたトークンは弾かれる', () => {
  const token = auth.createSessionToken();
  const saved = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'different-secret-also-long-enough-here';
  assert.equal(auth.verifySessionToken(token), false);
  process.env.SESSION_SECRET = saved;
});

test('ログインIDを変えると既存セッションは無効になる', () => {
  const token = auth.createSessionToken();
  const saved = process.env.ADMIN_ID;
  process.env.ADMIN_ID = 'newstaff';
  assert.equal(auth.verifySessionToken(token), false);
  process.env.ADMIN_ID = saved;
});

test('Cookieを解析してログイン状態を判定できる', () => {
  const token = auth.createSessionToken();
  const req = { headers: { cookie: `foo=bar; admin_session=${token}; baz=qux` } };
  assert.equal(auth.isAuthenticated(req), true);
  assert.equal(auth.isAuthenticated({ headers: {} }), false);
  assert.equal(auth.isAuthenticated({ headers: { cookie: 'admin_session=bogus' } }), false);
});

test('セッションCookieはHttpOnly / Secure / SameSite付きで発行される', () => {
  let headerValue;
  const res = { setHeader: (k, v) => { headerValue = v; } };
  auth.setSessionCookie(res, auth.createSessionToken());
  assert.match(headerValue[0], /HttpOnly/);
  assert.match(headerValue[0], /Secure/);
  assert.match(headerValue[0], /SameSite=Lax/);
});

console.log(`\n${passed} 件のテストが通りました。`);
