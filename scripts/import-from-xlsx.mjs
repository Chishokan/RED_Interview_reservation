#!/usr/bin/env node
/**
 * 既存のGoogleスプレッドシートのデータを Supabase に移行するスクリプト。
 *
 * 【使い方】
 *  1. スプレッドシートを開き、ファイル → ダウンロード → Microsoft Excel (.xlsx)
 *     でダウンロードする(1ファイルに全シートが入ります)
 *  2. .env.local に SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を設定する
 *  3. npm run import:xlsx -- ./ダウンロードしたファイル.xlsx
 *
 * 何度実行しても同じ結果になります(予約IDと枠の日時で重複を判定します)。
 *
 * 【オプション】
 *  --dry-run        DBには書き込まず、件数だけを表示する
 *  --sql <出力先>   DBに接続せず、SupabaseのSQL Editorに貼り付けられる
 *                   SQLファイルを書き出す(接続情報が不要になります)
 */

import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { createClient } from '@supabase/supabase-js';
import { formatDate, formatTime, formatDateTime, TIMEZONE, zonedToEpochMs } from '../lib/format.js';
import { DEFAULT_SCHOOLS } from '../lib/schools.js';

// ---------- 引数と環境変数 ----------
const isMain = process.argv[1] && process.argv[1].endsWith('import-from-xlsx.mjs');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sqlIndex = args.indexOf('--sql');
const sqlOut = sqlIndex >= 0 ? args[sqlIndex + 1] : null;
// --sql の値は「取り込むファイル」ではないので、位置引数の候補から除く
const positional = args.filter((a, i) => !a.startsWith('--') && i !== sqlIndex + 1);
const filePath = positional[0];
// SQLを書き出すだけならDBへの接続情報は要らない
const needsDb = !dryRun && !sqlOut;

let db = null;
if (isMain) {
  if (!filePath) {
    console.error('使い方: npm run import:xlsx -- <スプレッドシートのxlsxファイル> [--dry-run]');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error('ファイルが見つかりません: ' + filePath);
    process.exit(1);
  }
  loadEnvLocal();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (needsDb && (!url || !key)) {
    console.error('SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を .env.local に設定してください。');
    console.error('(接続せずにSQLファイルを作るだけなら --sql <出力先> を使えます)');
    process.exit(1);
  }
  if (needsDb) db = createClient(url, key, { auth: { persistSession: false } });
}

/** .env.local を読み込む(依存パッケージを増やさないための簡易実装) */
function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

// ---------- シート名から校舎を割り出す ----------
const slotsSheetName = (s) => s.name + '予約枠';
const bookingsSheetName = (s) => s.name + '予約データ';

/** セルの値を素の値に均す(数式セルや書式つきテキストにも対応) */
function cellValue(cell) {
  const v = cell ? cell.value : null;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.result !== undefined) return v.result;              // 数式
    if (v.text !== undefined) return v.text;                  // ハイパーリンク
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    return '';
  }
  return v;
}

function rowValues(row, count) {
  const out = [];
  for (let c = 1; c <= count; c++) out.push(cellValue(row.getCell(c)));
  return out;
}

/** TRUE / FALSE のゆらぎを吸収する */
function toBool(v, defaultValue) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v).trim().toUpperCase();
  if (s === 'TRUE') return true;
  if (s === 'FALSE') return false;
  return defaultValue;
}

/** 日時セルを ISO 文字列にする(日本時間として解釈する) */
function toIso(v) {
  const text = formatDateTime(v);
  if (!text) return null;
  const m = text.match(/^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?$/);
  if (!m) return null;
  return new Date(zonedToEpochMs(m[1], m[2] || '00:00', TIMEZONE)).toISOString();
}

/** 配列を分割して順番に流し込む */
async function insertInChunks(table, rows, options, label) {
  if (!rows.length) return 0;
  let done = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    if (db) {
      const { error } = await db.from(table).upsert(chunk, options);
      if (error) throw new Error(`${label}の登録に失敗しました: ${error.message}`);
    }
    done += chunk.length;
  }
  return done;
}

// ---------- 解析 ----------
/**
 * スプレッドシート(xlsx)の中身を、DBに入れる形に変換する。
 * 副作用が無いのでテストから直接呼べる。
 */
export function parseWorkbook(workbook) {
  // 校舎マスタ + 通知先
  const notifyBySchool = new Map();
  const notifySheet = workbook.getWorksheet('通知先');
  if (notifySheet) {
    notifySheet.eachRow((row, n) => {
      if (n === 1) return; // 見出し行
      const [id, , email] = rowValues(row, 3);
      const schoolId = String(id || '').trim();
      if (schoolId) notifyBySchool.set(schoolId, String(email || '').trim());
    });
  }

  const schools = DEFAULT_SCHOOLS.map((s) => ({
    id: s.id,
    name: s.name,
    sort_order: s.sort_order,
    notify_email: notifyBySchool.get(s.id) || '',
    active: true,
  }));

  const slots = [];
  const bookings = [];
  const perSchool = [];

  for (const school of DEFAULT_SCHOOLS) {
    const slotSheet = workbook.getWorksheet(slotsSheetName(school));
    const bookingSheet = workbook.getWorksheet(bookingsSheetName(school));

    const mySlots = [];
    const seenSlot = new Set();
    if (slotSheet) {
      slotSheet.eachRow((row, n) => {
        if (n === 1) return;
        const v = rowValues(row, 5);
        const date = formatDate(v[0]);
        const time = formatTime(v[1]);
        if (!date || !time) return;
        const key = date + ' ' + time;
        if (seenSlot.has(key)) return; // 同じ日時の重複行はまとめる
        seenSlot.add(key);
        let capacity = parseInt(v[4], 10);
        if (!capacity || capacity < 1) capacity = 1;
        mySlots.push({
          school_id: school.id,
          date,
          time,
          label: String(v[2] || ''),
          published: toBool(v[3], true),
          capacity,
        });
      });
    }

    const myBookings = [];
    const seenBooking = new Set();
    if (bookingSheet) {
      bookingSheet.eachRow((row, n) => {
        if (n === 1) return;
        const v = rowValues(row, 15);
        const id = String(v[0] || '').trim();
        const date = formatDate(v[1]);
        const time = formatTime(v[2]);
        if (!id || !date || !time) return;
        if (seenBooking.has(id)) return;
        seenBooking.add(id);
        myBookings.push({
          id,
          school_id: school.id,
          date,
          time,
          child_name: String(v[3] || ''),
          parent_name: String(v[4] || ''),
          email: String(v[5] || ''),
          grade: String(v[6] || ''),
          note: String(v[7] || ''),
          status: String(v[8] || '').trim() === 'cancelled' ? 'cancelled' : 'confirmed',
          created_at: toIso(v[9]) || new Date().toISOString(),
          staff_note: String(v[10] || ''),
          reminder_sent_at: toIso(v[11]),
          interview_done: toBool(v[12], false),
          interview_note: String(v[13] || ''),
          interview_updated_at: toIso(v[14]),
        });
      });
    }

    slots.push(...mySlots);
    bookings.push(...myBookings);

    const missing = [];
    if (!slotSheet) missing.push('予約枠シートなし');
    if (!bookingSheet) missing.push('予約データシートなし');
    perSchool.push({
      school: school.name,
      slots: mySlots.length,
      bookings: myBookings.length,
      missing,
    });
  }

  const known = new Set(['通知先']);
  DEFAULT_SCHOOLS.forEach((s) => {
    known.add(slotsSheetName(s));
    known.add(bookingsSheetName(s));
  });
  const unknownSheets = workbook.worksheets.map((w) => w.name).filter((n) => !known.has(n));

  return { schools, slots, bookings, perSchool, unknownSheets };
}

// ---------- SQLの書き出し ----------

/** 値をSQLのリテラルにする(標準の文字列リテラル: シングルクォートを2つ重ねる) */
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/** insert文を組み立てる。行が多い場合は分割する */
function buildInsert(table, columns, rows, conflictClause, chunkSize = 100) {
  if (!rows.length) return '';
  const out = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const values = rows
      .slice(i, i + chunkSize)
      .map((r) => '  (' + columns.map((c) => sqlLiteral(r[c])).join(', ') + ')')
      .join(',\n');
    out.push(
      `insert into public.${table} (${columns.join(', ')}) values\n${values}\n${conflictClause};`
    );
  }
  return out.join('\n\n');
}

/**
 * SupabaseのSQL Editorに貼り付けられるSQLを組み立てる。
 * 予約IDと枠の日時で重複を判定するので、何度実行しても安全。
 */
export function buildSql(parsed) {
  const header = [
    '-- ============================================================',
    '-- 既存データの移行用SQL(自動生成)',
    '--',
    '-- SupabaseのSQL Editorに貼り付けて実行してください。',
    '-- 先に schema.sql を実行しておく必要があります。',
    '-- 同じ予約・同じ日時の枠は二重に入らないので、何度実行しても安全です。',
    `-- 校舎 ${parsed.schools.length}件 / 予約枠 ${parsed.slots.length}件 / 予約 ${parsed.bookings.length}件`,
    '-- ============================================================',
    '',
    'begin;',
    '',
  ].join('\n');

  const schools = buildInsert(
    'schools',
    ['id', 'name', 'sort_order', 'notify_email', 'active'],
    parsed.schools,
    'on conflict (id) do update set\n' +
      '  name = excluded.name,\n' +
      '  sort_order = excluded.sort_order,\n' +
      '  notify_email = excluded.notify_email'
  );

  const slots = buildInsert(
    'slots',
    ['school_id', 'date', 'time', 'label', 'published', 'capacity'],
    parsed.slots,
    'on conflict (school_id, date, time) do nothing'
  );

  const bookings = buildInsert(
    'bookings',
    [
      'id', 'school_id', 'date', 'time', 'child_name', 'parent_name', 'email',
      'grade', 'note', 'status', 'created_at', 'staff_note', 'reminder_sent_at',
      'interview_done', 'interview_note', 'interview_updated_at',
    ],
    parsed.bookings,
    'on conflict (id) do nothing'
  );

  return [
    header,
    '-- ---------- 校舎マスタと通知先 ----------',
    schools,
    '',
    '-- ---------- 予約枠 ----------',
    slots,
    '',
    '-- ---------- 予約 ----------',
    bookings,
    '',
    'commit;',
    '',
  ].join('\n');
}

// ---------- 本体 ----------
async function main() {
  console.log(`読み込み中: ${filePath}${dryRun ? ' (--dry-run: DBには書き込みません)' : ''}\n`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const parsed = parseWorkbook(workbook);

  if (sqlOut) {
    fs.writeFileSync(sqlOut, buildSql(parsed), 'utf8');
    console.log(`SQLを書き出しました: ${sqlOut}`);
  }

  await insertInChunks('schools', parsed.schools, { onConflict: 'id' }, '校舎マスタ');
  await insertInChunks(
    'slots', parsed.slots, { onConflict: 'school_id,date,time' }, '予約枠'
  );
  await insertInChunks('bookings', parsed.bookings, { onConflict: 'id' }, '予約');

  console.log('── 取り込み結果 ──');
  console.log(`  校舎マスタ: ${parsed.schools.length}件`);
  parsed.perSchool.forEach((p) => {
    console.log(
      `  ${p.school}: 枠 ${p.slots}件 / 予約 ${p.bookings}件` +
        (p.missing.length ? `  ⚠️ ${p.missing.join('、')}` : '')
    );
  });
  console.log(`\n合計: 枠 ${parsed.slots.length}件 / 予約 ${parsed.bookings.length}件`);
  if (parsed.unknownSheets.length) {
    console.log(`\n取り込まなかったシート: ${parsed.unknownSheets.join('、')}`);
  }
  if (sqlOut) {
    console.log(`\nSQLファイル(${sqlOut})をSupabaseのSQL Editorに貼り付けて実行してください。`);
  } else if (dryRun) {
    console.log('\n--dry-run のため、DBには書き込んでいません。');
  } else {
    console.log('\n完了しました。');
  }
}

if (isMain) {
  main().catch((err) => {
    console.error('\n移行に失敗しました:', err.message);
    process.exit(1);
  });
}
