/**
 * APIハンドラをHTTPサーバーに載せて、実際のリクエストで検証する。
 * Vercelのサーバーレス関数と同じ形(req.query / res.status().json())を再現している。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { installFakes, resetStore, addSheet, dumpSheet } from './fake-sheets.js';

process.env.SPREADSHEET_ID = 'test-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'x@y.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY = 'fake';
process.env.TIMEZONE = 'Asia/Tokyo';
process.env.ADMIN_ID = 'staff';
process.env.ADMIN_PASSWORD = 'pw123';
process.env.SESSION_SECRET = 'test-secret';
installFakes();

const { SLOT_HEADERS, BOOKING_HEADERS } = await import('../lib/schools.js');
const { todayStr, addDays } = await import('../lib/format.js');
const { invalidateMetaCache } = await import('../lib/sheets.js');

const routes = {
  '/api/schools': (await import('../api/schools.js')).default,
  '/api/slots': (await import('../api/slots.js')).default,
  '/api/bookings': (await import('../api/bookings.js')).default,
  '/api/admin/auth': (await import('../api/admin/auth.js')).default,
  '/api/admin/slots': (await import('../api/admin/slots.js')).default,
  '/api/admin/bookings': (await import('../api/admin/bookings.js')).default,
  '/api/admin/setup': (await import('../api/admin/setup.js')).default,
  '/api/cron/reminders': (await import('../api/cron/reminders.js')).default,
};

// Vercel の req/res ヘルパーを最小限だけ再現する
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const handler = routes[url.pathname];
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return res; };
  if (!handler) { res.status(404).json({ ok: false, error: 'not found' }); return; }
  req.query = Object.fromEntries(url.searchParams);
  await handler(req, res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

let cookie = '';
async function call(path, { method = 'GET', body, headers = {}, withCookie = true } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(withCookie && cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: res.status, data: await res.json() };
}

const SLOTS = 'RED広田教室予約枠';
const BOOKINGS = 'RED広田教室予約データ';
const D1 = addDays(todayStr(), 3);

function setup(slotRows = [], bookingRows = []) {
  resetStore();
  invalidateMetaCache();
  addSheet(SLOTS, [SLOT_HEADERS, ...slotRows]);
  addSheet(BOOKINGS, [BOOKING_HEADERS, ...bookingRows]);
  for (const n of ['RED京町教室', 'RED日野教室', 'RED佐々教室', 'RED西海大島教室', 'RED大野教室', 'ネクスタ']) {
    addSheet(n + '予約枠', [SLOT_HEADERS]);
    addSheet(n + '予約データ', [BOOKING_HEADERS]);
  }
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('\n== 保護者向けAPI ==');
await test('GET /api/schools が7校舎を返す', async () => {
  const { status, data } = await call('/api/schools');
  assert.equal(status, 200);
  assert.equal(data.schools.length, 7);
  assert.equal(data.schools[0].id, 'hirota');
});

await test('GET /api/slots が空き枠を返す', async () => {
  setup([[D1, '14:00', '', true, 1]]);
  const { data } = await call('/api/slots?schoolId=hirota');
  assert.equal(data.ok, true);
  assert.equal(data.slots.length, 1);
});

await test('GET /api/slots は校舎未指定なら400', async () => {
  const { status, data } = await call('/api/slots');
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

await test('POST /api/bookings で予約でき、GETで引ける', async () => {
  setup([[D1, '14:00', '', true, 1]]);
  const created = await call('/api/bookings', {
    method: 'POST',
    body: { schoolId: 'hirota', email: 'p@x.jp', date: D1, time: '14:00', childName: '花子', parentName: '太郎', grade: '小3' },
  });
  assert.equal(created.data.ok, true);
  const mine = await call('/api/bookings?email=p%40x.jp');
  assert.equal(mine.data.bookings.length, 1);
  assert.equal(mine.data.bookings[0].childName, '花子');
});

await test('未対応のメソッドは405を返す', async () => {
  const { status } = await call('/api/schools', { method: 'POST', body: {} });
  assert.equal(status, 405);
});

console.log('\n== 管理APIの保護 ==');
await test('未ログインでは管理APIが401を返す', async () => {
  for (const path of ['/api/admin/slots?schoolId=hirota', '/api/admin/bookings?schoolId=hirota']) {
    const { status, data } = await call(path, { withCookie: false });
    assert.equal(status, 401, path);
    assert.equal(data.needLogin, true);
  }
  const setupRes = await call('/api/admin/setup', { method: 'POST', body: { action: 'init' }, withCookie: false });
  assert.equal(setupRes.status, 401);
});

await test('パスワードが違うとログインできない', async () => {
  const { status, data } = await call('/api/admin/auth', {
    method: 'POST', body: { action: 'login', id: 'staff', password: 'wrong' },
  });
  assert.equal(status, 401);
  assert.equal(data.ok, false);
  assert.equal(cookie, '');
});

await test('正しい資格情報でログインするとCookieが発行される', async () => {
  const { status, data } = await call('/api/admin/auth', {
    method: 'POST', body: { action: 'login', id: 'staff', password: 'pw123' },
  });
  assert.equal(status, 200);
  assert.equal(data.loggedIn, true);
  assert.match(cookie, /^admin_session=/);
  const session = await call('/api/admin/auth');
  assert.equal(session.data.loggedIn, true);
});

console.log('\n== 管理API(ログイン済み) ==');
await test('GET /api/admin/slots が全枠を返す', async () => {
  setup([[D1, '14:00', '', true, 1]]);
  const { data } = await call('/api/admin/slots?schoolId=hirota');
  assert.equal(data.ok, true);
  assert.equal(data.slots[0].rowNum, 2);
});

await test('POST /api/admin/slots で枠を追加できる', async () => {
  setup([]);
  const { data } = await call('/api/admin/slots', {
    method: 'POST', body: { schoolId: 'hirota', slots: [{ date: D1, time: '10:00' }, { date: D1, time: '10:30' }] },
  });
  assert.equal(data.added, 2);
  assert.equal(dumpSheet(SLOTS).length, 3);
});

await test('PATCH /api/admin/slots で公開状態を変えられる', async () => {
  setup([[D1, '14:00', '', true, 1]]);
  const { data } = await call('/api/admin/slots', {
    method: 'PATCH', body: { schoolId: 'hirota', rowNum: 2, published: false },
  });
  assert.equal(data.ok, true);
  assert.equal(dumpSheet(SLOTS)[1][3], false);
});

await test('PATCH /api/admin/slots の action=bulkCapacity で一括変更できる', async () => {
  setup([[D1, '14:00', '', true, 1], [D1, '15:00', '', true, 1]]);
  const { data } = await call('/api/admin/slots', {
    method: 'PATCH', body: { action: 'bulkCapacity', schoolId: 'hirota', rowNums: [2, 3], capacity: 2 },
  });
  assert.equal(data.updated, 2);
  assert.equal(dumpSheet(SLOTS)[1][4], 2);
});

await test('DELETE /api/admin/slots は1件でも複数でも削除できる', async () => {
  setup([[D1, '14:00', '', true, 1], [D1, '15:00', '', true, 1], [D1, '16:00', '', true, 1]]);
  await call('/api/admin/slots', { method: 'DELETE', body: { schoolId: 'hirota', rowNum: 2 } });
  assert.equal(dumpSheet(SLOTS).length, 3);
  const { data } = await call('/api/admin/slots', {
    method: 'DELETE', body: { schoolId: 'hirota', rowNums: [2, 3] },
  });
  assert.equal(data.deleted, 2);
  assert.equal(dumpSheet(SLOTS).length, 1);
});

await test('PATCH /api/admin/bookings で面談記録を保存できる', async () => {
  setup([], [['b1', D1, '14:00', 'A', 'PA', 'a@x.jp', '小1', '', 'confirmed', '', '', '', false, '', '']]);
  const { data } = await call('/api/admin/bookings', {
    method: 'PATCH', body: { schoolId: 'hirota', id: 'b1', interviewDone: true, interviewNote: 'メモ' },
  });
  assert.equal(data.ok, true);
  assert.equal(dumpSheet(BOOKINGS)[1][12], true);
});

await test('POST /api/admin/setup の init でシートを用意できる', async () => {
  resetStore();
  invalidateMetaCache();
  const { data } = await call('/api/admin/setup', { method: 'POST', body: { action: 'init' } });
  assert.equal(data.ok, true);
  assert.equal(data.created.length, 14); // 7校舎 × 2シート
  assert.deepEqual(dumpSheet(SLOTS)[0], SLOT_HEADERS);
  assert.deepEqual(dumpSheet(BOOKINGS)[0], BOOKING_HEADERS);
});

await test('init を2回実行しても既存データは消えない', async () => {
  setup([[D1, '14:00', '', true, 1]], [['b1', D1, '14:00', 'A', 'PA', 'a@x.jp', '', '', 'confirmed', '', '', '', false, '', '']]);
  const { data } = await call('/api/admin/setup', { method: 'POST', body: { action: 'init' } });
  assert.equal(data.created.length, 0);
  assert.equal(dumpSheet(SLOTS).length, 2);
  assert.equal(dumpSheet(BOOKINGS)[1][0], 'b1');
});

await test('GAS時代の古いシート(列が足りない)に見出しを補える', async () => {
  // 職員メモ・リマインド送信済・面談記録の列がまだ無い、10列だけのシート
  const oldHeaders = BOOKING_HEADERS.slice(0, 10);
  resetStore();
  invalidateMetaCache();
  addSheet(SLOTS, [SLOT_HEADERS.slice(0, 4), [D1, '14:00', '', true]]);   // 定員列なし
  addSheet(BOOKINGS, [oldHeaders, ['b1', D1, '14:00', 'A', 'PA', 'a@x.jp', '小1', '', 'confirmed', '2026-01-01 10:00']]);

  const { data } = await call('/api/admin/setup', { method: 'POST', body: { action: 'init' } });
  assert.equal(data.ok, true);
  assert.ok(data.headerUpdated.includes(BOOKINGS));
  assert.ok(data.headerUpdated.includes(SLOTS));
  // 見出しが15列すべて揃い、既存の予約データは残っている
  assert.deepEqual(dumpSheet(BOOKINGS)[0], BOOKING_HEADERS);
  assert.deepEqual(dumpSheet(SLOTS)[0], SLOT_HEADERS);
  assert.equal(dumpSheet(BOOKINGS)[1][0], 'b1');
  assert.equal(dumpSheet(BOOKINGS)[1][3], 'A');
});

await test('定員列が空の古い枠は定員1として扱われる', async () => {
  resetStore();
  invalidateMetaCache();
  addSheet(SLOTS, [SLOT_HEADERS, [D1, '14:00', '', true]]);  // 定員セルが空
  addSheet(BOOKINGS, [BOOKING_HEADERS]);
  const { data } = await call('/api/slots?schoolId=hirota');
  assert.equal(data.slots[0].capacity, 1);
  assert.equal(data.slots[0].remaining, 1);
});

await test('不明な action は400を返す', async () => {
  const { status } = await call('/api/admin/setup', { method: 'POST', body: { action: 'nope' } });
  assert.equal(status, 400);
});

await test('ログアウトすると管理APIが再び401になる', async () => {
  await call('/api/admin/auth', { method: 'POST', body: { action: 'logout' } });
  cookie = '';
  const { status } = await call('/api/admin/slots?schoolId=hirota');
  assert.equal(status, 401);
});

console.log('\n== Cron ==');
await test('CRON_SECRET があれば認証なしのリマインド実行は401', async () => {
  process.env.CRON_SECRET = 'cron-secret';
  setup();
  const { status } = await call('/api/cron/reminders');
  assert.equal(status, 401);
  const ok = await call('/api/cron/reminders', { headers: { Authorization: 'Bearer cron-secret' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.ok, true);
  delete process.env.CRON_SECRET;
});

server.close();
console.log(`\n${passed} 件のテストが通りました。`);
