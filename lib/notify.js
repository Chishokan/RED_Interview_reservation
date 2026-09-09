/**
 * 通知メールの本文組み立てと送信(Supabase版)。
 * GAS版の notifyStaffNewBooking / sendOneReminder / sendReminders を移植したもの。
 */

import { getDb, unwrap } from './db.js';
import {
  listSchools,
  listAllSchools,
  listDepartments,
  findSchoolByIdAnyDepartment,
} from './schools.js';
import { toBooking } from './store.js';
import { formatJapaneseDate, todayStr, addDays, formatDateTime } from './format.js';
import { sendMail, mailerMode } from './mailer.js';
import { sendChannelMessage, isLineWorksConfigured } from './lineworks.js';

/**
 * 校舎のメール通知先を返す。
 * 未設定なら環境変数 STAFF_NOTIFY_EMAIL をフォールバックに使う。
 */
export async function getNotifyEmail(schoolId) {
  const school = await findSchoolByIdAnyDepartment(schoolId);
  const addr = school ? String(school.notify_email || '').trim() : '';
  return addr || String(process.env.STAFF_NOTIFY_EMAIL || '').trim();
}

/** 新規予約の通知本文(メール・LINE WORKS で共通) */
function newBookingText(booking) {
  const dateLabel = formatJapaneseDate(booking.date);
  return (
    `${booking.schoolName} 担当者様\n` +
    '\n' +
    '新しい面談予約が入りました。\n' +
    '\n' +
    '────────────────────\n' +
    '【予約内容】\n' +
    `  校舎  :${booking.schoolName}\n` +
    `  日時  :${dateLabel} ${booking.time}\n` +
    `  お子様:${booking.childName} 様 (${booking.grade || '学年未設定'})\n` +
    `  保護者:${booking.parentName} 様\n` +
    `  メール:${booking.email}\n` +
    `  ご相談:${booking.note || '(なし)'}\n` +
    '────────────────────\n' +
    '\n' +
    '管理画面でも確認できます。\n'
  );
}

/**
 * 新規予約が入ったことを校舎の担当者に知らせる。
 *
 * 校舎に設定されている通知先へ送る。メールとLINE WORKSの両方が
 * 設定されていれば両方に送る(RED部門はメール、中等部はLINE WORKSを想定)。
 * 送信に失敗しても例外を投げない(予約処理を止めないため)。
 */
export async function notifyStaffNewBooking(booking) {
  const results = [];
  const dateLabel = formatJapaneseDate(booking.date);
  const school = await findSchoolByIdAnyDepartment(booking.schoolId).catch(() => null);

  // --- メール ---
  try {
    const to = await getNotifyEmail(booking.schoolId);
    if (to) {
      const subject = `【新規予約】${booking.schoolName} ${dateLabel} ${booking.time}`;
      results.push(await sendMail({ to, subject, text: newBookingText(booking) }));
    }
  } catch (err) {
    console.error('新規予約通知(メール)の送信に失敗:', err);
    results.push({ sent: false, reason: String(err) });
  }

  // --- LINE WORKS ---
  try {
    const channelId = school ? String(school.line_works_channel_id || '').trim() : '';
    if (channelId && isLineWorksConfigured()) {
      const text =
        '新規予約が入りました。\n' +
        '──────────\n' +
        `校舎:${booking.schoolName}\n` +
        `日時:${dateLabel} ${booking.time}\n` +
        `お子様:${booking.childName} さん (${booking.grade || '学年未設定'})\n` +
        `保護者:${booking.parentName} 様\n` +
        `ご相談:${booking.note || '(なし)'}`;
      results.push(await sendChannelMessage(channelId, text));
    }
  } catch (err) {
    console.error('新規予約通知(LINE WORKS)の送信に失敗:', err);
    results.push({ sent: false, reason: String(err) });
  }

  const sent = results.some((r) => r && r.sent);
  return { sent, reason: sent ? undefined : 'no-recipient', results };
}

/** 面談前日のリマインドメールを1通送る */
export async function sendOneReminder(booking) {
  const dateLabel = formatJapaneseDate(booking.date);
  const subject = '【面談のご案内】明日の面談についてのリマインド';
  const text =
    `${booking.parentName} 様\n` +
    '\n' +
    'いつもお世話になっております。\n' +
    '明日の面談についてリマインドのご連絡です。\n' +
    '\n' +
    '────────────────────\n' +
    '【面談予定】\n' +
    `  日時:${dateLabel} ${booking.time}\n` +
    `  校舎:${booking.schoolName}\n` +
    `  お子様:${booking.childName} 様\n` +
    '────────────────────\n' +
    '\n' +
    'お忙しい中とは存じますが、お気をつけてお越しください。\n' +
    'お待ちしております。\n' +
    '\n' +
    '\n' +
    '────────────────────\n' +
    '※ ご変更・キャンセルの際は、お通いの校舎まで直接お電話にてご連絡ください。\n' +
    '※ このメールは送信専用です。返信されてもご対応できかねます。\n' +
    '────────────────────\n';

  return sendMail({ to: booking.email, subject, text });
}

/** 翌日の予約のうち、リマインド対象になりうるものを引く */
async function fetchTomorrowBookings(tomorrowStr) {
  const db = getDb();
  return (
    unwrap(
      await db
        .from('bookings')
        .select(
          'id, school_id, date, time, child_name, parent_name, email, grade, note, ' +
            'status, created_at, staff_note, reminder_sent_at, interview_done, ' +
            'interview_note, interview_updated_at'
        )
        .eq('date', tomorrowStr)
        .order('school_id', { ascending: true })
        .order('time', { ascending: true }),
      '翌日の予約の取得'
    ) || []
  );
}

/**
 * 翌日に面談予約がある保護者へリマインドメールを送る(全部門が対象)。
 * 「翌日の予約」「キャンセルでない」「メールあり」「未送信」が対象。
 * 送信できたら reminder_sent_at を記録するので、1日に複数回実行しても
 * 同じ予約に2通送られることはない。
 */
export async function sendReminders() {
  const tomorrowStr = addDays(todayStr(), 1);
  const db = getDb();
  // リマインドは全部門をまとめて処理する(Cronは1日2回だけ動かせばよい)
  const schools = await listAllSchools();
  const byId = new Map(schools.map((s) => [s.id, s]));
  const rows = await fetchTomorrowBookings(tomorrowStr);

  let sentCount = 0;
  let errorCount = 0;
  const errors = [];

  for (const row of rows) {
    if (row.status === 'cancelled') continue;
    if (!String(row.email || '').trim()) continue;
    if (row.reminder_sent_at) continue;

    const school = byId.get(row.school_id);
    try {
      const booking = toBooking(row, school);
      const result = await sendOneReminder(booking);
      if (result && result.sent === false && result.reason === 'not-configured') {
        throw new Error('メール送信の設定がされていません');
      }
      unwrap(
        await db
          .from('bookings')
          .update({ reminder_sent_at: new Date().toISOString() })
          .eq('id', row.id),
        'リマインド送信状態の記録'
      );
      sentCount++;
    } catch (err) {
      errorCount++;
      errors.push(`${school ? school.name : row.school_id} / ${row.child_name} (${row.email}): ${err}`);
      console.error('リマインド送信失敗:', row.school_id, row.email, err);
    }
  }

  const departments = await listDepartments({ includeInactive: true });
  return {
    ok: true,
    target: tomorrowStr,
    departments: departments.map((d) => d.name),
    sent: sentCount,
    failed: errorCount,
    errors,
  };
}

/**
 * リマインドが送られない原因を診断する(GAS版の diagnoseReminders 相当)。
 * 管理画面から呼ばれるので、その部門の予約だけを見る。
 */
export async function diagnoseReminders(dept) {
  const tomorrowStr = addDays(todayStr(), 1);
  const schools = await listSchools(dept, { includeInactive: true });
  const byId = new Map(schools.map((s) => [s.id, s]));
  const rows = (await fetchTomorrowBookings(tomorrowStr)).filter((r) => byId.has(r.school_id));

  const grouped = new Map();
  let totalWouldSend = 0;

  rows.forEach((row) => {
    const email = String(row.email || '').trim();
    let reason;
    if (row.status === 'cancelled') reason = 'キャンセル済';
    else if (!email) reason = 'メール空欄';
    else if (row.reminder_sent_at) reason = `送信済(${formatDateTime(row.reminder_sent_at)})`;
    else { reason = '送信対象'; totalWouldSend++; }

    const school = byId.get(row.school_id);
    const name = school ? school.name : row.school_id;
    const list = grouped.get(name) || [];
    list.push({ childName: row.child_name, email, reason });
    grouped.set(name, list);
  });

  return {
    ok: true,
    timezone: process.env.TIMEZONE || 'Asia/Tokyo',
    mailer: mailerMode(),
    tomorrow: tomorrowStr,
    perSchool: [...grouped].map(([school, bookings]) => ({ school, bookings })),
    totalTarget: rows.length,
    totalWouldSend,
  };
}
