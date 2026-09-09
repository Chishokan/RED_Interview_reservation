/**
 * 予約一覧を月カレンダー形式のExcelファイル(.xlsx)として書き出す。
 *
 * GAS版はGoogleドライブに新しいスプレッドシートを作っていたが、
 * Supabase版にはGoogleの認証情報が無いため、同じ体裁のExcelファイルを
 * その場で生成して管理画面からダウンロードしてもらう方式にしている。
 * ダウンロードしたファイルはGoogleスプレッドシートでもExcelでも開ける。
 */

import ExcelJS from 'exceljs';
import { findSchoolById } from './schools.js';
import { getAllBookings } from './store.js';
import { nowStamp } from './format.js';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const WEEK_BG = ['#FED7D7', '#EDF2F7', '#EDF2F7', '#EDF2F7', '#EDF2F7', '#EDF2F7', '#BEE3F8'];
const WEEK_FG = ['#C53030', '#2D3748', '#2D3748', '#2D3748', '#2D3748', '#2D3748', '#2B6CB0'];

/** '#RRGGBB' を Excel の ARGB 表記に変換 */
function argb(hex) {
  return 'FF' + hex.replace('#', '').toUpperCase();
}

function cell(value, style) {
  return { value, style: style || {} };
}

/**
 * 1ヶ月分のカレンダーの中身を組み立てる。
 *
 * 表示の計算だけを行い、Excelの書き込みはしない(そのぶん単体でテストできる)。
 * GAS版と同じく、週ごとに「日付行 + 内容行」の2行を使う。
 */
export function buildMonthLayout(year, month, school, byDate, startDate, endDate) {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const placements = [];
  let row = 4;
  let col = firstWeekday + 1;
  for (let d = 1; d <= daysInMonth; d++) {
    placements.push({ day: d, row, col });
    col++;
    if (col > 7) {
      col = 1;
      row += 2;
    }
  }
  const lastRow = col === 1 ? row : row + 2;
  const footerRow = lastRow + 1;

  const rows = Array.from({ length: footerRow }, () =>
    Array.from({ length: 7 }, () => cell(null))
  );

  // タイトル行
  rows[0][0] = cell(`${school.name}  ${year}年${month}月  面談予約カレンダー`, {
    bold: true, size: 14, color: '#FFFFFF', bg: '#2C5282',
    align: 'center', valign: 'middle',
  });

  // 対象期間の行
  rows[1][0] = cell(`対象期間:${startDate} 〜 ${endDate}`, {
    size: 9, color: '#718096', align: 'center',
  });

  // 曜日ヘッダー
  WEEKDAYS.forEach((w, i) => {
    rows[2][i] = cell(w, {
      bold: true, size: 11, color: WEEK_FG[i], bg: WEEK_BG[i], align: 'center',
    });
  });

  // 日付セルと内容セル
  placements.forEach(({ day, row: r, col: c }) => {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dayOfWeek = (c - 1) % 7;
    const inRange = dateStr >= startDate && dateStr <= endDate;

    let color = '#2D3748';
    if (dayOfWeek === 0) color = '#C53030';
    else if (dayOfWeek === 6) color = '#2B6CB0';
    if (!inRange) color = '#A0AEC0';

    rows[r - 1][c - 1] = cell(day, {
      bold: true, size: 11, color,
      bg: inRange ? '#F7FAFC' : '#EDF2F7',
      align: 'left', valign: 'top',
    });

    const bookings = byDate[dateStr] || [];
    const text = bookings
      .map((b) => `${b.time} ${b.childName || ''}${b.grade ? `(${b.grade})` : ''}`)
      .join('\n');

    let bg = null;
    if (!inRange) bg = '#F7FAFC';
    else if (bookings.length > 0) bg = '#FFFAF0'; // 予約ありは薄いオレンジ

    rows[r][c - 1] = cell(text || null, {
      size: 9, wrap: true, valign: 'top', align: 'left',
      ...(bg ? { bg } : {}),
    });
  });

  // フッター
  rows[footerRow - 1][0] = cell(
    `※キャンセル済みの予約は表示していません / 出力日時:${nowStamp()}`,
    { size: 8, color: '#718096', align: 'right' }
  );

  return {
    rows,
    lastRow,
    footerRow,
    merges: [1, 2, footerRow].map((r) => ({ row: r, fromCol: 1, toCol: 7 })),
  };
}

/** 組み立てたレイアウトをExcelのシートに書き込む */
function writeMonthSheet(ws, layout) {
  layout.rows.forEach((cols, ri) => {
    cols.forEach((c, ci) => {
      const target = ws.getCell(ri + 1, ci + 1);
      if (c.value !== null && c.value !== undefined) target.value = c.value;
      const st = c.style;
      if (st.bold || st.size || st.color) {
        target.font = {
          bold: !!st.bold,
          size: st.size || 11,
          ...(st.color ? { color: { argb: argb(st.color) } } : {}),
        };
      }
      if (st.bg) {
        target.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(st.bg) } };
      }
      if (st.align || st.valign || st.wrap) {
        target.alignment = {
          ...(st.align ? { horizontal: st.align } : {}),
          ...(st.valign ? { vertical: st.valign } : {}),
          ...(st.wrap ? { wrapText: true } : {}),
        };
      }
    });
  });

  layout.merges.forEach((m) => ws.mergeCells(m.row, m.fromCol, m.row, m.toCol));

  // 列幅(GAS版の140px相当)と行の高さ
  for (let c = 1; c <= 7; c++) ws.getColumn(c).width = 20;
  ws.getRow(1).height = 27;
  ws.getRow(3).height = 18;
  for (let r = 4; r < layout.lastRow; r++) {
    ws.getRow(r).height = (r - 4) % 2 === 0 ? 17 : 68; // 日付行 / 内容行
  }

  // 罫線
  const border = { style: 'thin', color: { argb: argb('#CBD5E0') } };
  for (let r = 4; r < layout.lastRow; r++) {
    for (let c = 1; c <= 7; c++) {
      ws.getCell(r, c).border = { top: border, left: border, bottom: border, right: border };
    }
  }

  ws.views = [{ state: 'frozen', ySplit: 3 }];
}

/**
 * 指定期間・指定校舎の予約を月カレンダー形式のExcelにする。
 * @returns {{ok: true, buffer: Buffer, fileName: string, count: number} | {ok: false, error: string}}
 */
export async function exportCalendar(body) {
  const { schoolId, startDate, endDate, dept } = body || {};
  const school = await findSchoolById(schoolId, dept);
  if (!school) return { ok: false, error: '校舎が見つかりません' };
  if (!startDate || !endDate) return { ok: false, error: '期間が指定されていません' };
  if (startDate > endDate) return { ok: false, error: '開始日が終了日より後になっています' };

  const all = await getAllBookings(schoolId, dept);
  const target = all.filter(
    (b) => b.status !== 'cancelled' && b.date >= startDate && b.date <= endDate
  );

  const byDate = {};
  target.forEach((b) => {
    if (!byDate[b.date]) byDate[b.date] = [];
    byDate[b.date].push(b);
  });
  Object.keys(byDate).forEach((d) => byDate[d].sort((a, b) => a.time.localeCompare(b.time)));

  // 期間が含む月の一覧
  const months = [];
  const [sy, sm] = startDate.split('-').map(Number);
  const [ey, em] = endDate.split('-').map(Number);
  let cy = sy;
  let cmo = sm;
  while (cy < ey || (cy === ey && cmo <= em)) {
    months.push({ y: cy, m: cmo });
    cmo++;
    if (cmo > 12) { cmo = 1; cy++; }
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = '面談予約システム';
  workbook.created = new Date();

  months.forEach(({ y, m }) => {
    const ws = workbook.addWorksheet(`${y}年${m}月`);
    writeMonthSheet(ws, buildMonthLayout(y, m, school, byDate, startDate, endDate));
  });

  const stamp = nowStamp().replace(/[-: ]/g, '').slice(0, 12);
  const fileName =
    `面談予約カレンダー_${school.name}_` +
    `${startDate.replace(/-/g, '')}-${endDate.replace(/-/g, '')}_${stamp}.xlsx`;

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { ok: true, buffer, fileName, count: target.length };
}
