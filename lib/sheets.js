/**
 * Googleスプレッドシートを「DB」として読み書きするための薄いラッパー。
 *
 * GAS版の SpreadsheetApp.getActiveSpreadsheet() に相当する部分を
 * Google Sheets API v4 に置き換えている。認証はサービスアカウント。
 *
 * 必要な環境変数:
 *   SPREADSHEET_ID              対象スプレッドシートのID
 *   GOOGLE_SERVICE_ACCOUNT_JSON サービスアカウントのJSON鍵(生JSON or base64)
 *   ── もしくは ──
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY
 */

import { google } from 'googleapis';

export const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

let authClientPromise = null;

function loadCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw && raw.trim()) {
    const text = raw.trim().startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf8');
    const json = JSON.parse(text);
    return {
      client_email: json.client_email,
      private_key: String(json.private_key || '').replace(/\\n/g, '\n'),
    };
  }
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY;
  if (email && key) {
    return { client_email: email, private_key: String(key).replace(/\\n/g, '\n') };
  }
  throw new Error(
    'サービスアカウントの認証情報が設定されていません。' +
      'GOOGLE_SERVICE_ACCOUNT_JSON か GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY を設定してください。'
  );
}

export function getAuth() {
  if (!authClientPromise) {
    const creds = loadCredentials();
    const jwt = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: SCOPES,
    });
    authClientPromise = jwt.authorize().then(() => jwt);
  }
  return authClientPromise;
}

export async function getSheetsApi() {
  const auth = await getAuth();
  return google.sheets({ version: 'v4', auth });
}

export async function getDriveApi() {
  const auth = await getAuth();
  return google.drive({ version: 'v3', auth });
}

export function getSpreadsheetId() {
  const id = process.env.SPREADSHEET_ID;
  if (!id) throw new Error('SPREADSHEET_ID が設定されていません。');
  return id;
}

// ===== シートのメタ情報(タイトル -> sheetId)のキャッシュ =====
// サーバーレス関数の1インスタンス内でのみ有効。行の削除に sheetId が要るため保持する。
let metaCachePromise = null;

async function fetchMeta() {
  const sheets = await getSheetsApi();
  const res = await sheets.spreadsheets.get({
    spreadsheetId: getSpreadsheetId(),
    fields: 'sheets.properties(sheetId,title,gridProperties)',
  });
  return new Map((res.data.sheets || []).map((s) => [s.properties.title, s.properties]));
}

/**
 * シート一覧を取得する。取得中のPromiseを共有するので、
 * 複数のシートを並行して読んでもメタ情報のリクエストは1回で済む。
 */
async function loadMeta(force = false) {
  if (!metaCachePromise || force) {
    metaCachePromise = fetchMeta().catch((err) => {
      metaCachePromise = null; // 失敗したキャッシュは残さない
      throw err;
    });
  }
  return metaCachePromise;
}

export function invalidateMetaCache() {
  metaCachePromise = null;
}

/** シートのプロパティ(sheetId等)を取得。存在しなければ null */
export async function getSheetProps(title) {
  const meta = await loadMeta();
  if (meta.has(title)) return meta.get(title);
  // キャッシュが古い可能性があるので、1度だけ取り直して確認する
  const fresh = await loadMeta(true);
  return fresh.get(title) || null;
}

/** シートが存在するか */
export async function sheetExists(title) {
  return (await getSheetProps(title)) !== null;
}

/** 列番号(1-indexed)を A1 記法の列名に変換 */
export function colLetter(n) {
  let s = '';
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

/** シート名を A1 記法で使えるようにクォートする */
export function quoteSheetName(title) {
  return "'" + String(title).replace(/'/g, "''") + "'";
}

/**
 * シート全体(ヘッダー行を除く)を2次元配列で読む。
 * シートが無い場合は null を返す(GAS版の getSheetByName() === null 相当)。
 */
export async function readRows(title, colCount) {
  if (!(await sheetExists(title))) return null;
  const sheets = await getSheetsApi();
  const range = `${quoteSheetName(title)}!A2:${colLetter(colCount)}`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER',
  });
  const rows = res.data.values || [];
  // 行ごとに列数を揃える(末尾の空セルは省略されて返ってくるため)
  return rows.map((r) => {
    const out = r.slice(0, colCount);
    while (out.length < colCount) out.push('');
    return out;
  });
}

/** 1行追記する。追記された行番号(1-indexed)を返す */
export async function appendRow(title, values) {
  const sheets = await getSheetsApi();
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: getSpreadsheetId(),
    range: `${quoteSheetName(title)}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    includeValuesInResponse: false,
    requestBody: { values: [values] },
  });
  const updatedRange = res.data.updates && res.data.updates.updatedRange;
  const m = updatedRange && updatedRange.match(/![A-Z]+(\d+)/);
  return m ? Number(m[1]) : null;
}

/** 複数行をまとめて追記する */
export async function appendRows(title, rows) {
  if (!rows.length) return 0;
  const sheets = await getSheetsApi();
  await sheets.spreadsheets.values.append({
    spreadsheetId: getSpreadsheetId(),
    range: `${quoteSheetName(title)}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
  return rows.length;
}

/**
 * 1行の中の複数セルをまとめて更新する。
 * updates は [{ col, value }] の配列。列がとびとびでも1リクエストで処理する。
 */
export async function updateCells(title, row, updates) {
  if (!updates.length) return;
  const sheets = await getSheetsApi();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: getSpreadsheetId(),
    requestBody: {
      valueInputOption: 'RAW',
      data: updates.map((u) => ({
        range: `${quoteSheetName(title)}!${colLetter(u.col)}${row}`,
        values: [[u.value]],
      })),
    },
  });
}

/** 任意のセル範囲をまとめて更新する。data は [{ range(A1・シート名なし), values }] */
export async function batchUpdateValues(title, data) {
  if (!data.length) return;
  const sheets = await getSheetsApi();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: getSpreadsheetId(),
    requestBody: {
      valueInputOption: 'RAW',
      data: data.map((d) => ({
        range: `${quoteSheetName(title)}!${d.range}`,
        values: d.values,
      })),
    },
  });
}

/**
 * 複数行を削除する(rowNums は 1-indexed)。
 * 行ズレを防ぐため大きい行番号から削除する。
 */
export async function deleteRows(title, rowNums) {
  const props = await getSheetProps(title);
  if (!props) throw new Error('シートが見つかりません: ' + title);
  const sorted = [...new Set(rowNums)].sort((a, b) => b - a);
  if (!sorted.length) return 0;
  const sheets = await getSheetsApi();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: getSpreadsheetId(),
    requestBody: {
      requests: sorted.map((rowNum) => ({
        deleteDimension: {
          range: {
            sheetId: props.sheetId,
            dimension: 'ROWS',
            startIndex: rowNum - 1,
            endIndex: rowNum,
          },
        },
      })),
    },
  });
  return sorted.length;
}

const HEADER_FORMAT = {
  textFormat: { bold: true },
  backgroundColor: { red: 0.91, green: 0.94, blue: 0.996 },
};

/**
 * 複数のシートをまとめて用意する。
 *
 * - シートが無ければ作成する
 * - ヘッダー行が足りない/違う場合だけ書き込む(既存データは消さない)
 * - 見出しの書式と列幅を整える
 *
 * シートごとに個別処理すると Google API への往復が数十回になり、
 * サーバーレス関数の実行時間を超えてしまうため、種類ごとに1リクエストへまとめている。
 *
 * @param {{title: string, headers: string[], columnWidths?: number[]}[]} specs
 * @returns {Promise<{created: string[], headerUpdated: string[]}>}
 */
export async function ensureSheets(specs) {
  const sheets = await getSheetsApi();
  const spreadsheetId = getSpreadsheetId();
  const meta = await loadMeta(true);

  // 1. 足りないシートをまとめて作成する
  const missing = specs.filter((s) => !meta.has(s.title));
  const sheetIdByTitle = new Map([...meta].map(([t, p]) => [t, p.sheetId]));
  if (missing.length) {
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: missing.map((s) => ({ addSheet: { properties: { title: s.title } } })),
      },
    });
    missing.forEach((s, i) => {
      sheetIdByTitle.set(s.title, res.data.replies[i].addSheet.properties.sheetId);
    });
    invalidateMetaCache();
  }

  // 2. 既存のヘッダー行をまとめて読む
  const ranges = specs.map(
    (s) => `${quoteSheetName(s.title)}!A1:${colLetter(s.headers.length)}1`
  );
  const got = await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges });
  const valueRanges = got.data.valueRanges || [];

  // 3. 足りないヘッダーだけをまとめて書き込む
  const headerUpdated = [];
  const data = [];
  specs.forEach((spec, i) => {
    const current = (valueRanges[i] && valueRanges[i].values && valueRanges[i].values[0]) || [];
    if (spec.headers.some((h, c) => (current[c] || '') !== h)) {
      headerUpdated.push(spec.title);
      data.push({ range: ranges[i], values: [spec.headers] });
    }
  });
  if (data.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data },
    });
  }

  // 4. 見出しの書式と列幅をまとめて整える
  const requests = [];
  specs.forEach((spec) => {
    const sheetId = sheetIdByTitle.get(spec.title);
    if (sheetId === undefined) return;
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: spec.headers.length,
        },
        cell: { userEnteredFormat: HEADER_FORMAT },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    });
    (spec.columnWidths || []).forEach((w, i) => {
      requests.push({
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
          properties: { pixelSize: w },
          fields: 'pixelSize',
        },
      });
    });
  });
  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  }

  return { created: missing.map((s) => s.title), headerUpdated };
}
