/** リマインドメールと新規予約通知のテスト(送信はResend APIをモックして捕捉する) */
import assert from 'node:assert/strict';
import { installFakes, resetStore, addSheet, dumpSheet } from './fake-sheets.js';

process.env.SPREADSHEET_ID = 'test-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'x@y.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY = 'fake';
process.env.TIMEZONE = 'Asia/Tokyo';
process.env.RESEND_API_KEY = 'test-key';
process.env.MAIL_FROM = '面談予約システム <noreply@example.com>';
installFakes();

// Resend への送信を捕捉する
const sentMails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('api.resend.com')) {
    sentMails.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ id: 'fake' }) };
  }
  return realFetch(url, opts);
};

const { SLOT_HEADERS, BOOKING_HEADERS, NOTIFY_HEADERS } = await import('../lib/schools.js');
const { todayStr, addDays } = await import('../lib/format.js');
const { invalidateMetaCache } = await import('../lib/sheets.js');
const { sendReminders, diagnoseReminders, notifyStaffNewBooking } = await import('../lib/notify.js');

const BOOKINGS = 'RED広田教室予約データ';
const TOMORROW = addDays(todayStr(), 1);
const TODAY = todayStr();

function row(id, date, email, status = 'confirmed', reminderSent = '') {
  return [id, date, '14:00', '花子', '太郎', email, '小3', '', status, '', '', reminderSent, false, '', ''];
}

function setup(bookingRows = [], notifyRows = null) {
  resetStore();
  invalidateMetaCache();
  sentMails.length = 0;
  addSheet('RED広田教室予約枠', [SLOT_HEADERS]);
  addSheet(BOOKINGS, [BOOKING_HEADERS, ...bookingRows]);
  for (const n of ['RED京町教室', 'RED日野教室', 'RED佐々教室', 'RED西海大島教室', 'RED大野教室', 'ネクスタ']) {
    addSheet(n + '予約枠', [SLOT_HEADERS]);
    addSheet(n + '予約データ', [BOOKING_HEADERS]);
  }
  if (notifyRows) addSheet('通知先', [NOTIFY_HEADERS, ...notifyRows]);
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('\n== リマインドメール ==');

await test('翌日の予約にだけ送信される', async () => {
  setup([row('b1', TOMORROW, 'a@x.jp'), row('b2', TODAY, 'b@x.jp'), row('b3', addDays(TODAY, 5), 'c@x.jp')]);
  const res = await sendReminders();
  assert.equal(res.sent, 1);
  assert.equal(sentMails.length, 1);
  assert.deepEqual(sentMails[0].to, ['a@x.jp']);
  assert.match(sentMails[0].subject, /明日の面談/);
  assert.match(sentMails[0].text, /RED広田教室/);
});

await test('送信するとL列に日時が記録され、2回目は再送されない', async () => {
  setup([row('b1', TOMORROW, 'a@x.jp')]);
  await sendReminders();
  const stamp = dumpSheet(BOOKINGS)[1][11];
  assert.match(String(stamp), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  sentMails.length = 0;
  const second = await sendReminders();
  assert.equal(second.sent, 0);
  assert.equal(sentMails.length, 0);
});

await test('キャンセル済み・メール未入力の予約は対象外', async () => {
  setup([row('b1', TOMORROW, 'a@x.jp', 'cancelled'), row('b2', TOMORROW, '')]);
  const res = await sendReminders();
  assert.equal(res.sent, 0);
  assert.equal(sentMails.length, 0);
});

await test('全校舎を横断して送信する', async () => {
  setup([row('b1', TOMORROW, 'a@x.jp')]);
  const kyomachi = 'RED京町教室予約データ';
  resetStore();
  invalidateMetaCache();
  sentMails.length = 0;
  addSheet(BOOKINGS, [BOOKING_HEADERS, row('b1', TOMORROW, 'a@x.jp')]);
  addSheet(kyomachi, [BOOKING_HEADERS, row('b2', TOMORROW, 'b@x.jp')]);
  const res = await sendReminders();
  assert.equal(res.sent, 2);
  assert.deepEqual(sentMails.map(m => m.to[0]).sort(), ['a@x.jp', 'b@x.jp']);
});

await test('1件失敗しても他の送信は続く', async () => {
  setup([row('b1', TOMORROW, 'boom@x.jp'), row('b2', TOMORROW, 'ok@x.jp')]);
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.to[0] === 'boom@x.jp') return { ok: false, status: 500, text: async () => 'boom' };
    sentMails.push(body);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const res = await sendReminders();
  globalThis.fetch = saved;
  assert.equal(res.sent, 1);
  assert.equal(res.failed, 1);
  assert.equal(res.errors.length, 1);
  // 失敗した予約には送信済みフラグが立たない(次回に拾える)
  assert.equal(dumpSheet(BOOKINGS)[1][11], '');
});

console.log('\n== リマインド診断 ==');
await test('送信対象と除外理由を集計できる', async () => {
  setup([
    row('b1', TOMORROW, 'a@x.jp'),
    row('b2', TOMORROW, 'b@x.jp', 'cancelled'),
    row('b3', TOMORROW, ''),
    row('b4', TOMORROW, 'd@x.jp', 'confirmed', '2026-01-01 10:00'),
  ]);
  const d = await diagnoseReminders();
  assert.equal(d.tomorrow, TOMORROW);
  assert.equal(d.totalTarget, 4);
  assert.equal(d.totalWouldSend, 1);
  const reasons = d.perSchool[0].bookings.map(b => b.reason);
  assert.deepEqual(reasons, ['送信対象', 'キャンセル済', 'メール空欄', '送信済(2026-01-01 10:00)']);
  assert.equal(d.mailer, 'resend');
});

console.log('\n== 新規予約の担当者通知 ==');
await test('「通知先」シートのアドレスへ送られる', async () => {
  setup([], [['hirota', 'RED広田教室', 'staff@x.jp'], ['kyomachi', 'RED京町教室', '']]);
  await notifyStaffNewBooking({
    schoolId: 'hirota', schoolName: 'RED広田教室', date: TOMORROW, time: '14:00',
    childName: '花子', parentName: '太郎', email: 'p@x.jp', grade: '小3', note: '進路相談',
  });
  assert.equal(sentMails.length, 1);
  assert.deepEqual(sentMails[0].to, ['staff@x.jp']);
  assert.match(sentMails[0].subject, /【新規予約】RED広田教室/);
  assert.match(sentMails[0].text, /進路相談/);
});

await test('通知先が空欄の校舎には送らない', async () => {
  setup([], [['kyomachi', 'RED京町教室', '']]);
  await notifyStaffNewBooking({
    schoolId: 'kyomachi', schoolName: 'RED京町教室', date: TOMORROW, time: '14:00',
    childName: '花子', parentName: '太郎', email: 'p@x.jp',
  });
  assert.equal(sentMails.length, 0);
});

await test('カンマ区切りで複数の担当者に送れる', async () => {
  setup([], [['hirota', 'RED広田教室', 'a@x.jp, b@x.jp']]);
  await notifyStaffNewBooking({
    schoolId: 'hirota', schoolName: 'RED広田教室', date: TOMORROW, time: '14:00',
    childName: '花子', parentName: '太郎', email: 'p@x.jp',
  });
  assert.deepEqual(sentMails[0].to, ['a@x.jp', 'b@x.jp']);
});

await test('通知の送信に失敗しても例外を投げない(予約処理を止めない)', async () => {
  setup([], [['hirota', 'RED広田教室', 'a@x.jp']]);
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const res = await notifyStaffNewBooking({
    schoolId: 'hirota', schoolName: 'RED広田教室', date: TOMORROW, time: '14:00',
    childName: '花子', parentName: '太郎', email: 'p@x.jp',
  });
  globalThis.fetch = saved;
  assert.equal(res.sent, false);
});

console.log(`\n${passed} 件のテストが通りました。`);
