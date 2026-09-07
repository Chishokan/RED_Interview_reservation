/** テスト用のインメモリ Google Sheets API モック */
import { google } from 'googleapis';

const store = new Map(); // title -> { sheetId, rows: [][] }
let nextSheetId = 100;

export function resetStore() { store.clear(); nextSheetId = 100; }
export function addSheet(title, rows) {
  store.set(title, { sheetId: nextSheetId++, rows: rows.map(r => r.slice()) });
}
export function dumpSheet(title) { return store.get(title).rows.map(r => r.slice()); }

function colToNum(s) {
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function parseRange(range) {
  const bang = range.lastIndexOf('!');
  let title = range.slice(0, bang);
  const a1 = range.slice(bang + 1);
  if (title.startsWith("'")) title = title.slice(1, -1).replace(/''/g, "'");
  const m = a1.match(/^([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/);
  if (!m) throw new Error('range parse error: ' + a1);
  return {
    title,
    c1: colToNum(m[1]), r1: m[2] ? Number(m[2]) : 1,
    c2: m[3] ? colToNum(m[3]) : colToNum(m[1]),
    r2: m[4] ? Number(m[4]) : (m[3] ? Infinity : (m[2] ? Number(m[2]) : Infinity)),
  };
}
function ensure(sheet, r, c) {
  while (sheet.rows.length < r) sheet.rows.push([]);
  const row = sheet.rows[r - 1];
  while (row.length < c) row.push('');
}
function lastDataRow(sheet) {
  for (let i = sheet.rows.length - 1; i >= 0; i--) {
    if (sheet.rows[i].some(v => v !== '' && v !== null && v !== undefined)) return i + 1;
  }
  return 0;
}

const values = {
  async get({ range }) {
    const p = parseRange(range);
    const sheet = store.get(p.title);
    if (!sheet) { const e = new Error('Unable to parse range'); e.code = 400; throw e; }
    const end = Math.min(p.r2, lastDataRow(sheet));
    const out = [];
    for (let r = p.r1; r <= end; r++) {
      const row = sheet.rows[r - 1] || [];
      const slice = [];
      for (let c = p.c1; c <= p.c2; c++) slice.push(row[c - 1] ?? '');
      while (slice.length && (slice[slice.length - 1] === '' )) slice.pop();
      out.push(slice);
    }
    while (out.length && out[out.length - 1].length === 0) out.pop();
    return { data: { values: out } };
  },
  async append({ range, requestBody }) {
    const p = parseRange(range);
    const sheet = store.get(p.title);
    if (!sheet) throw new Error('no sheet ' + p.title);
    let row = lastDataRow(sheet) + 1;
    const first = row;
    for (const vals of requestBody.values) {
      ensure(sheet, row, vals.length);
      vals.forEach((v, i) => { sheet.rows[row - 1][i] = v; });
      row++;
    }
    return { data: { updates: { updatedRange: `'${p.title}'!A${first}:O${row - 1}` } } };
  },
  async update({ range, requestBody }) {
    const p = parseRange(range);
    const sheet = store.get(p.title);
    requestBody.values.forEach((vals, ri) => {
      vals.forEach((v, ci) => {
        ensure(sheet, p.r1 + ri, p.c1 + ci);
        sheet.rows[p.r1 + ri - 1][p.c1 + ci - 1] = v;
      });
    });
    return { data: {} };
  },
  async batchUpdate({ requestBody }) {
    for (const d of requestBody.data) await values.update({ range: d.range, requestBody: { values: d.values } });
    return { data: {} };
  },
  async batchGet({ ranges }) {
    const valueRanges = [];
    for (const range of ranges) {
      try {
        const r = await values.get({ range });
        valueRanges.push({ range, values: r.data.values });
      } catch {
        valueRanges.push({ range, values: [] });
      }
    }
    return { data: { valueRanges } };
  },
};

const spreadsheets = {
  values,
  async get() {
    return {
      data: {
        sheets: [...store.entries()].map(([title, s]) => ({
          properties: { sheetId: s.sheetId, title, gridProperties: {} },
        })),
      },
    };
  },
  async batchUpdate({ requestBody }) {
    const replies = [];
    for (const req of requestBody.requests) {
      if (req.addSheet) {
        const title = req.addSheet.properties.title;
        addSheet(title, []);
        replies.push({ addSheet: { properties: { sheetId: store.get(title).sheetId, title } } });
      } else if (req.deleteDimension) {
        const { sheetId, startIndex, endIndex } = req.deleteDimension.range;
        const entry = [...store.values()].find(s => s.sheetId === sheetId);
        entry.rows.splice(startIndex, endIndex - startIndex);
        replies.push({});
      } else {
        replies.push({}); // 書式系はテストでは無視
      }
    }
    return { data: { replies } };
  },
};

export function installFakes() {
  google.auth.JWT = class { constructor() {} authorize() { return Promise.resolve(); } };
  google.sheets = () => ({ spreadsheets });
  google.drive = () => ({ files: { create: async () => ({ data: { id: 'fakeFileId' } }) }, permissions: { create: async () => ({}) } });
}
