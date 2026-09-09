import assert from 'node:assert/strict';

process.env.ADMIN_ID = 'staff';
process.env.ADMIN_PASSWORD = 'secret-pw';
process.env.ADMIN_ID_CHUTOBU = 'chu-staff';
process.env.ADMIN_PASSWORD_CHUTOBU = 'chu-secret-pw';
process.env.SESSION_SECRET = 'test-secret-key-long-enough-for-signing';

const auth = await import('../lib/auth.js');

let passed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('\n== 管理画面の認証 ==');

test('正しいIDとパスワードなら認証が通る', () => {
  assert.equal(auth.verifyCredentials('red', 'staff', 'secret-pw'), true);
});

test('パスワードが違えば通らない', () => {
  assert.equal(auth.verifyCredentials('red', 'staff', 'wrong'), false);
  assert.equal(auth.verifyCredentials('red', 'staff', ''), false);
  assert.equal(auth.verifyCredentials('red', 'staff', 'secret-pw2'), false);
});

test('IDが違えば通らない', () => {
  assert.equal(auth.verifyCredentials('red', 'other', 'secret-pw'), false);
});

test('環境変数が未設定なら例外になる(認証成功と取り違えない)', () => {
  const saved = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  assert.throws(() => auth.verifyCredentials('red', 'staff', 'secret-pw'), /ADMIN_ID_RED/);
  process.env.ADMIN_PASSWORD = saved;
});

test('部門ごとに別のID・パスワードを使える', () => {
  // 中等部は専用の値、RED部門は共通の値にフォールバックする
  assert.equal(auth.verifyCredentials('chutobu', 'chu-staff', 'chu-secret-pw'), true);
  assert.equal(auth.verifyCredentials('chutobu', 'staff', 'secret-pw'), false);
  assert.equal(auth.verifyCredentials('red', 'staff', 'secret-pw'), true);
  assert.equal(auth.verifyCredentials('red', 'chu-staff', 'chu-secret-pw'), false);
});

test('ある部門のセッションは、別部門では通用しない', () => {
  const redToken = auth.createSessionToken('red');
  const chuToken = auth.createSessionToken('chutobu');
  assert.equal(auth.verifySessionToken(redToken, 'red'), true);
  assert.equal(auth.verifySessionToken(redToken, 'chutobu'), false);
  assert.equal(auth.verifySessionToken(chuToken, 'chutobu'), true);
  assert.equal(auth.verifySessionToken(chuToken, 'red'), false);
});

test('署名鍵が未設定・短すぎる場合はエラーになる', () => {
  const saved = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  assert.throws(() => auth.createSessionToken('red'), /SESSION_SECRET が設定されていません/);
  process.env.SESSION_SECRET = 'short';
  assert.throws(() => auth.createSessionToken('red'), /短すぎます\(5文字\)/);
  process.env.SESSION_SECRET = saved;
  // 十分な長さがあれば通る
  assert.equal(typeof auth.createSessionToken('red'), 'string');
});

test('発行したセッショントークンは検証を通る', () => {
  assert.equal(auth.verifySessionToken(auth.createSessionToken('red'), 'red'), true);
});

test('改ざんされたトークンは弾かれる', () => {
  const token = auth.createSessionToken('red');
  const [payload, sig] = token.split('.');
  assert.equal(auth.verifySessionToken(payload + '.' + sig.slice(0, -1) + 'x', 'red'), false);
  assert.equal(auth.verifySessionToken('deadbeef.' + sig, 'red'), false);
  assert.equal(auth.verifySessionToken('', 'red'), false);
  assert.equal(auth.verifySessionToken('not-a-token', 'red'), false);
  assert.equal(auth.verifySessionToken(undefined, 'red'), false);
});

test('別の秘密鍵で署名されたトークンは弾かれる', () => {
  const token = auth.createSessionToken('red');
  const saved = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'different-secret-also-long-enough-here';
  assert.equal(auth.verifySessionToken(token, 'red'), false);
  process.env.SESSION_SECRET = saved;
});

test('ログインIDを変えると既存セッションは無効になる', () => {
  const token = auth.createSessionToken('red');
  const saved = process.env.ADMIN_ID;
  process.env.ADMIN_ID = 'newstaff';
  assert.equal(auth.verifySessionToken(token, 'red'), false);
  process.env.ADMIN_ID = saved;
});

test('Cookieを解析してログイン状態を判定できる', () => {
  const token = auth.createSessionToken('red');
  const req = { headers: { cookie: `foo=bar; admin_session_red=${token}; baz=qux` } };
  assert.equal(auth.isAuthenticated(req, 'red'), true);
  assert.equal(auth.isAuthenticated({ headers: {} }, 'red'), false);
  assert.equal(auth.isAuthenticated({ headers: { cookie: 'admin_session_red=bogus' } }, 'red'), false);
  // 部門ごとにCookieが分かれているので、片方でログインしても他方は未ログイン
  assert.equal(auth.isAuthenticated(req, 'chutobu'), false);
});

test('セッションCookieはHttpOnly / Secure / SameSite付きで発行される', () => {
  let headerValue;
  const res = { setHeader: (k, v) => { headerValue = v; } };
  auth.setSessionCookie(res, 'red', auth.createSessionToken('red'));
  assert.match(headerValue[0], /^admin_session_red=/);
  assert.match(headerValue[0], /HttpOnly/);
  assert.match(headerValue[0], /Secure/);
  assert.match(headerValue[0], /SameSite=Lax/);
});

console.log(`\n${passed} 件のテストが通りました。`);
