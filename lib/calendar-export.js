/**
 * 予約一覧を月カレンダー形式のGoogleスプレッドシートに書き出す。
 * GAS版の adminExportCalendar / writeMonthCalendar を移植したもの。
 *
 * 出力先フォルダは CALENDAR_OUTPUT_FOLDER_ID(未設定ならGAS版と同じ「カレンダー」フォルダ)。
 * サービスアカウントがそのフォルダに編集権限を持っている必要がある。
 */

import { findSchoolById } from './schools.js';
import { getSheetsApi, getDriveApi } from './sheets.js';
import { getAllBookings } from './store.js';
import { TIMEZONE, nowStamp } from './format.js';

const DEFAULT_FOLDER_ID = '1SzWdk5JFEs9Ca1oLKJX7_mFXjaJOvA9b';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const WEEK_BG = ['#FED7D7', '#EDF2F7', '#EDF2F7', '#EDF2F7', '#EDF2F7', '#EDF2F7', '#BEE3F8'];
const WEEK_FG = ['#C53030', '#2D3748', '#2D3748', '#2D3748', '#2D3748', '#2D3748', '#2B6CB0'];

/** '#RRGGBB' を Sheets API の色オブジェクトに変換 */
function rgb(hex) {
  const h = hex.replace('#', '');
  return {
    red: parseInt(h.slice(0, 2), 16) / 255,
    green: parseInt(h.slice(2, 4), 16) / 255,
    blue: parseInt(h.slice(4, 6), 16) / 255,
  };
}

function cell(value, format) {
  const userEnteredValue =
    value === '' || value === null || value === undefined
      ? {}
      : typeof value === 'number'
        ? { numberValue: value }
        : { stringValue: String(value) };
  return { userEnteredValue, userEnteredFormat: format || {} };
}

function emptyGrid(rows, cols) {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => cell('')));
}

/**
 * 1ヶ月分のカレンダーを組み立て、Sheets API のリクエスト配列を返す。
 */
export function buildMonthRequests(sheetId, year, month, school, byDate, startDate, endDate) {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  // 各日のセル位置を決める(GAS版と同じく、週ごとに「日付行 + 内容行」の2行を使う)
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

  const grid = emptyGrid(footerRow, 7);

  // タイトル行
  grid[0][0] = cell(`${school.name}  ${year}年${month}月  面談予約カレンダー`, {
    textFormat: { bold: true, fontSize: 14, foregroundColor: rgb('#FFFFFF') },
    backgroundColor: rgb('#2c5282'),
    horizontalAlignment: 'CENTER',
    verticalAlignment: 'MIDDLE',
  });

  // 対象期間の行
  grid[1][0] = cell(`対象期間:${startDate} 〜 ${endDate}`, {
    textFormat: { fontSize: 9, foregroundColor: rgb('#718096') },
    horizontalAlignment: 'CENTER',
  });

  // 曜日ヘッダー
  WEEKDAYS.forEach((w, i) => {
    grid[2][i] = cell(w, {
      textFormat: { bold: true, fontSize: 11, foregroundColor: rgb(WEEK_FG[i]) },
      backgroundColor: rgb(WEEK_BG[i]),
      horizontalAlignment: 'CENTER',
    });
  });

  // 日付セルと内容セル
  placements.forEach(({ day, row: r, col: c }) => {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dayOfWeek = (c - 1) % 7;
    const inRange = dateStr >= startDate && dateStr <= endDate;

    let fg = '#2D3748';
    if (dayOfWeek === 0) fg = '#C53030';
    else if (dayOfWeek === 6) fg = '#2B6CB0';
    if (!inRange) fg = '#A0AEC0';

    grid[r - 1][c - 1] = cell(day, {
      textFormat: { bold: true, fontSize: 11, foregroundColor: rgb(fg) },
      backgroundColor: rgb(inRange ? '#F7FAFC' : '#EDF2F7'),
      horizontalAlignment: 'LEFT',
      verticalAlignment: 'TOP',
    });

    const bookings = byDate[dateStr] || [];
    const text = bookings
      .map((b) => `${b.time} ${b.childName || ''}${b.grade ? `(${b.grade})` : ''}`)
      .join('\n');

    let bg = null;
    if (!inRange) bg = '#F7FAFC';
    else if (bookings.length > 0) bg = '#FFFAF0'; // 予約ありは薄いオレンジ

    grid[r][c - 1] = cell(text, {
      textFormat: { fontSize: 9 },
      wrapStrategy: 'WRAP',
      verticalAlignment: 'TOP',
      horizontalAlignment: 'LEFT',
      ...(bg ? { backgroundColor: rgb(bg) } : {}),
    });
  });

  // フッター
  grid[footerRow - 1][0] = cell(
    `※キャンセル済みの予約は表示していません / 出力日時:${nowStamp()}`,
    {
      textFormat: { fontSize: 8, foregroundColor: rgb('#718096') },
      horizontalAlignment: 'RIGHT',
    }
  );

  const requests = [
    {
      updateCells: {
        start: { sheetId, rowIndex: 0, columnIndex: 0 },
        rows: grid.map((r) => ({ values: r })),
        fields: 'userEnteredValue,userEnteredFormat',
      },
    },
    // タイトル・対象期間・フッターは7列を結合
    ...[1, 2, footerRow].map((r) => ({
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: r - 1,
          endRowIndex: r,
          startColumnIndex: 0,
          endColumnIndex: 7,
        },
        mergeType: 'MERGE_ROWS',
      },
    })),
    // 列幅
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 7 },
        properties: { pixelSize: 140 },
        fields: 'pixelSize',
      },
    },
    // タイトル行と曜日行の高さ
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 36 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 2, endIndex: 3 },
        properties: { pixelSize: 24 },
        fields: 'pixelSize',
      },
    },
    // ヘッダー3行を固定
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 3 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
  ];

  // 日付行(22px)と内容行(90px)の高さ
  for (let r = 4; r < lastRow; r++) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: r - 1, endIndex: r },
        properties: { pixelSize: (r - 4) % 2 === 0 ? 22 : 90 },
        fields: 'pixelSize',
      },
    });
  }

  // 罫線
  if (lastRow - 4 > 0) {
    const border = { style: 'SOLID', color: rgb('#CBD5E0') };
    requests.push({
      updateBorders: {
        range: {
          sheetId,
          startRowIndex: 3,
          endRowIndex: lastRow - 1,
          startColumnIndex: 0,
          endColumnIndex: 7,
        },
        top: border,
        bottom: border,
        left: border,
        right: border,
        innerHorizontal: border,
        innerVertical: border,
      },
    });
  }

  return requests;
}

/**
 * 指定期間・指定校舎の予約を月カレンダー形式で書き出す。
 * @returns {{ok: boolean, url?: string, count?: number, fileName?: string, warning?: string, error?: string}}
 */
export async function exportCalendar(body) {
  const { schoolId, startDate, endDate } = body || {};
  const school = findSchoolById(schoolId);
  if (!school) return { ok: false, error: '校舎が見つかりません' };
  if (!startDate || !endDate) return { ok: false, error: '期間が指定されていません' };
  if (startDate > endDate) return { ok: false, error: '開始日が終了日より後になっています' };

  const all = await getAllBookings(schoolId);
  const target = all.filter(
    (b) => b.status !== 'cancelled' && b.date >= startDate && b.date <= endDate
  );

  const byDate = {};
  target.forEach((b) => {
    if (!byDate[b.date]) byDate[b.date] = [];
    byDate[b.date].push(b);
  });
  Object.keys(byDate).forEach((d) =>
    byDate[d].sort((a, b) => a.time.localeCompare(b.time))
  );

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

  const stamp = nowStamp().replace(/[-: ]/g, '').slice(0, 13);
  const fileName =
    `面談予約カレンダー_${school.name}_` +
    `${startDate.replace(/-/g, '')}-${endDate.replace(/-/g, '')}_${stamp}`;

  const drive = await getDriveApi();
  const sheets = await getSheetsApi();
  const folderId = process.env.CALENDAR_OUTPUT_FOLDER_ID || DEFAULT_FOLDER_ID;

  // 共有フォルダの中に直接作成する。失敗したらフォルダ指定なしで作り直す。
  let fileId;
  let warning = '';
  try {
    const created = await drive.files.create({
      supportsAllDrives: true,
      fields: 'id',
      requestBody: {
        name: fileName,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        parents: folderId ? [folderId] : undefined,
      },
    });
    fileId = created.data.id;
  } catch (err) {
    console.warn('共有フォルダへの作成に失敗、フォルダ指定なしで作成します:', err.message);
    warning =
      'カレンダー用フォルダに作成できませんでした(サービスアカウントの権限をご確認ください)。' +
      'ファイルはサービスアカウントのドライブ直下に作成されています。';
    const created = await drive.files.create({
      fields: 'id',
      requestBody: {
        name: fileName,
        mimeType: 'application/vnd.google-apps.spreadsheet',
      },
    });
    fileId = created.data.id;
  }

  // 月ごとのシートを用意する(1つ目は既定のシートを使い回す)
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: fileId,
    fields: 'sheets.properties(sheetId,title)',
  });
  const firstSheetId = meta.data.sheets[0].properties.sheetId;

  const setupRequests = months.map((mi, idx) => {
    const title = `${mi.y}年${mi.m}月`;
    return idx === 0
      ? { updateSheetProperties: { properties: { sheetId: firstSheetId, title }, fields: 'title' } }
      : { addSheet: { properties: { title } } };
  });
  const setupRes = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: fileId,
    requestBody: { requests: setupRequests },
  });

  const sheetIds = months.map((_, idx) => {
    if (idx === 0) return firstSheetId;
    const reply = setupRes.data.replies[idx];
    return reply.addSheet.properties.sheetId;
  });

  // 各月の中身を書き込む
  const requests = months.flatMap((mi, idx) =>
    buildMonthRequests(sheetIds[idx], mi.y, mi.m, school, byDate, startDate, endDate)
  );
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: fileId,
    requestBody: { requests },
  });

  // 職員が開けるように共有設定(任意)
  const shareWith = String(process.env.CALENDAR_SHARE_WITH || '').trim();
  if (shareWith) {
    for (const addr of shareWith.split(',').map((x) => x.trim()).filter(Boolean)) {
      try {
        await drive.permissions.create({
          fileId,
          supportsAllDrives: true,
          sendNotificationEmail: false,
          requestBody: { type: 'user', role: 'reader', emailAddress: addr },
        });
      } catch (err) {
        console.warn('カレンダーの共有設定に失敗:', addr, err.message);
      }
    }
  }

  return {
    ok: true,
    url: `https://docs.google.com/spreadsheets/d/${fileId}/edit`,
    count: target.length,
    fileName,
    timezone: TIMEZONE,
    warning,
  };
}
