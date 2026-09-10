/**
 * 管理画面の「システム設定」用API(要ログイン・部門ごと)。
 *
 *   GET  /api/admin/setup?dept=xxx          その部門の校舎と通知先の一覧
 *   POST /api/admin/setup { dept, action }
 *     'saveNotify'       通知先(メール / LINE WORKS)を保存する
 *     'testNotify'       各校舎の通知先へテスト送信する
 *     'diagnose'         リマインドが送られない原因を診断する
 *     'sendReminders'    リマインドメールを手動送信する(全部門が対象)
 *     'status'           DB接続・メール設定・データ件数の確認
 */
import { listSchools, updateSchoolNotify } from '../../lib/schools.js';
import { getDb, unwrap } from '../../lib/db.js';
import { notifyStaffNewBooking, sendReminders, diagnoseReminders } from '../../lib/notify.js';
import { mailerMode, mailQuota } from '../../lib/mailer.js';
import { isLineWorksConfigured } from '../../lib/lineworks.js';
import { todayStr, TIMEZONE } from '../../lib/format.js';
import { requireAdmin } from '../../lib/auth.js';
import {
  readJsonBody, withErrorHandling, methodNotAllowed, noStore, resolveDepartment,
} from '../../lib/http.js';

/** 通知先をまとめて保存する */
async function saveNotify(dept, body) {
  const entries = Array.isArray(body.notify) ? body.notify : [];
  if (!entries.length) return { ok: false, error: '保存する内容がありません' };
  const schools = await listSchools(dept.slug, { includeInactive: true });
  const known = new Set(schools.map((s) => s.id));

  let saved = 0;
  for (const e of entries) {
    // 他部門の校舎を書き換えられないよう、この部門の校舎だけを対象にする
    if (!known.has(e.schoolId)) continue;
    await updateSchoolNotify(e.schoolId, {
      notifyEmail: e.email,
      lineWorksChannelId: e.lineWorksChannelId,
    });
    saved++;
  }
  return { ok: true, saved, message: `${saved}校舎の通知先を保存しました。` };
}

/**
 * 送信できなかった理由を、職員が読んで分かる言葉にする。
 * 「送信できず」だけだと、設定漏れなのか認証失敗なのか切り分けられないため。
 */
function describeFailure(result) {
  const raw = [
    ...(result.results || []).map((r) => r && r.reason).filter(Boolean),
    result.reason,
  ].filter(Boolean)[0];
  if (!raw) return '原因不明';
  if (raw === 'not-configured') return 'メール送信の環境変数が未設定(要再デプロイ)';
  if (raw === 'timeout') return '送信先が応答せずタイムアウト';
  if (raw === 'no-recipient') return '宛先が空';
  return String(raw).replace(/\s+/g, ' ').slice(0, 200);
}

/** 各校舎の通知先設定が正しいか、テスト送信して確認する */
async function testNotify(dept) {
  const schools = await listSchools(dept.slug, { includeInactive: true });
  let sent = 0;
  const noRecipient = [];
  for (const school of schools) {
    const hasEmail = Boolean(String(school.notify_email || '').trim());
    const hasChannel = Boolean(String(school.line_works_channel_id || '').trim());
    if (!hasEmail && !hasChannel) {
      noRecipient.push(school.name);
      continue;
    }
    const result = await notifyStaffNewBooking({
      schoolId: school.id,
      schoolName: school.name,
      date: todayStr(),
      time: '00:00',
      childName: '(テスト)',
      grade: 'テスト学年',
      parentName: '(テスト)',
      email: 'test@example.com',
      note: 'これは通知先設定のテストです。',
    });
    if (result.sent) sent++;
    else noRecipient.push(`${school.name}(送信できず: ${describeFailure(result)})`);
  }
  return {
    ok: true,
    sent,
    mailer: mailerMode(),
    noRecipient,
    message:
      `通知テストを送信しました(メール送信方法: ${mailerMode()})。送信: ${sent}校舎` +
      (noRecipient.length ? ` / 未設定・失敗: ${noRecipient.join('、')}` : ''),
  };
}

/** 接続やデータ件数の確認(この部門の分だけ数える) */
async function status(dept) {
  const db = getDb();
  const schools = await listSchools(dept.slug, { includeInactive: true });
  const ids = schools.map((s) => s.id);
  const countOf = async (table, filter) => {
    if (!ids.length) return 0;
    let q = db.from(table).select('*', { count: 'exact', head: true }).in('school_id', ids);
    if (filter) q = filter(q);
    const res = await q;
    if (res.error) throw new Error(res.error.message);
    return res.count;
  };
  const today = todayStr();
  return {
    ok: true,
    department: dept.name,
    timezone: TIMEZONE,
    mailer: mailerMode(),
    // GAS経由のときだけ、その日あと何通送れるかを出す(無料のGmailは100通/日)
    mailQuotaRemaining: await mailQuota().catch((err) => `取得できません: ${err.message}`),
    lineWorks: isLineWorksConfigured() ? '設定済' : '未設定',
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

  if (req.method === 'GET') {
    const dept = await resolveDepartment(req, res);
    if (!dept) return;
    if (!requireAdmin(req, res, dept.slug)) return;
    const schools = await listSchools(dept.slug, { includeInactive: true });
    return res.status(200).json({
      ok: true,
      lineWorksConfigured: isLineWorksConfigured(),
      schools: schools.map((s) => ({
        id: s.id,
        name: s.name,
        notifyEmail: s.notify_email || '',
        lineWorksChannelId: s.line_works_channel_id || '',
      })),
    });
  }

  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  const body = await readJsonBody(req);
  const dept = await resolveDepartment(req, res, body);
  if (!dept) return;
  if (!requireAdmin(req, res, dept.slug)) return;

  switch (body.action) {
    case 'saveNotify':
      return res.status(200).json(await saveNotify(dept, body));
    case 'testNotify':
      return res.status(200).json(await testNotify(dept));
    case 'diagnose':
      return res.status(200).json(await diagnoseReminders(dept.slug));
    case 'sendReminders':
      return res.status(200).json(await sendReminders());
    case 'status':
      return res.status(200).json(await status(dept));
    default:
      return res.status(400).json({ ok: false, error: '不明な操作です: ' + body.action });
  }
});
