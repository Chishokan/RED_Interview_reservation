/** リマインドメールと新規予約通知のテスト(送信はResend APIをモックして捕捉する) */
import assert from 'node:assert/strict';
import {
  fakeClient, resetDb, seedDepartments, seedSchools, seedBookings, dump,
} from './fake-supabase.js';
import { DEPARTMENTS, SCHOOLS } from './fixtures.js';

process.env.TIMEZONE = 'Asia/Tokyo';
process.env.RESEND_API_KEY = 'test-key';
process.env.MAIL_FROM = '面談予約システム <noreply@example.com>';

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

const { setDbForTesting } = await import('../lib/db.js');
setDbForTesting(fakeClient);

const { clearSchoolCache } = await import('../lib/schools.js');
const { todayStr, addDays } = await import('../lib/format.js');
const { sendReminders, diagnoseReminders, notifyStaffNewBooking } = await import('../lib/notify.js');

const TOMORROW = addDays(todayStr(), 1);
const TODAY = todayStr();

function booking(id, over = {}) {
  return {
    id,
    school_id: 'hirota',
    date: TOMORROW,
    time: '14:00',
    child_name: '花子',
    parent_name: '太郎',
    email: 'a@x.jp',
    grade: '小3',
    ...over,
  };
}

function setup(bookings = [], notify = {}) {
  resetDb();
  clearSchoolCache();
  sentMails.length = 0;
  seedDepartments(DEPARTMENTS);
  seedSchools(SCHOOLS.map((s) => ({ ...s, notify_email: notify[s.id] || '' })));
  seedBookings(bookings);
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('\n== リマインドメール ==');

await test('翌日の予約にだけ送信される', async () => {
  setup([
    booking('b1'),
    booking('b2', { date: TODAY, email: 'b@x.jp' }),
    booking('b3', { date: addDays(TODAY, 5), email: 'c@x.jp' }),
  ]);
  const res = await sendReminders();
  assert.equal(res.sent, 1);
  assert.equal(sentMails.length, 1);
  assert.deepEqual(sentMails[0].to, ['a@x.jp']);
  assert.match(sentMails[0].subject, /明日の面談/);
  assert.match(sentMails[0].text, /RED広田教室/);
});

await test('送信すると記録が残り、2回目は再送されない', async () => {
  setup([booking('b1')]);
  await sendReminders();
  assert.ok(dump('bookings')[0].reminder_sent_at);
  sentMails.length = 0;
  const second = await sendReminders();
  assert.equal(second.sent, 0);
  assert.equal(sentMails.length, 0);
});

await test('キャンセル済み・メール未入力の予約は対象外', async () => {
  setup([booking('b1', { status: 'cancelled' }), booking('b2', { email: '' })]);
  const res = await sendReminders();
  assert.equal(res.sent, 0);
  assert.equal(sentMails.length, 0);
});

await test('全校舎を横断して送信する', async () => {
  setup([booking('b1'), booking('b2', { school_id: 'nexta', email: 'b@x.jp' })]);
  const res = await sendReminders();
  assert.equal(res.sent, 2);
  assert.deepEqual(sentMails.map((m) => m.to[0]).sort(), ['a@x.jp', 'b@x.jp']);
});

await test('1件失敗しても他の送信は続く', async () => {
  setup([booking('b1', { email: 'boom@x.jp' }), booking('b2', { email: 'ok@x.jp' })]);
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
  // 失敗した予約には送信済みの記録が残らない(次回に拾える)
  assert.equal(dump('bookings').find((b) => b.email === 'boom@x.jp').reminder_sent_at, null);
});

await test('リマインドは全部門をまとめて送る', async () => {
  setup([
    booking('r1', { school_id: 'hirota', email: 'red@x.jp' }),
    booking('c1', { school_id: 'chutobu_sasebo', email: 'chu@x.jp' }),
  ]);
  const res = await sendReminders();
  assert.equal(res.sent, 2);
  assert.deepEqual(sentMails.map((m) => m.to[0]).sort(), ['chu@x.jp', 'red@x.jp']);
  // 中等部の予約には中等部の校舎名が入る
  const chu = sentMails.find((m) => m.to[0] === 'chu@x.jp');
  assert.match(chu.text, /佐世保駅前校/);
});

console.log('\n== リマインド診断 ==');
await test('送信対象と除外理由を集計できる', async () => {
  setup([
    booking('b1'),
    booking('b2', { status: 'cancelled', email: 'b@x.jp' }),
    booking('b3', { email: '' }),
    booking('b4', { email: 'd@x.jp', reminder_sent_at: '2026-01-01T01:00:00.000Z' }),
  ]);
  const d = await diagnoseReminders('red');
  assert.equal(d.tomorrow, TOMORROW);
  assert.equal(d.totalTarget, 4);
  assert.equal(d.totalWouldSend, 1);
  const reasons = d.perSchool[0].bookings.map((b) => b.reason);
  assert.deepEqual(reasons.sort(), [
    'キャンセル済', 'メール空欄', '送信済(2026-01-01 10:00)', '送信対象',
  ].sort());
  assert.equal(d.mailer, 'resend');
});

await test('診断は自部門の予約だけを対象にする', async () => {
  setup([
    booking('r1', { school_id: 'hirota', email: 'red@x.jp' }),
    booking('c1', { school_id: 'chutobu_sasebo', email: 'chu@x.jp' }),
  ]);
  const red = await diagnoseReminders('red');
  assert.equal(red.totalTarget, 1);
  assert.deepEqual(red.perSchool.map((p) => p.school), ['RED広田教室']);
  const chu = await diagnoseReminders('chutobu');
  assert.equal(chu.totalTarget, 1);
  assert.deepEqual(chu.perSchool.map((p) => p.school), ['佐世保駅前校']);
});

console.log('\n== 新規予約の担当者通知 ==');
await test('校舎に設定された通知先へ送られる', async () => {
  setup([], { hirota: 'staff@x.jp' });
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
  setup([], {});
  await notifyStaffNewBooking({
    schoolId: 'kyomachi', schoolName: 'RED京町教室', date: TOMORROW, time: '14:00',
    childName: '花子', parentName: '太郎', email: 'p@x.jp',
  });
  assert.equal(sentMails.length, 0);
});

await test('カンマ区切りで複数の担当者に送れる', async () => {
  setup([], { hirota: 'a@x.jp, b@x.jp' });
  await notifyStaffNewBooking({
    schoolId: 'hirota', schoolName: 'RED広田教室', date: TOMORROW, time: '14:00',
    childName: '花子', parentName: '太郎', email: 'p@x.jp',
  });
  assert.deepEqual(sentMails[0].to, ['a@x.jp', 'b@x.jp']);
});

await test('通知の送信に失敗しても例外を投げない(予約処理を止めない)', async () => {
  setup([], { hirota: 'a@x.jp' });
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
