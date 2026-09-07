import assert from 'node:assert/strict';
import { fakeClient, resetDb, seedSchools, seedSlots, seedBookings, dump } from './fake-supabase.js';

process.env.TIMEZONE = 'Asia/Tokyo';

const { setDbForTesting } = await import('../lib/db.js');
setDbForTesting(fakeClient);

const store = await import('../lib/store.js');
const { DEFAULT_SCHOOLS, clearSchoolCache } = await import('../lib/schools.js');
const { todayStr, addDays } = await import('../lib/format.js');

const D1 = addDays(todayStr(), 3);   // 未来の日付
const PAST = addDays(todayStr(), -3);

function booking(id, over = {}) {
  return {
    id,
    school_id: 'hirota',
    date: D1,
    time: '14:00',
    child_name: '子A',
    parent_name: '親A',
    email: 'a@x.jp',
    grade: '小1',
    ...over,
  };
}

function setup(slots = [], bookings = []) {
  resetDb();
  clearSchoolCache();
  seedSchools(DEFAULT_SCHOOLS);
  seedSlots(slots.map((s) => ({ school_id: 'hirota', ...s })));
  seedBookings(bookings);
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('\n== 予約枠の取得 ==');
await test('公開中で空きのある枠が返る', async () => {
  setup([{ date: D1, time: '14:00' }, { date: D1, time: '14:30', capacity: 2 }]);
  const slots = await store.getAvailableSlots('hirota');
  assert.equal(slots.length, 2);
  assert.equal(slots[0].date, D1);
  assert.equal(slots[0].time, '14:00');
  assert.equal(slots[0].remaining, 1);
  assert.equal(slots[1].remaining, 2);
});

await test('非公開の枠は返らない', async () => {
  setup([{ date: D1, time: '14:00', published: false }, { date: D1, time: '15:00' }]);
  const slots = await store.getAvailableSlots('hirota');
  assert.deepEqual(slots.map((s) => s.time), ['15:00']);
});

await test('過去の枠は返らない', async () => {
  setup([{ date: PAST, time: '14:00' }, { date: D1, time: '15:00' }]);
  const slots = await store.getAvailableSlots('hirota');
  assert.deepEqual(slots.map((s) => s.time), ['15:00']);
});

await test('定員に達した枠は返らず、空きがあれば残数が出る', async () => {
  setup(
    [{ date: D1, time: '14:00' }, { date: D1, time: '15:00', capacity: 2 }],
    [booking('b1'), booking('b2', { time: '15:00' })]
  );
  const slots = await store.getAvailableSlots('hirota');
  assert.deepEqual(slots.map((s) => s.time), ['15:00']);
  assert.equal(slots[0].remaining, 1);
});

await test('キャンセル済みの予約は定員に数えない', async () => {
  setup([{ date: D1, time: '14:00' }], [booking('b1', { status: 'cancelled' })]);
  assert.equal((await store.getAvailableSlots('hirota')).length, 1);
});

await test("DBの時刻表記 '14:00:00' を 'HH:MM' に揃えて返す", async () => {
  setup([{ date: D1, time: '14:00:00' }]);
  assert.equal((await store.getAvailableSlots('hirota'))[0].time, '14:00');
});

console.log('\n== 予約の作成 ==');
await test('予約が作成され、DBに1件入る', async () => {
  setup([{ date: D1, time: '14:00' }]);
  const res = await store.createBooking({
    schoolId: 'hirota', email: 'p@x.jp', date: D1, time: '14:00',
    childName: '花子', parentName: '太郎', grade: '小3', note: 'よろしく',
  });
  assert.equal(res.ok, true);
  const rows = dump('bookings');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].child_name, '花子');
  assert.equal(rows[0].status, 'confirmed');
  assert.equal(res.booking.schoolName, 'RED広田教室');
});

await test('定員が埋まっている枠は予約できない', async () => {
  setup([{ date: D1, time: '14:00' }], [booking('b1')]);
  const res = await store.createBooking({
    schoolId: 'hirota', email: 'p@x.jp', date: D1, time: '14:00',
    childName: '花子', parentName: '太郎',
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /すでに予約されている/);
});

await test('非公開の枠は予約できない', async () => {
  setup([{ date: D1, time: '14:00', published: false }]);
  const res = await store.createBooking({
    schoolId: 'hirota', email: 'p@x.jp', date: D1, time: '14:00',
    childName: '花子', parentName: '太郎',
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /公開されていません/);
});

await test('存在しない枠は予約できない', async () => {
  setup([{ date: D1, time: '14:00' }]);
  const res = await store.createBooking({
    schoolId: 'hirota', email: 'p@x.jp', date: D1, time: '23:00',
    childName: '花子', parentName: '太郎',
  });
  assert.equal(res.ok, false);
});

await test('過去の枠はサーバー側でも拒否する', async () => {
  setup([{ date: PAST, time: '14:00' }]);
  const res = await store.createBooking({
    schoolId: 'hirota', email: 'p@x.jp', date: PAST, time: '14:00',
    childName: '花子', parentName: '太郎',
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /受付時間/);
});

await test('必須項目が欠けていればエラー', async () => {
  setup([{ date: D1, time: '14:00' }]);
  const res = await store.createBooking({ schoolId: 'hirota', date: D1, time: '14:00' });
  assert.equal(res.ok, false);
  assert.match(res.error, /パラメータが不足/);
});

await test('定員2の枠には2件まで予約できる', async () => {
  setup([{ date: D1, time: '14:00', capacity: 2 }]);
  const mk = (email, name) => store.createBooking({
    schoolId: 'hirota', email, date: D1, time: '14:00', childName: name, parentName: 'P',
  });
  assert.equal((await mk('a@x.jp', 'A')).ok, true);
  assert.equal((await mk('b@x.jp', 'B')).ok, true);
  assert.equal((await mk('c@x.jp', 'C')).ok, false);
});

await test('同時に来た予約でも定員を超えない', async () => {
  setup([{ date: D1, time: '14:00' }]);
  const results = await Promise.all(
    ['a', 'b', 'c', 'd'].map((n) =>
      store.createBooking({
        schoolId: 'hirota', email: `${n}@x.jp`, date: D1, time: '14:00',
        childName: n, parentName: 'P',
      })
    )
  );
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(dump('bookings').filter((b) => b.status !== 'cancelled').length, 1);
});

console.log('\n== 保護者の予約照会・変更 ==');
await test('メールアドレスで自分の予約を引ける(大文字小文字を無視)', async () => {
  setup([], [booking('b1', { email: 'Parent@X.jp' })]);
  const list = await store.getMyBookings('parent@x.jp');
  assert.equal(list.length, 1);
  assert.equal(list[0].schoolName, 'RED広田教室');
  assert.equal(list[0].childName, '子A');
});

await test('別人のメールでは引けない', async () => {
  setup([], [booking('b1')]);
  assert.equal((await store.getMyBookings('other@x.jp')).length, 0);
});

await test('全校舎を横断して引ける', async () => {
  setup([], [booking('b1'), booking('b2', { school_id: 'nexta', time: '15:00' })]);
  const list = await store.getMyBookings('a@x.jp');
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((b) => b.schoolName).sort(), ['RED広田教室', 'ネクスタ']);
});

await test('本人ならキャンセルできる / 他人はできない', async () => {
  setup([], [booking('b1')]);
  assert.equal((await store.cancelBooking({ schoolId: 'hirota', email: 'nope@x.jp', id: 'b1' })).ok, false);
  assert.equal((await store.cancelBooking({ schoolId: 'hirota', email: 'a@x.jp', id: 'b1' })).ok, true);
  assert.equal(dump('bookings')[0].status, 'cancelled');
});

console.log('\n== 管理画面: 枠 ==');
await test('全枠が予約者情報つきで返る', async () => {
  setup(
    [{ date: D1, time: '14:00', capacity: 2 }, { date: PAST, time: '10:00', label: 'ラベル', published: false }],
    [booking('b1')]
  );
  const slots = await store.getAllSlots('hirota');
  assert.equal(slots.length, 2);
  const past = slots.find((s) => s.date === PAST);
  assert.equal(past.isPast, true);
  assert.equal(past.published, false);
  assert.equal(past.label, 'ラベル');
  const future = slots.find((s) => s.date === D1);
  assert.equal(future.booked, 1);
  assert.equal(future.capacity, 2);
  assert.equal(future.bookings[0].childName, '子A');
  assert.ok(future.id > 0);
});

await test('枠を追加でき、重複はスキップされる', async () => {
  setup([{ date: D1, time: '14:00' }]);
  const res = await store.adminAddSlots({
    schoolId: 'hirota',
    slots: [{ date: D1, time: '14:00' }, { date: D1, time: '16:00' }, { date: D1, time: '16:30', capacity: 2 }],
  });
  assert.deepEqual([res.added, res.skipped], [2, 1]);
  const rows = dump('slots');
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.time === '16:30').capacity, 2);
});

await test('公開/非公開と定員を切り替えられる', async () => {
  setup([{ date: D1, time: '14:00' }]);
  const id = dump('slots')[0].id;
  assert.equal((await store.adminUpdateSlot({ schoolId: 'hirota', id, published: false })).ok, true);
  assert.equal(dump('slots')[0].published, false);
  assert.equal((await store.adminUpdateSlot({ schoolId: 'hirota', id, capacity: 2 })).ok, true);
  assert.equal(dump('slots')[0].capacity, 2);
});

await test('予約数より少ない定員には変更できない', async () => {
  setup([{ date: D1, time: '14:00', capacity: 2 }], [booking('b1'), booking('b2')]);
  const id = dump('slots')[0].id;
  const res = await store.adminUpdateSlot({ schoolId: 'hirota', id, capacity: 1 });
  assert.equal(res.ok, false);
  assert.match(res.error, /2件の予約/);
  assert.equal(dump('slots')[0].capacity, 2);
});

await test('他校舎の枠は更新できない', async () => {
  setup([{ date: D1, time: '14:00' }]);
  const id = dump('slots')[0].id;
  const res = await store.adminUpdateSlot({ schoolId: 'nexta', id, published: false });
  assert.equal(res.ok, false);
  assert.equal(dump('slots')[0].published, true);
});

await test('枠の一括削除は予約済みをスキップする', async () => {
  setup(
    [{ date: D1, time: '14:00' }, { date: D1, time: '15:00' }, { date: D1, time: '16:00' }],
    [booking('b1', { time: '15:00' })]
  );
  const ids = dump('slots').map((s) => s.id);
  const res = await store.adminDeleteSlots({ schoolId: 'hirota', ids });
  assert.deepEqual([res.deleted, res.skippedBooked], [2, 1]);
  const rows = dump('slots');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].time, '15:00'); // 予約済みの枠だけが残る
});

await test('他校舎の枠は削除できない', async () => {
  setup([{ date: D1, time: '14:00' }]);
  const ids = dump('slots').map((s) => s.id);
  const res = await store.adminDeleteSlots({ schoolId: 'nexta', ids });
  assert.equal(res.deleted, 0);
  assert.equal(dump('slots').length, 1);
});

await test('1件削除は、予約が入っていれば断る', async () => {
  setup([{ date: D1, time: '14:00' }], [booking('b1')]);
  const id = dump('slots')[0].id;
  const res = await store.adminDeleteSlot({ schoolId: 'hirota', id });
  assert.equal(res.ok, false);
  assert.equal(dump('slots').length, 1);
});

await test('定員の一括変更(予約数を下回る枠はスキップ)', async () => {
  setup(
    [{ date: D1, time: '14:00' }, { date: D1, time: '15:00', capacity: 2 }],
    [booking('b1', { time: '15:00' }), booking('b2', { time: '15:00' })]
  );
  const ids = dump('slots').map((s) => s.id);
  const res = await store.adminBulkUpdateCapacity({ schoolId: 'hirota', ids, capacity: 1 });
  assert.deepEqual([res.updated, res.skipped], [1, 1]);
  assert.equal(res.skipReasons.length, 1);
});

console.log('\n== 管理画面: 予約 ==');
await test('予約の部分更新(担当メモ・面談記録)ができる', async () => {
  setup([], [booking('b1')]);
  assert.equal((await store.adminUpdateBooking({ schoolId: 'hirota', id: 'b1', staffNote: '田中' })).ok, true);
  assert.equal((await store.adminUpdateBooking({
    schoolId: 'hirota', id: 'b1', interviewNote: '進路の相談', interviewDone: true,
  })).ok, true);
  const row = dump('bookings')[0];
  assert.equal(row.staff_note, '田中');
  assert.equal(row.interview_done, true);
  assert.equal(row.interview_note, '進路の相談');
  assert.ok(row.interview_updated_at);
  // 他の項目は書き換わっていない
  assert.equal(row.child_name, '子A');
  assert.equal(row.status, 'confirmed');
});

await test('日時変更は、他の予約と衝突するとエラー', async () => {
  setup([], [booking('b1'), booking('b2', { time: '15:00' })]);
  const res = await store.adminUpdateBooking({ schoolId: 'hirota', id: 'b1', date: D1, time: '15:00' });
  assert.equal(res.ok, false);
  const ok = await store.adminUpdateBooking({ schoolId: 'hirota', id: 'b1', date: D1, time: '16:00' });
  assert.equal(ok.ok, true);
  assert.equal(dump('bookings').find((b) => b.id === 'b1').time, '16:00');
});

await test('キャンセル済みの予約がある枠へは移動できる', async () => {
  setup([], [booking('b1'), booking('b2', { time: '15:00', status: 'cancelled' })]);
  const res = await store.adminUpdateBooking({ schoolId: 'hirota', id: 'b1', date: D1, time: '15:00' });
  assert.equal(res.ok, true);
});

await test('職員は予約をキャンセルできる', async () => {
  setup([], [booking('b1')]);
  assert.equal((await store.adminCancelBooking({ schoolId: 'hirota', id: 'b1' })).ok, true);
  assert.equal(dump('bookings')[0].status, 'cancelled');
});

await test('他校舎からは予約を操作できない', async () => {
  setup([], [booking('b1')]);
  assert.equal((await store.adminCancelBooking({ schoolId: 'nexta', id: 'b1' })).ok, false);
  assert.equal(dump('bookings')[0].status, 'confirmed');
});

await test('存在しない校舎はエラーになる', async () => {
  setup();
  assert.equal((await store.adminCancelBooking({ schoolId: 'nope', id: 'b1' })).ok, false);
  assert.deepEqual(await store.getAllSlots('nope'), []);
});

console.log(`\n${passed} 件のテストが通りました。`);
