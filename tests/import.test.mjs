/**
 * 既存データの移行スクリプトのテスト。
 * 実際のスプレッドシートと同じ構造・同じ保存形式(日付型・TRUE/FALSE)の
 * xlsxをその場で作り、正しくDBの形に変換できるかを確認する。
 */
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseWorkbook, buildSql, DEPARTMENTS } from '../scripts/import-from-xlsx.mjs';

process.env.TIMEZONE = 'Asia/Tokyo';

const SLOT_HEADERS = ['日付', '時刻', '枠ラベル(任意)', '公開(TRUE/FALSE)', '定員'];
const BOOKING_HEADERS = [
  '予約ID', '日付', '時刻', 'お子様名', '保護者名', 'メールアドレス', '学年', '相談内容',
  '状態', '予約日時', '職員メモ', 'リマインド送信済', '面談実施', '面談記録', '記録更新日時',
];

/** 実際のシートと同じく、日付・時刻・日時はDate型で入れる */
const d = (ymd) => {
  const [y, m, dd] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd));
};
const t = (hm) => {
  const [h, mi] = hm.split(':').map(Number);
  return new Date(Date.UTC(1899, 11, 30, h, mi));
};
const dt = (ymd, hm) => {
  const [y, m, dd] = ymd.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, dd, h, mi));
};

function buildWorkbook() {
  const wb = new ExcelJS.Workbook();

  const notify = wb.addWorksheet('通知先');
  notify.addRow(['校舎ID', '校舎名', '通知先メールアドレス']);
  notify.addRow(['hirota', 'RED広田教室', 'staff@example.com']);
  notify.addRow(['kyomachi', 'RED京町教室', 'a@example.com, b@example.com']);
  notify.addRow(['hino', 'RED日野教室', '']);

  const slots = wb.addWorksheet('RED広田教室予約枠');
  slots.addRow(SLOT_HEADERS);
  slots.addRow([d('2026-05-20'), t('14:00'), '', true, 1]);
  slots.addRow([d('2026-05-20'), t('14:30'), '三者面談', true, 2]);
  slots.addRow([d('2026-05-21'), t('20:00'), '', false, 1]);
  slots.addRow([d('2026-05-20'), t('14:00'), '', true, 1]);  // 重複行
  slots.addRow(['2026/05/22', '15:00', '', 'TRUE', '']);      // 文字列で入っている行
  slots.addRow([null, null, '', true, 1]);                    // 空行

  const bookings = wb.addWorksheet('RED広田教室予約データ');
  bookings.addRow(BOOKING_HEADERS);
  bookings.addRow([
    'b_1779431892862_nezgs', d('2026-05-20'), t('14:00'), '亀谷新', '亀谷保護者',
    'kame@example.com', '中学3年', '試験運用', 'cancelled', dt('2026-05-22', '15:38'),
    '', '', '', '', '',
  ]);
  bookings.addRow([
    'b_1780389650976_70g4c', d('2026-05-20'), t('14:30'), '茅原詩織', '茅原貴子',
    'chi@example.com', '中学3年', '夏休みの塾の利用内容', 'confirmed', dt('2026-06-02', '17:40'),
    '瀬戸山', d('2026-06-05'), true, '志望校…有田、波佐見', dt('2026-06-09', '18:18'),
  ]);
  bookings.addRow(['', d('2026-05-20'), t('14:00'), '無効行', '', '', '', '', '', '', '', '', '', '', '']);
  // SQLのエスケープ確認用: アポストロフィ・改行・記号を含む行
  bookings.addRow([
    'b_quote_test', d('2026-05-21'), t('20:00'), "O'Brien 太郎", "O'Brien 花子",
    "o'brien@example.com", '中学3年', "子ども曰く「'ちょっと'難しい」", 'confirmed',
    dt('2026-06-03', '09:00'), "担当: O'Neil", '', true,
    "① 面談メモ\n* 1行目 -- コメントではない\n* 2行目 'クォート' 入り", dt('2026-06-03', '10:00'),
  ]);

  // 京町は枠シートだけ用意する(予約データシートが無い場合の確認)
  const kyo = wb.addWorksheet('RED京町教室予約枠');
  kyo.addRow(SLOT_HEADERS);
  kyo.addRow([d('2026-06-01'), t('18:30'), '', true, 1]);

  wb.addWorksheet('メモ書き'); // 関係のないシート
  return wb;
}

let passed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

const parsed = parseWorkbook(buildWorkbook(), 'red');

console.log('\n== 既存データの移行 ==');

test('校舎マスタに部門と通知先が引き継がれる', () => {
  assert.equal(parsed.schools.length, 7);
  assert.ok(parsed.schools.every((s) => s.department_id === 'red'));
  const hirota = parsed.schools.find((s) => s.id === 'hirota');
  assert.equal(hirota.name, 'RED広田教室');
  assert.equal(hirota.notify_email, 'staff@example.com');
  assert.equal(parsed.schools.find((s) => s.id === 'kyomachi').notify_email, 'a@example.com, b@example.com');
  assert.equal(parsed.schools.find((s) => s.id === 'hino').notify_email, '');
  // 通知先シートに無い校舎も空欄で作られる
  assert.equal(parsed.schools.find((s) => s.id === 'nexta').notify_email, '');
});

test('日付型・時刻型のセルが文字列に変換される', () => {
  const s = parsed.slots.find((x) => x.time === '14:00' && x.school_id === 'hirota');
  assert.equal(s.date, '2026-05-20');
  assert.equal(s.time, '14:00');
});

test('枠のラベル・公開・定員が引き継がれる', () => {
  const withLabel = parsed.slots.find((s) => s.time === '14:30');
  assert.equal(withLabel.label, '三者面談');
  assert.equal(withLabel.capacity, 2);
  const hidden = parsed.slots.find((s) => s.time === '20:00');
  assert.equal(hidden.published, false);
});

test('文字列で入っている行も読める(定員が空なら1になる)', () => {
  const s = parsed.slots.find((x) => x.date === '2026-05-22');
  assert.equal(s.time, '15:00');
  assert.equal(s.published, true);
  assert.equal(s.capacity, 1);
});

test('重複行と空行は取り込まれない', () => {
  const hirota = parsed.slots.filter((s) => s.school_id === 'hirota');
  assert.equal(hirota.length, 4); // 重複1件・空行1件を除いた数
  assert.equal(parsed.slots.length, 5); // 京町の1件を含む
});

test('予約IDと内容がそのまま引き継がれる', () => {
  const b = parsed.bookings.find((x) => x.id === 'b_1780389650976_70g4c');
  assert.equal(b.school_id, 'hirota');
  assert.equal(b.date, '2026-05-20');
  assert.equal(b.time, '14:30');
  assert.equal(b.child_name, '茅原詩織');
  assert.equal(b.parent_name, '茅原貴子');
  assert.equal(b.grade, '中学3年');
  assert.equal(b.note, '夏休みの塾の利用内容');
  assert.equal(b.status, 'confirmed');
  assert.equal(b.staff_note, '瀬戸山');
  assert.equal(b.interview_done, true);
  assert.equal(b.interview_note, '志望校…有田、波佐見');
});

test('日時が日本時間として解釈され、UTCで保存される', () => {
  const b = parsed.bookings.find((x) => x.id === 'b_1780389650976_70g4c');
  // 2026-06-02 17:40 JST = 08:40 UTC
  assert.equal(b.created_at, '2026-06-02T08:40:00.000Z');
  // 2026-06-09 18:18 JST = 09:18 UTC
  assert.equal(b.interview_updated_at, '2026-06-09T09:18:00.000Z');
  // 日付だけの列は 00:00 JST として扱う
  assert.equal(b.reminder_sent_at, '2026-06-04T15:00:00.000Z');
});

test('キャンセル済みの予約は状態が保たれる', () => {
  const b = parsed.bookings.find((x) => x.id === 'b_1779431892862_nezgs');
  assert.equal(b.status, 'cancelled');
  assert.equal(b.reminder_sent_at, null);
  assert.equal(b.interview_done, false);
});

test('予約IDが無い行は取り込まれない', () => {
  assert.equal(parsed.bookings.length, 3); // 有効な2件 + エスケープ確認用の1件
  assert.ok(!parsed.bookings.some((b) => b.child_name === '無効行'));
});

test('シートが無い校舎と、関係のないシートを報告する', () => {
  const kyo = parsed.perSchool.find((p) => p.school === 'RED京町教室');
  assert.deepEqual(kyo.missing, ['予約データシートなし']);
  assert.equal(kyo.slots, 1);
  const nexta = parsed.perSchool.find((p) => p.school === 'ネクスタ');
  assert.deepEqual(nexta.missing, ['予約枠シートなし', '予約データシートなし']);
  assert.deepEqual(parsed.unknownSheets, ['メモ書き']);
});

console.log('\n== 移行用SQLの生成 ==');

const sql = buildSql(parsed);

test('校舎IDは部門をまたいで衝突しない', () => {
  const ids = Object.values(DEPARTMENTS).flatMap((d) => d.schools.map((s) => s.id));
  assert.equal(new Set(ids).size, ids.length, '校舎IDに重複があってはいけない');
  // 中等部の日野校・大野校は、RED部門と同名でもIDが違う
  const red = DEPARTMENTS.red.schools.map((s) => s.id);
  const chu = DEPARTMENTS.chutobu.schools.map((s) => s.id);
  assert.ok(red.includes('hino') && chu.includes('chutobu_hino'));
  assert.ok(red.includes('ono') && chu.includes('chutobu_ono'));
  assert.equal(red.filter((id) => chu.includes(id)).length, 0);
});

test('中等部のシートを部門つきで読み込める', () => {
  const wb = new ExcelJS.Workbook();
  const slots = wb.addWorksheet('佐世保駅前校予約枠');
  slots.addRow(SLOT_HEADERS);
  slots.addRow([d('2026-05-20'), t('14:00'), '', true, 1]);
  const bookings = wb.addWorksheet('日野校予約データ');
  bookings.addRow(BOOKING_HEADERS);
  bookings.addRow([
    'b_chu_1', d('2026-05-20'), t('16:00'), '中等部生徒', '保護者',
    'chu@example.com', '中学3年', '', 'confirmed', dt('2026-05-01', '10:00'),
    '', '', '', '', '',
  ]);
  const p = parseWorkbook(wb, 'chutobu');
  assert.equal(p.departmentName, '中等部');
  assert.equal(p.schools.length, 4);
  assert.ok(p.schools.every((s) => s.department_id === 'chutobu'));
  assert.equal(p.slots[0].school_id, 'chutobu_sasebo');
  // 「日野校」は chutobu_hino に入る(RED日野教室の hino とは別物)
  assert.equal(p.bookings[0].school_id, 'chutobu_hino');
  assert.equal(p.bookings[0].child_name, '中等部生徒');
});

test('スキーマの3テーブルすべてにinsertが作られる', () => {
  assert.match(sql, /insert into public\.schools \(/);
  assert.match(sql, /insert into public\.slots \(/);
  assert.match(sql, /insert into public\.bookings \(/);
  // トランザクションで囲む
  assert.match(sql, /^-- =+\n/m);
  assert.ok(sql.includes('begin;'));
  assert.ok(sql.trimEnd().endsWith('commit;'));
});

test('再実行しても重複しないよう on conflict が付く', () => {
  assert.match(sql, /on conflict \(id\) do update set/);
  assert.match(sql, /on conflict \(school_id, date, time\) do nothing/);
  assert.match(sql, /on conflict \(id\) do nothing/);
});

test("アポストロフィが '' にエスケープされる", () => {
  // O'Brien → 'O''Brien 太郎'
  assert.ok(sql.includes("'O''Brien 太郎'"), 'お子様名のエスケープ');
  assert.ok(sql.includes("'O''Brien 花子'"), '保護者名のエスケープ');
  assert.ok(sql.includes("'o''brien@example.com'"), 'メールアドレスのエスケープ');
  assert.ok(sql.includes("'担当: O''Neil'"), '担当メモのエスケープ');
  // エスケープ漏れが無いことを確認する。
  // 文字列リテラルは改行をまたぐことがあるため、行単位ではなくSQL全体で数える。
  const body = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  const quotes = (body.match(/'/g) || []).length;
  assert.equal(quotes % 2, 0, 'クォートの総数は偶数(すべて閉じている)はず');
});

test('改行や記号を含むテキストがそのまま保たれる', () => {
  assert.ok(sql.includes('① 面談メモ'), '記号');
  assert.ok(sql.includes("* 2行目 ''クォート'' 入り"), '改行の先の内容とエスケープ');
});

test('真偽値・NULL・数値がリテラルとして正しく出る', () => {
  assert.match(sql, /, true, /);        // published / interview_done
  assert.match(sql, /, null[,)]/);      // reminder_sent_at が未設定の行
  assert.match(sql, /, 2\)/);           // 定員2の枠
});

test('日時はISO文字列として出力される', () => {
  assert.match(sql, /'2026-06-03T00:00:00\.000Z'/);  // 09:00 JST
});

test('校舎のinsertに部門が含まれる', () => {
  assert.match(sql, /insert into public\.schools \(id, name, department_id, sort_order/);
  assert.ok(sql.includes("'red'"), '部門IDが値として入っている');
});

test('件数が解析結果と一致する', () => {
  const count = (re) => (sql.match(re) || []).length;
  // 1行 = 1レコード。値の行は「  (」で始まる
  const valueLines = sql.split('\n').filter((l) => /^ {2}\(/.test(l)).length;
  assert.equal(
    valueLines,
    parsed.schools.length + parsed.slots.length + parsed.bookings.length
  );
  assert.ok(count(/insert into/g) >= 3);
});

console.log(`\n${passed} 件のテストが通りました。`);
