import assert from 'node:assert/strict';
import { installFakes, resetStore, addSheet, dumpSheet } from './fake-sheets.js';

process.env.SPREADSHEET_ID = 'test-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'x@y.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY = 'fake';
process.env.TIMEZONE = 'Asia/Tokyo';
installFakes();

const ROOT = '../lib/';
const store = await import(ROOT + 'store.js');
const { SLOT_HEADERS, BOOKING_HEADERS } = await import(ROOT + 'schools.js');
const { todayStr, addDays } = await import(ROOT + 'format.js');
const { invalidateMetaCache } = await import(ROOT + 'sheets.js');

const SLOTS = 'RED広田教室予約枠';
const BOOKINGS = 'RED広田教室予約データ';
const D1 = addDays(todayStr(), 3);   // 未来の日付
const PAST = addDays(todayStr(), -3);

function setup(slotRows = [], bookingRows = []) {
  resetStore();
  invalidateMetaCache();
  addSheet(SLOTS, [SLOT_HEADERS, ...slotRows]);
  addSheet(BOOKINGS, [BOOKING_HEADERS, ...bookingRows]);
  // 他校舎も空で用意(getMyBookings が全校舎を見るため)
  addSheet('RED京町教室予約枠', [SLOT_HEADERS]);
  addSheet('RED京町教室予約データ', [BOOKING_HEADERS]);
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('\n== 予約枠の取得 ==');
await test('公開中で空きのある枠が返る', async () => {
  setup([[D1, '14:00', '', true, 1], [D1, '14:30', '', true, 2]]);
  const slots = await store.getAvailableSlots('hirota');
  assert.equal(slots.length, 2);
  assert.deepEqual(slots[0], { date: D1, time: '14:00', label: '', capacity: 1, booked: 0, remaining: 1 });
});

await test('非公開の枠は返らない', async () => {
  setup([[D1, '14:00', '', false, 1], [D1, '15:00', '', true, 1]]);
  const slots = await store.getAvailableSlots('hirota');
  assert.deepEqual(slots.map(s => s.time), ['15:00']);
});

await test('過去の枠は返らない', async () => {
  setup([[PAST, '14:00', '', true, 1], [D1, '15:00', '', true, 1]]);
  const slots = await store.getAvailableSlots('hirota');
  assert.deepEqual(slots.map(s => s.time), ['15:00']);
});

await test('定員に達した枠は返らず、空きがあれば残数が出る', async () => {
  setup(
    [[D1, '14:00', '', true, 1], [D1, '15:00', '', true, 2]],
    [
      ['b1', D1, '14:00', '子A', '親A', 'a@x.jp', '小1', '', 'confirmed', '', '', '', false, '', ''],
      ['b2', D1, '15:00', '子B', '親B', 'b@x.jp', '小2', '', 'confirmed', '', '', '', false, '', ''],
    ]
  );
  const slots = await store.getAvailableSlots('hirota');
  assert.equal(slots.length, 1);
  assert.equal(slots[0].time, '15:00');
  assert.equal(slots[0].remaining, 1);
});

await test('キャンセル済みの予約は定員に数えない', async () => {
  setup(
    [[D1, '14:00', '', true, 1]],
    [['b1', D1, '14:00', '子A', '親A', 'a@x.jp', '小1', '', 'cancelled', '', '', '', false, '', '']]
  );
  const slots = await store.getAvailableSlots('hirota');
  assert.equal(slots.length, 1);
});

await test('日付が Date 型・時刻が文字列でも読める(GAS時代の既存データ)', async () => {
  setup([[new Date(D1 + 'T00:00:00'), '14:00', '', true, 1]]);
  const slots = await store.getAvailableSlots('hirota');
  assert.equal(slots[0].date, D1);
});

console.log('\n== 予約の作成 ==');
await test('予約が作成され、シートに1行追記される', async () => {
  setup([[D1, '14:00', '', true, 1]]);
  const res = await store.createBooking({
    schoolId: 'hirota', email: 'p@x.jp', date: D1, time: '14:00',
    childName: '花子', parentName: '太郎', grade: '小3', note: 'よろしく',
  });
  assert.equal(res.ok, true);
  const rows = dumpSheet(BOOKINGS);
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], D1);
  assert.equal(rows[1][3], '花子');
  assert.equal(rows[1][8], 'confirmed');
  assert.equal(res.booking.schoolName, 'RED広田教室');
});

await test('定員が埋まっている枠は予約できない', async () => {
  setup(
    [[D1, '14:00', '', true, 1]],
    [['b1', D1, '14:00', '子A', '親A', 'a@x.jp', '小1', '', 'confirmed', '', '', '', false, '', '']]
  );
  const res = await store.createBooking({
    schoolId: 'hirota', email: 'p@x.jp', date: D1, time: '14:00',
    childName: '花子', parentName: '太郎',
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /すでに予約されている/);
});

await test('必須項目が欠けていればエラー', async () => {
  setup([[D1, '14:00', '', true, 1]]);
  const res = await store.createBooking({ schoolId: 'hirota', date: D1, time: '14:00' });
  assert.equal(res.ok, false);
  assert.match(res.error, /パラメータが不足/);
});

await test('定員2の枠には2件まで予約できる', async () => {
  setup([[D1, '14:00', '', true, 2]]);
  const a = await store.createBooking({ schoolId: 'hirota', email: 'a@x.jp', date: D1, time: '14:00', childName: 'A', parentName: 'PA' });
  const b = await store.createBooking({ schoolId: 'hirota', email: 'b@x.jp', date: D1, time: '14:00', childName: 'B', parentName: 'PB' });
  const c = await store.createBooking({ schoolId: 'hirota', email: 'c@x.jp', date: D1, time: '14:00', childName: 'C', parentName: 'PC' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(c.ok, false);
});

console.log('\n== 保護者の予約照会・変更 ==');
await test('メールアドレスで自分の予約を引ける(大文字小文字を無視)', async () => {
  setup([], [['b1', D1, '14:00', '子A', '親A', 'Parent@X.jp', '小1', '', 'confirmed', '', '', '', false, '', '']]);
  const list = await store.getMyBookings('parent@x.jp');
  assert.equal(list.length, 1);
  assert.equal(list[0].schoolName, 'RED広田教室');
  assert.equal(list[0].childName, '子A');
});

await test('別人のメールでは引けない', async () => {
  setup([], [['b1', D1, '14:00', '子A', '親A', 'a@x.jp', '小1', '', 'confirmed', '', '', '', false, '', '']]);
  assert.equal((await store.getMyBookings('other@x.jp')).length, 0);
});

await test('本人ならキャンセルできる / 他人はできない', async () => {
  setup([], [['b1', D1, '14:00', '子A', '親A', 'a@x.jp', '小1', '', 'confirmed', '', '', '', false, '', '']]);
  assert.equal((await store.cancelBooking({ schoolId: 'hirota', email: 'nope@x.jp', id: 'b1' })).ok, false);
  assert.equal((await store.cancelBooking({ schoolId: 'hirota', email: 'a@x.jp', id: 'b1' })).ok, true);
  assert.equal(dumpSheet(BOOKINGS)[1][8], 'cancelled');
});

console.log('\n== 管理画面: 枠 ==');
await test('全枠が予約者情報つきで返る', async () => {
  setup(
    [[D1, '14:00', '', true, 2], [PAST, '10:00', 'ラベル', false, 1]],
    [['b1', D1, '14:00', '子A', '親A', 'a@x.jp', '小1', '', 'confirmed', '', '', '', false, '', '']]
  );
  const slots = await store.getAllSlots('hirota');
  assert.equal(slots.length, 2);
  const past = slots.find(s => s.date === PAST);
  assert.equal(past.isPast, true);
  assert.equal(past.published, false);
  assert.equal(past.label, 'ラベル');
  const future = slots.find(s => s.date === D1);
  assert.equal(future.booked, 1);
  assert.equal(future.capacity, 2);
  assert.equal(future.bookings[0].childName, '子A');
  assert.equal(future.rowNum, 2);
});

await test('枠を追加でき、重複はスキップされる', async () => {
  setup([[D1, '14:00', '', true, 1]]);
  const res = await store.adminAddSlots({
    schoolId: 'hirota',
    slots: [{ date: D1, time: '14:00' }, { date: D1, time: '16:00' }, { date: D1, time: '16:30', capacity: 2 }],
  });
  assert.deepEqual([res.added, res.skipped], [2, 1]);
  const rows = dumpSheet(SLOTS);
  assert.equal(rows.length, 4);
  assert.equal(rows[3][4], 2);
});

await test('公開/非公開と定員を切り替えられる', async () => {
  setup([[D1, '14:00', '', true, 1]]);
  assert.equal((await store.adminUpdateSlot({ schoolId: 'hirota', rowNum: 2, published: false })).ok, true);
  assert.equal(dumpSheet(SLOTS)[1][3], false);
  assert.equal((await store.adminUpdateSlot({ schoolId: 'hirota', rowNum: 2, capacity: 2 })).ok, true);
  assert.equal(dumpSheet(SLOTS)[1][4], 2);
});

await test('予約数より少ない定員には変更できない', async () => {
  setup(
    [[D1, '14:00', '', true, 2]],
    [
      ['b1', D1, '14:00', 'A', 'PA', 'a@x.jp', '', '', 'confirmed', '', '', '', false, '', ''],
      ['b2', D1, '14:00', 'B', 'PB', 'b@x.jp', '', '', 'confirmed', '', '', '', false, '', ''],
    ]
  );
  const res = await store.adminUpdateSlot({ schoolId: 'hirota', rowNum: 2, capacity: 1 });
  assert.equal(res.ok, false);
  assert.match(res.error, /2件の予約/);
});

await test('枠の一括削除は予約済みをスキップする', async () => {
  setup(
    [[D1, '14:00', '', true, 1], [D1, '15:00', '', true, 1], [D1, '16:00', '', true, 1]],
    [['b1', D1, '15:00', 'A', 'PA', 'a@x.jp', '', '', 'confirmed', '', '', '', false, '', '']]
  );
  const res = await store.adminDeleteSlots({ schoolId: 'hirota', rowNums: [2, 3, 4] });
  assert.deepEqual([res.deleted, res.skippedBooked], [2, 1]);
  const rows = dumpSheet(SLOTS);
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], '15:00');  // 予約済みの枠だけが残る
});

await test('定員の一括変更(予約数を下回る枠はスキップ)', async () => {
  setup(
    [[D1, '14:00', '', true, 1], [D1, '15:00', '', true, 1]],
    [
      ['b1', D1, '15:00', 'A', 'PA', 'a@x.jp', '', '', 'confirmed', '', '', '', false, '', ''],
      ['b2', D1, '15:00', 'B', 'PB', 'b@x.jp', '', '', 'confirmed', '', '', '', false, '', ''],
    ]
  );
  const res = await store.adminBulkUpdateCapacity({ schoolId: 'hirota', rowNums: [2, 3], capacity: 1 });
  assert.deepEqual([res.updated, res.skipped], [1, 1]);
  assert.equal(res.skipReasons.length, 1);
});

console.log('\n== 管理画面: 予約 ==');
await test('予約の部分更新(担当メモ・面談記録)ができる', async () => {
  setup([], [['b1', D1, '14:00', 'A', 'PA', 'a@x.jp', '小1', '', 'confirmed', '', '', '', false, '', '']]);
  assert.equal((await store.adminUpdateBooking({ schoolId: 'hirota', id: 'b1', staffNote: '田中' })).ok, true);
  assert.equal((await store.adminUpdateBooking({
    schoolId: 'hirota', id: 'b1', interviewNote: '進路の相談', interviewDone: true,
  })).ok, true);
  const row = dumpSheet(BOOKINGS)[1];
  assert.equal(row[10], '田中');
  assert.equal(row[12], true);
  assert.equal(row[13], '進路の相談');
  assert.match(row[14], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  // 他の列は書き換わっていない
  assert.equal(row[3], 'A');
  assert.equal(row[8], 'confirmed');
});

await test('日時変更は、他の予約と衝突するとエラー', async () => {
  setup([], [
    ['b1', D1, '14:00', 'A', 'PA', 'a@x.jp', '', '', 'confirmed', '', '', '', false, '', ''],
    ['b2', D1, '15:00', 'B', 'PB', 'b@x.jp', '', '', 'confirmed', '', '', '', false, '', ''],
  ]);
  const res = await store.adminUpdateBooking({ schoolId: 'hirota', id: 'b1', date: D1, time: '15:00' });
  assert.equal(res.ok, false);
  const ok = await store.adminUpdateBooking({ schoolId: 'hirota', id: 'b1', date: D1, time: '16:00' });
  assert.equal(ok.ok, true);
  assert.equal(dumpSheet(BOOKINGS)[1][2], '16:00');
});

await test('職員は予約をキャンセルできる', async () => {
  setup([], [['b1', D1, '14:00', 'A', 'PA', 'a@x.jp', '', '', 'confirmed', '', '', '', false, '', '']]);
  assert.equal((await store.adminCancelBooking({ schoolId: 'hirota', id: 'b1' })).ok, true);
  assert.equal(dumpSheet(BOOKINGS)[1][8], 'cancelled');
});

await test('存在しない校舎はエラーになる', async () => {
  setup();
  assert.equal((await store.adminCancelBooking({ schoolId: 'nope', id: 'b1' })).ok, false);
  assert.deepEqual(await store.getAllSlots('nope'), []);
});

console.log(`\n${passed} 件のテストが通りました。`);
