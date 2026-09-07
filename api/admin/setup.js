/**
 * 管理画面の「システム設定」用API(要ログイン)。
 * GAS版でスプレッドシートのメニューから実行していた操作の置き換え。
 *
 *   GET  /api/admin/setup                   校舎と通知先の一覧
 *   POST /api/admin/setup { action: ... }
 *     'saveNotifyEmails' 通知先メールアドレスを保存する
 *     'testNotify'       各校舎の通知先へテストメールを送る
 *     'diagnose'         リマインドが送られない原因を診断する
 *     'sendReminders'    リマインドメールを手動送信する
 *     'status'           DB接続・メール設定・データ件数の確認
 */
import { listSchools, updateNotifyEmail } from '../../lib/schools.js';
import { getDb, unwrap } from '../../lib/db.js';
import { notifyStaffNewBooking, sendReminders, diagnoseReminders } from '../../lib/notify.js';
import { mailerMode } from '../../lib/mailer.js';
import { todayStr, TIMEZONE } from '../../lib/format.js';
import { requireAdmin } from '../../lib/auth.js';
import { readJsonBody, withErrorHandling, methodNotAllowed, noStore } from '../../lib/http.js';

/** 通知先メールアドレスをまとめて保存する */
async function saveNotifyEmails(body) {
  const entries = Array.isArray(body.emails) ? body.emails : [];
  if (!entries.length) return { ok: false, error: '保存する内容がありません' };
  const schools = await listSchools({ includeInactive: true });
  const known = new Set(schools.map((s) => s.id));

  let saved = 0;
  for (const e of entries) {
    if (!known.has(e.schoolId)) continue;
    await updateNotifyEmail(e.schoolId, e.email);
    saved++;
  }
  return { ok: true, saved, message: `${saved}校舎の通知先を保存しました。` };
}

/** 各校舎の通知先設定が正しいか、テストメールを送って確認する */
async function testNotify() {
  const schools = await listSchools({ includeInactive: true });
  let sent = 0;
  const noAddress = [];
  for (const school of schools) {
    if (!String(school.notify_email || '').trim()) {
      noAddress.push(school.name);
      continue;
    }
    await notifyStaffNewBooking({
      schoolId: school.id,
      schoolName: school.name,
      date: todayStr(),
      time: '00:00',
      childName: '(テスト)',
      grade: 'テスト学年',
      parentName: '(テスト)',
      email: 'test@example.com',
      note: 'これは通知先設定のテストメールです。',
    });
    sent++;
  }
  return {
    ok: true,
    sent,
    noAddress,
    message:
      `通知テストを送信しました。送信: ${sent}校舎` +
      (noAddress.length ? ` / 未設定(送信なし): ${noAddress.join('、')}` : ''),
  };
}

/** 接続やデータ件数の確認 */
async function status() {
  const db = getDb();
  const schools = await listSchools({ includeInactive: true });
  const countOf = async (table, filter) => {
    let q = db.from(table).select('*', { count: 'exact', head: true });
    if (filter) q = filter(q);
    const res = await q;
    if (res.error) throw new Error(res.error.message);
    return res.count;
  };
  const today = todayStr();
  return {
    ok: true,
    timezone: TIMEZONE,
    mailer: mailerMode(),
    schools: schools.length,
    slots: await countOf('slots'),
    futureSlots: await countOf('slots', (q) => q.gte('date', today)),
    bookings: await countOf('bookings'),
    activeBookings: await countOf('bookings', (q) => q.neq('status', 'cancelled')),
    message: 'データベースに接続できています。',
  };
}

export default withErrorHandling(async (req, res) => {
  noStore(res);
  if (!requireAdmin(req, res)) return;

  if (req.method === 'GET') {
    const schools = await listSchools({ includeInactive: true });
    return res.status(200).json({
      ok: true,
      schools: schools.map((s) => ({
        id: s.id,
        name: s.name,
        notifyEmail: s.notify_email || '',
      })),
    });
  }

  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  const body = await readJsonBody(req);
  switch (body.action) {
    case 'saveNotifyEmails':
      return res.status(200).json(await saveNotifyEmails(body));
    case 'testNotify':
      return res.status(200).json(await testNotify());
    case 'diagnose':
      return res.status(200).json(await diagnoseReminders());
    case 'sendReminders':
      return res.status(200).json(await sendReminders());
    case 'status':
      return res.status(200).json(await status());
    default:
      return res.status(400).json({ ok: false, error: '不明な操作です: ' + body.action });
  }
});
