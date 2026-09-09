/**
 * APIハンドラをHTTPサーバーに載せて、実際のリクエストで検証する。
 * Vercelのサーバーレス関数と同じ形(req.query / res.status().json())を再現している。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  fakeClient, resetDb, seedDepartments, seedSchools, seedSlots, seedBookings, dump,
} from './fake-supabase.js';
import { DEPARTMENTS, SCHOOLS } from './fixtures.js';

process.env.TIMEZONE = 'Asia/Tokyo';
process.env.ADMIN_ID = 'staff';
process.env.ADMIN_PASSWORD = 'pw123';
process.env.ADMIN_ID_CHUTOBU = 'chu-staff';
process.env.ADMIN_PASSWORD_CHUTOBU = 'chu-pw123';
process.env.SESSION_SECRET = 'test-secret-long-enough-for-signing';

const { setDbForTesting } = await import('../lib/db.js');
setDbForTesting(fakeClient);

const { clearSchoolCache } = await import('../lib/schools.js');
const { todayStr, addDays } = await import('../lib/format.js');

const routes = {
  '/api/departments': (await import('../api/departments.js')).default,
  '/api/schools': (await import('../api/schools.js')).default,
  '/api/slots': (await import('../api/slots.js')).default,
  '/api/bookings': (await import('../api/bookings.js')).default,
  '/api/admin/auth': (await import('../api/admin/auth.js')).default,
  '/api/admin/slots': (await import('../api/admin/slots.js')).default,
  '/api/admin/bookings': (await import('../api/admin/bookings.js')).default,
  '/api/admin/setup': (await import('../api/admin/setup.js')).default,
  '/api/admin/export-calendar': (await import('../api/admin/export-calendar.js')).default,
  '/api/cron/reminders': (await import('../api/cron/reminders.js')).default,
};

// Vercel の req/res ヘルパーを最小限だけ再現する
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const handler = routes[url.pathname];
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
    return res;
  };
  if (!handler) { res.status(404).json({ ok: false, error: 'not found' }); return; }
  req.query = Object.fromEntries(url.searchParams);
  await handler(req, res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

// ブラウザと同じように、部門ごとのCookieをためて送る
const cookies = new Map();
function cookieHeader() {
  return [...cookies.values()].join('; ');
}
async function call(path, { method = 'GET', body, headers = {}, withCookie = true, raw = false } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(withCookie && cookies.size ? { Cookie: cookieHeader() } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const pair = setCookie.split(';')[0];
    const name = pair.split('=')[0];
    if (/Max-Age=0/.test(setCookie)) cookies.delete(name);
    else cookies.set(name, pair);
  }
  if (raw) return { status: res.status, res, buffer: Buffer.from(await res.arrayBuffer()) };
  return { status: res.status, data: await res.json() };
}

const D1 = addDays(todayStr(), 3);

function setup(slots = [], bookings = []) {
  resetDb();
  clearSchoolCache();
  seedDepartments(DEPARTMENTS);
  seedSchools(SCHOOLS);
  seedSlots(slots.map((s) => ({ school_id: 'hirota', ...s })));
  seedBookings(bookings);
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('\n== 保護者向けAPI ==');
await test('GET /api/schools が7校舎を返す', async () => {
  setup();
  const { status, data } = await call('/api/schools?dept=red');
  assert.equal(status, 200);
  assert.equal(data.schools.length, 7);
  assert.equal(data.schools[0].id, 'hirota');
  // 通知先アドレスは保護者向けAPIに漏らさない
  assert.equal(data.schools[0].notify_email, undefined);
});

await test('GET /api/slots が空き枠を返す', async () => {
  setup([{ date: D1, time: '14:00' }]);
  const { data } = await call('/api/slots?dept=red&schoolId=hirota');
  assert.equal(data.ok, true);
  assert.equal(data.slots.length, 1);
});

await test('GET /api/slots は校舎未指定なら400', async () => {
  const { status, data } = await call('/api/slots?dept=red');
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

await test('POST /api/bookings で予約でき、GETで引ける', async () => {
  setup([{ date: D1, time: '14:00' }]);
  const created = await call('/api/bookings', {
    method: 'POST',
    body: {
      dept: 'red', schoolId: 'hirota', email: 'p@x.jp', date: D1, time: '14:00',
      childName: '花子', parentName: '太郎', grade: '小3',
    },
  });
  assert.equal(created.data.ok, true);
  const mine = await call('/api/bookings?dept=red&email=p%40x.jp');
  assert.equal(mine.data.bookings.length, 1);
  assert.equal(mine.data.bookings[0].childName, '花子');
});

await test('未対応のメソッドは405を返す', async () => {
  const { status } = await call('/api/schools?dept=red', { method: 'POST', body: {} });
  assert.equal(status, 405);
});

console.log('\n== 管理APIの保護 ==');
await test('未ログインでは管理APIが401を返す', async () => {
  for (const path of [
    '/api/admin/slots?dept=red&schoolId=hirota',
    '/api/admin/bookings?dept=red&schoolId=hirota',
    '/api/admin/setup?dept=red',
  ]) {
    const { status, data } = await call(path, { withCookie: false });
    assert.equal(status, 401, path);
    assert.equal(data.needLogin, true);
  }
  const exp = await call('/api/admin/export-calendar', {
    method: 'POST', body: { dept: 'red', schoolId: 'hirota' }, withCookie: false,
  });
  assert.equal(exp.status, 401);
});

await test('パスワードが違うとログインできない', async () => {
  const { status, data } = await call('/api/admin/auth', {
    method: 'POST', body: { dept: 'red', action: 'login', id: 'staff', password: 'wrong' },
  });
  assert.equal(status, 401);
  assert.equal(data.ok, false);
  assert.equal(cookies.size, 0);
});

await test('正しい資格情報でログインするとCookieが発行される', async () => {
  const { status, data } = await call('/api/admin/auth', {
    method: 'POST', body: { dept: 'red', action: 'login', id: 'staff', password: 'pw123' },
  });
  assert.equal(status, 200);
  assert.equal(data.loggedIn, true);
  assert.ok(cookies.has('admin_session_red'));
  const session = await call('/api/admin/auth?dept=red');
  assert.equal(session.data.loggedIn, true);
});

console.log('\n== 管理API(ログイン済み) ==');
await test('GET /api/admin/slots が全枠を返す', async () => {
  setup([{ date: D1, time: '14:00' }]);
  const { data } = await call('/api/admin/slots?dept=red&schoolId=hirota');
  assert.equal(data.ok, true);
  assert.ok(data.slots[0].id > 0);
});

await test('POST /api/admin/slots で枠を追加できる', async () => {
  setup();
  const { data } = await call('/api/admin/slots', {
    method: 'POST',
    body: { dept: 'red', schoolId: 'hirota', slots: [{ date: D1, time: '10:00' }, { date: D1, time: '10:30' }] },
  });
  assert.equal(data.added, 2);
  assert.equal(dump('slots').length, 2);
});

await test('PATCH /api/admin/slots で公開状態を変えられる', async () => {
  setup([{ date: D1, time: '14:00' }]);
  const id = dump('slots')[0].id;
  const { data } = await call('/api/admin/slots', {
    method: 'PATCH', body: { dept: 'red', schoolId: 'hirota', id, published: false },
  });
  assert.equal(data.ok, true);
  assert.equal(dump('slots')[0].published, false);
});

await test('PATCH /api/admin/slots の action=bulkCapacity で一括変更できる', async () => {
  setup([{ date: D1, time: '14:00' }, { date: D1, time: '15:00' }]);
  const ids = dump('slots').map((s) => s.id);
  const { data } = await call('/api/admin/slots', {
    method: 'PATCH', body: { dept: 'red', action: 'bulkCapacity', schoolId: 'hirota', ids, capacity: 2 },
  });
  assert.equal(data.updated, 2);
  assert.equal(dump('slots')[0].capacity, 2);
});

await test('DELETE /api/admin/slots は1件でも複数でも削除できる', async () => {
  setup([{ date: D1, time: '14:00' }, { date: D1, time: '15:00' }, { date: D1, time: '16:00' }]);
  const ids = dump('slots').map((s) => s.id);
  await call('/api/admin/slots', { method: 'DELETE', body: { dept: 'red', schoolId: 'hirota', id: ids[0] } });
  assert.equal(dump('slots').length, 2);
  const { data } = await call('/api/admin/slots', {
    method: 'DELETE', body: { dept: 'red', schoolId: 'hirota', ids: [ids[1], ids[2]] },
  });
  assert.equal(data.deleted, 2);
  assert.equal(dump('slots').length, 0);
});

await test('PATCH /api/admin/bookings で面談記録を保存できる', async () => {
  setup([], [{
    id: 'b1', school_id: 'hirota', date: D1, time: '14:00',
    child_name: 'A', parent_name: 'PA', email: 'a@x.jp',
  }]);
  const { data } = await call('/api/admin/bookings', {
    method: 'PATCH', body: { dept: 'red', schoolId: 'hirota', id: 'b1', interviewDone: true, interviewNote: 'メモ' },
  });
  assert.equal(data.ok, true);
  assert.equal(dump('bookings')[0].interview_done, true);
});

console.log('\n== システム設定 ==');
await test('GET /api/admin/setup が校舎と通知先を返す', async () => {
  setup();
  const { data } = await call('/api/admin/setup?dept=red');
  assert.equal(data.ok, true);
  assert.equal(data.schools.length, 7);
  assert.equal(data.schools[0].notifyEmail, '');
});

await test('通知先を保存できる', async () => {
  setup();
  const { data } = await call('/api/admin/setup', {
    method: 'POST',
    body: {
      dept: 'red',
      action: 'saveNotify',
      notify: [
        { schoolId: 'hirota', email: 'staff@x.jp' },
        { schoolId: 'chutobu_sasebo', email: 'nope@x.jp' }, // 他部門の校舎は無視される
        { schoolId: 'unknown', email: 'nope@x.jp' },        // 未知の校舎も無視される
      ],
    },
  });
  assert.equal(data.saved, 1);
  assert.equal(dump('schools').find((s) => s.id === 'hirota').notify_email, 'staff@x.jp');
});

await test('接続確認が件数を返す', async () => {
  setup([{ date: D1, time: '14:00' }], [{
    id: 'b1', school_id: 'hirota', date: D1, time: '14:00',
    child_name: 'A', parent_name: 'PA', email: 'a@x.jp', status: 'cancelled',
  }]);
  const { data } = await call('/api/admin/setup', { method: 'POST', body: { dept: 'red', action: 'status' } });
  assert.equal(data.ok, true);
  assert.equal(data.schools, 7);
  assert.equal(data.slots, 1);
  assert.equal(data.bookings, 1);
  assert.equal(data.activeBookings, 0);
});

await test('不明な action は400を返す', async () => {
  const { status } = await call('/api/admin/setup', { method: 'POST', body: { dept: 'red', action: 'nope' } });
  assert.equal(status, 400);
});

console.log('\n== カレンダー出力 ==');
await test('Excelファイルがダウンロードできる', async () => {
  setup([], [{
    id: 'b1', school_id: 'hirota', date: D1, time: '14:00',
    child_name: '花子', parent_name: '太郎', email: 'a@x.jp', grade: '小3',
  }]);
  const month = D1.slice(0, 7);
  const { status, res, buffer } = await call('/api/admin/export-calendar', {
    method: 'POST',
    body: { dept: 'red', schoolId: 'hirota', startDate: month + '-01', endDate: month + '-28' },
    raw: true,
  });
  assert.equal(status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml\.sheet/);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  assert.equal(res.headers.get('x-booking-count'), '1');
  // xlsx は ZIP 形式なので PK で始まる
  assert.equal(buffer.slice(0, 2).toString(), 'PK');
  assert.ok(buffer.length > 1000);
});

await test('期間が逆ならJSONでエラーを返す', async () => {
  setup();
  const { data } = await call('/api/admin/export-calendar', {
    method: 'POST', body: { dept: 'red', schoolId: 'hirota', startDate: '2026-09-30', endDate: '2026-09-01' },
  });
  assert.equal(data.ok, false);
  assert.match(data.error, /開始日が終了日より後/);
});

await test('ログアウトすると管理APIが再び401になる', async () => {
  await call('/api/admin/auth', { method: 'POST', body: { dept: 'red', action: 'logout' } });
  cookies.clear();
  const { status } = await call('/api/admin/slots?dept=red&schoolId=hirota');
  assert.equal(status, 401);
});

console.log('\n== 部門の分離 ==');
await test('GET /api/departments が両部門を返す', async () => {
  setup();
  const { data } = await call('/api/departments');
  assert.equal(data.ok, true);
  assert.deepEqual(data.departments.map((d) => d.slug), ['red', 'chutobu']);
  assert.equal(data.departments[1].name, '中等部');
});

await test('部門を指定しないと400、知らない部門なら404', async () => {
  setup();
  assert.equal((await call('/api/schools')).status, 400);
  assert.equal((await call('/api/schools?dept=nope')).status, 404);
});

await test('部門ごとに違う校舎・学年が返る', async () => {
  setup();
  const red = await call('/api/schools?dept=red');
  assert.equal(red.data.department.name, 'RED部門');
  assert.equal(red.data.schools.length, 7);
  assert.ok(red.data.department.grades.includes('小学1年'));

  const chu = await call('/api/schools?dept=chutobu');
  assert.equal(chu.data.department.name, '中等部');
  assert.deepEqual(chu.data.schools.map((s) => s.name),
    ['佐世保駅前校', '日野校', '大野校', '日宇校', '県立中受検対策コース']);
  // 中等部の学年に小学1年は無い
  assert.ok(!chu.data.department.grades.includes('小学1年'));
});

await test('RED部門のログインでは中等部の管理APIを使えない', async () => {
  setup();
  cookies.clear();
  // RED部門にログインする
  const login = await call('/api/admin/auth', {
    method: 'POST', body: { dept: 'red', action: 'login', id: 'staff', password: 'pw123' },
  });
  assert.equal(login.data.loggedIn, true);
  // 自部門は使える
  assert.equal((await call('/api/admin/slots?dept=red&schoolId=hirota')).status, 200);
  // 中等部は401
  const other = await call('/api/admin/slots?dept=chutobu&schoolId=chutobu_sasebo');
  assert.equal(other.status, 401);
  assert.equal(other.data.needLogin, true);
  // 中等部のログイン状態も未ログインのまま
  const session = await call('/api/admin/auth?dept=chutobu');
  assert.equal(session.data.loggedIn, false);
});

await test('中等部には中等部のID・パスワードでログインする', async () => {
  setup();
  cookies.clear();
  const wrong = await call('/api/admin/auth', {
    method: 'POST', body: { dept: 'chutobu', action: 'login', id: 'staff', password: 'pw123' },
  });
  assert.equal(wrong.status, 401);
  const ok = await call('/api/admin/auth', {
    method: 'POST', body: { dept: 'chutobu', action: 'login', id: 'chu-staff', password: 'chu-pw123' },
  });
  assert.equal(ok.data.loggedIn, true);
  assert.ok(cookies.has('admin_session_chutobu'));
});

await test('両部門に同時にログインしていられる', async () => {
  setup();
  cookies.clear();
  await call('/api/admin/auth', {
    method: 'POST', body: { dept: 'red', action: 'login', id: 'staff', password: 'pw123' },
  });
  await call('/api/admin/auth', {
    method: 'POST', body: { dept: 'chutobu', action: 'login', id: 'chu-staff', password: 'chu-pw123' },
  });
  assert.equal((await call('/api/admin/auth?dept=red')).data.loggedIn, true);
  assert.equal((await call('/api/admin/auth?dept=chutobu')).data.loggedIn, true);
  // 片方からログアウトしても、もう片方は残る
  await call('/api/admin/auth', { method: 'POST', body: { dept: 'red', action: 'logout' } });
  assert.equal((await call('/api/admin/auth?dept=red')).data.loggedIn, false);
  assert.equal((await call('/api/admin/auth?dept=chutobu')).data.loggedIn, true);
});

await test('中等部の職員は自部門の予約だけを見る', async () => {
  setup([], [
    { id: 'r1', school_id: 'hirota', date: D1, time: '14:00',
      child_name: 'RED生徒', parent_name: 'P', email: 'a@x.jp' },
    { id: 'c1', school_id: 'chutobu_sasebo', date: D1, time: '14:00',
      child_name: '中等部生徒', parent_name: 'P', email: 'a@x.jp' },
  ]);
  cookies.clear();
  await call('/api/admin/auth', {
    method: 'POST', body: { dept: 'chutobu', action: 'login', id: 'chu-staff', password: 'chu-pw123' },
  });
  const list = await call('/api/admin/bookings?dept=chutobu&schoolId=chutobu_sasebo');
  assert.deepEqual(list.data.bookings.map((b) => b.childName), ['中等部生徒']);
  // RED部門の校舎IDを指定しても、中等部のログインでは見られない
  const cross = await call('/api/admin/bookings?dept=chutobu&schoolId=hirota');
  assert.deepEqual(cross.data.bookings, []);
});

await test('保護者も同じメールで部門ごとに分かれて見える', async () => {
  setup([], [
    { id: 'r1', school_id: 'hirota', date: D1, time: '14:00',
      child_name: 'RED生徒', parent_name: 'P', email: 'same@x.jp' },
    { id: 'c1', school_id: 'chutobu_sasebo', date: D1, time: '15:00',
      child_name: '中等部生徒', parent_name: 'P', email: 'same@x.jp' },
  ]);
  const red = await call('/api/bookings?dept=red&email=same%40x.jp');
  assert.deepEqual(red.data.bookings.map((b) => b.childName), ['RED生徒']);
  const chu = await call('/api/bookings?dept=chutobu&email=same%40x.jp');
  assert.deepEqual(chu.data.bookings.map((b) => b.childName), ['中等部生徒']);
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
