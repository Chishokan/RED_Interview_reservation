/**
 * POST /api/admin/setup (要ログイン)
 * スプレッドシート側のメンテナンス操作。GAS版のスプレッドシートメニューの代替。
 *
 * body.action:
 *   'init'          校舎ごとの予約枠・予約データシートを用意する(既存データは消さない)
 *   'notifySheet'   「通知先」シートを用意する
 *   'testNotify'    各校舎の通知先へテストメールを送る
 *   'diagnose'      リマインドが送られない原因を診断する
 *   'sendReminders' リマインドメールを手動送信する
 */
import {
  SCHOOLS,
  slotsSheetName,
  bookingsSheetName,
  SLOT_HEADERS,
  BOOKING_HEADERS,
  NOTIFY_SHEET_NAME,
  NOTIFY_HEADERS,
} from '../../lib/schools.js';
import { ensureSheets, readRows, appendRows } from '../../lib/sheets.js';
import { notifyStaffNewBooking, sendReminders, diagnoseReminders } from '../../lib/notify.js';
import { todayStr } from '../../lib/format.js';
import { requireAdmin } from '../../lib/auth.js';
import { readJsonBody, withErrorHandling, methodNotAllowed, noStore } from '../../lib/http.js';

const SLOT_WIDTHS = [110, 90, 180, 160, 70];
const BOOKING_WIDTHS = [180, 100, 80, 120, 120, 200, 90, 280, 90, 150, 250, 150, 80, 320, 150];
const NOTIFY_WIDTHS = [120, 180, 280];

/** 全校舎分のシートを用意する(不足している列の見出しも補う) */
async function initSheets() {
  const specs = SCHOOLS.flatMap((school) => [
    { title: slotsSheetName(school), headers: SLOT_HEADERS, columnWidths: SLOT_WIDTHS },
    { title: bookingsSheetName(school), headers: BOOKING_HEADERS, columnWidths: BOOKING_WIDTHS },
  ]);
  const { created, headerUpdated } = await ensureSheets(specs);
  const updated = specs.map((s) => s.title).filter((t) => !created.includes(t));
  return {
    ok: true,
    created,
    updated,
    headerUpdated,
    message:
      `新規作成: ${created.length}シート / 既存を確認・更新: ${updated.length}シート。` +
      (headerUpdated.length ? `見出しを補ったシート: ${headerUpdated.length}件。` : '') +
      '既存データはそのまま残っています。',
  };
}

/** 「通知先」シートを用意し、未登録の校舎の行を追加する */
async function initNotifySheet() {
  await ensureSheets([
    { title: NOTIFY_SHEET_NAME, headers: NOTIFY_HEADERS, columnWidths: NOTIFY_WIDTHS },
  ]);
  const rows = (await readRows(NOTIFY_SHEET_NAME, 3)) || [];
  const existing = new Set(rows.map((r) => String(r[0]).trim()).filter(Boolean));
  const toAdd = SCHOOLS.filter((s) => !existing.has(s.id)).map((s) => [s.id, s.name, '']);
  if (toAdd.length) await appendRows(NOTIFY_SHEET_NAME, toAdd);
  return {
    ok: true,
    added: toAdd.length,
    message:
      `「${NOTIFY_SHEET_NAME}」シートを準備しました(${toAdd.length}校舎を追加)。` +
      'C列に各校舎の担当者アドレスを記入してください(カンマ区切りで複数可)。',
  };
}

/** 各校舎の通知先設定が正しいか、テストメールを送って確認する */
async function testNotify() {
  const rows = (await readRows(NOTIFY_SHEET_NAME, 3)) || [];
  if (!rows.length) {
    return {
      ok: false,
      error: `「${NOTIFY_SHEET_NAME}」シートがありません。先に「通知先シートを作成」を実行してください。`,
    };
  }
  let sent = 0;
  const noAddr = [];
  for (const r of rows) {
    const schoolId = String(r[0]).trim();
    const schoolName = String(r[1]).trim();
    const addr = String(r[2] || '').trim();
    if (!addr) { noAddr.push(schoolName || schoolId); continue; }
    await notifyStaffNewBooking({
      schoolId,
      schoolName,
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
    noAddress: noAddr,
    message:
      `通知テストを送信しました。送信: ${sent}校舎` +
      (noAddr.length ? ` / 未設定(送信なし): ${noAddr.join('、')}` : ''),
  };
}

export default withErrorHandling(async (req, res) => {
  noStore(res);
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const body = await readJsonBody(req);
  switch (body.action) {
    case 'init':
      return res.status(200).json(await initSheets());
    case 'notifySheet':
      return res.status(200).json(await initNotifySheet());
    case 'testNotify':
      return res.status(200).json(await testNotify());
    case 'diagnose':
      return res.status(200).json(await diagnoseReminders());
    case 'sendReminders':
      return res.status(200).json(await sendReminders());
    default:
      return res.status(400).json({ ok: false, error: '不明な操作です: ' + body.action });
  }
});
