/**
 * 通知メールの本文組み立てと送信。
 * GAS版の notifyStaffNewBooking / sendOneReminder / sendReminders を移植したもの。
 */

import {
  SCHOOLS,
  findSchoolById,
  bookingsSheetName,
  NOTIFY_SHEET_NAME,
  COL,
  BOOKING_COL_COUNT,
} from './schools.js';
import { formatDate, formatJapaneseDate, todayStr, addDays, nowStamp } from './format.js';
import { readRows, updateCells } from './sheets.js';
import { sendMail, mailerMode } from './mailer.js';
import { rowToBooking } from './store.js';

/**
 * 「通知先」シートから校舎ごとの通知先アドレスを読む。
 * シートが無い場合は環境変数 STAFF_NOTIFY_EMAIL をフォールバックに使う。
 */
export async function getNotifyEmail(schoolId) {
  const rows = await readRows(NOTIFY_SHEET_NAME, 3);
  if (rows) {
    for (const r of rows) {
      if (String(r[0]).trim() === schoolId) {
        const addr = String(r[2] || '').trim();
        if (addr) return addr;
        break;
      }
    }
  }
  return String(process.env.STAFF_NOTIFY_EMAIL || '').trim();
}

/**
 * 新規予約が入ったことを校舎の担当者に知らせる。
 * 送信に失敗しても例外を投げない(予約処理を止めないため)。
 */
export async function notifyStaffNewBooking(booking) {
  try {
    const to = await getNotifyEmail(booking.schoolId);
    if (!to) return { sent: false, reason: 'no-recipient' };

    const dateLabel = formatJapaneseDate(booking.date);
    const subject = `【新規予約】${booking.schoolName} ${dateLabel} ${booking.time}`;
    const text =
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
      '管理画面でも確認できます。\n';

    return await sendMail({ to, subject, text });
  } catch (err) {
    console.error('新規予約通知の送信に失敗:', err);
    return { sent: false, reason: String(err) };
  }
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

/**
 * 翌日に面談予約がある保護者へリマインドメールを送る。
 * 「翌日の予約」「キャンセルでない」「メールあり」「未送信」が対象。
 * 送信できたらL列(リマインド送信済)に日時を記録するので、1日に複数回
 * 実行しても同じ予約に2通送られることはない。
 */
export async function sendReminders() {
  const tomorrowStr = addDays(todayStr(), 1);
  let sentCount = 0;
  let errorCount = 0;
  const errors = [];

  for (const school of SCHOOLS) {
    const sheetName = bookingsSheetName(school);
    const rows = await readRows(sheetName, BOOKING_COL_COUNT);
    if (!rows) continue;

    for (let idx = 0; idx < rows.length; idx++) {
      const r = rows[idx];
      const rowNum = idx + 2;
      const date = formatDate(r[1]);
      const email = String(r[5] || '').trim();

      if (date !== tomorrowStr) continue;
      if (r[8] === 'cancelled') continue;
      if (!email) continue;
      if (r[11]) continue; // すでに送信済

      try {
        const booking = rowToBooking(r, school);
        const result = await sendOneReminder(booking);
        if (result && result.sent === false && result.reason === 'not-configured') {
          throw new Error('メール送信の設定がされていません');
        }
        await updateCells(sheetName, rowNum, [
          { col: COL.REMINDER_SENT, value: nowStamp() },
        ]);
        sentCount++;
      } catch (err) {
        errorCount++;
        errors.push(`${school.name} / ${r[3]} (${email}): ${err}`);
        console.error('リマインド送信失敗:', school.name, email, err);
      }
    }
  }

  return { ok: true, target: tomorrowStr, sent: sentCount, failed: errorCount, errors };
}

/**
 * リマインドが送られない原因を診断する(GAS版の diagnoseReminders 相当)。
 */
export async function diagnoseReminders() {
  const tomorrowStr = addDays(todayStr(), 1);
  const perSchool = [];
  let totalTarget = 0;
  let totalWouldSend = 0;

  for (const school of SCHOOLS) {
    const rows = await readRows(bookingsSheetName(school), BOOKING_COL_COUNT);
    if (!rows) continue;
    const detail = [];
    rows.forEach((r) => {
      if (formatDate(r[1]) !== tomorrowStr) return;
      totalTarget++;
      const email = String(r[5] || '').trim();
      let reason;
      if (r[8] === 'cancelled') reason = 'キャンセル済';
      else if (!email) reason = 'メール空欄';
      else if (r[11]) reason = `送信済(${r[11]})`;
      else { reason = '送信対象'; totalWouldSend++; }
      detail.push({ childName: r[3], email, reason });
    });
    if (detail.length) perSchool.push({ school: school.name, bookings: detail });
  }

  return {
    ok: true,
    timezone: process.env.TIMEZONE || 'Asia/Tokyo',
    mailer: mailerMode(),
    tomorrow: tomorrowStr,
    perSchool,
    totalTarget,
    totalWouldSend,
  };
}
