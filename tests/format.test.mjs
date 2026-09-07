/** 日付・時刻ユーティリティと、カレンダー出力のレイアウト計算のテスト */
import assert from 'node:assert/strict';
import {
  formatDate, formatTime, formatDateTime, makeKey, formatJapaneseDate,
  zonedToEpochMs, todayStr, addDays, nowStamp,
} from '../lib/format.js';
import { buildMonthRequests } from '../lib/calendar-export.js';

let passed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('\n== 日付・時刻の正規化 ==');

test('いろいろな形式の日付を YYYY-MM-DD に揃える', () => {
  assert.equal(formatDate('2026-09-07'), '2026-09-07');
  assert.equal(formatDate('2026/09/07'), '2026-09-07');
  assert.equal(formatDate('2026/9/7'), '2026-09-07');       // 0詰めなし
  assert.equal(formatDate(new Date(2026, 8, 7)), '2026-09-07');
  assert.equal(formatDate(46272), '2026-09-07');            // シリアル値
  assert.equal(formatDate(46272.5), '2026-09-07');          // 時刻付きシリアル値
});

test('日付として読めない値は null', () => {
  assert.equal(formatDate(''), null);
  assert.equal(formatDate(null), null);
  assert.equal(formatDate(undefined), null);
  assert.equal(formatDate('あした'), null);
});

test('いろいろな形式の時刻を HH:MM に揃える', () => {
  assert.equal(formatTime('14:00'), '14:00');
  assert.equal(formatTime('9:05'), '09:05');
  assert.equal(formatTime('14:00:00'), '14:00');
  assert.equal(formatTime(new Date(2026, 8, 7, 14, 30)), '14:30');
  assert.equal(formatTime(0.5), '12:00');                   // シリアル値(正午)
  assert.equal(formatTime(''), null);
});

test('日付と時刻からキーを作れる', () => {
  assert.equal(makeKey('2026/09/07', '9:05'), '2026-09-07 09:05');
});

test('日本語の日付表記に変換できる', () => {
  assert.equal(formatJapaneseDate('2026-09-07'), '2026年9月7日(月)');
  assert.equal(formatJapaneseDate('2026-01-01'), '2026年1月1日(木)');
});

test('日時セルを読みやすい文字列にする(シリアル値でも数字を出さない)', () => {
  // 予約日時などの日時セルは、値だけ読むとシリアル値で返ってくる
  assert.equal(formatDateTime(46164 + (15 * 60 + 38) / 1440), '2026-05-22 15:38');
  assert.equal(formatDateTime(46169), '2026-05-27');        // 時刻を持たないセルは日付だけ
  assert.equal(formatDateTime('2026-05-22 15:38'), '2026-05-22 15:38');
  assert.equal(formatDateTime(new Date(2026, 4, 22, 15, 38)), '2026-05-22 15:38');
  assert.equal(formatDateTime(''), '');
  assert.equal(formatDateTime(null), '');
});

console.log('\n== タイムゾーンの扱い(サーバーはUTCで動く) ==');

test('日本時間の壁時計を正しい絶対時刻に変換する', () => {
  // 日本時間 14:00 は UTC 05:00
  assert.equal(new Date(zonedToEpochMs('2026-09-07', '14:00')).toISOString(), '2026-09-07T05:00:00.000Z');
  // 日本時間の 00:30 は前日の UTC 15:30
  assert.equal(new Date(zonedToEpochMs('2026-09-07', '00:30')).toISOString(), '2026-09-06T15:30:00.000Z');
});

test('UTCでは前日でも、日本時間の「今日」を返す', () => {
  // UTC 2026-09-07 16:00 = 日本時間 2026-09-08 01:00
  const base = new Date('2026-09-07T16:00:00Z');
  assert.equal(todayStr('Asia/Tokyo', base), '2026-09-08');
  assert.equal(todayStr('UTC', base), '2026-09-07');
  assert.equal(nowStamp('Asia/Tokyo', base), '2026-09-08 01:00');
});

test('日をまたぐ加算・減算が月末年末でも正しい', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29');    // うるう年
});

console.log('\n== カレンダー出力のレイアウト ==');

const school = { id: 'hirota', name: 'RED広田教室' };

function cellsOf(requests) {
  return requests.find(r => r.updateCells).updateCells.rows.map(r => r.values);
}

test('2026年9月(1日が火曜)のカレンダーが正しい位置に組まれる', () => {
  const byDate = { '2026-09-07': [{ time: '14:00', childName: '花子', grade: '小3' }] };
  const reqs = buildMonthRequests(1, 2026, 9, school, byDate, '2026-09-01', '2026-09-30');
  const rows = cellsOf(reqs);

  // タイトルと曜日ヘッダー
  assert.equal(rows[0][0].userEnteredValue.stringValue, 'RED広田教室  2026年9月  面談予約カレンダー');
  assert.equal(rows[1][0].userEnteredValue.stringValue, '対象期間:2026-09-01 〜 2026-09-30');
  assert.deepEqual(rows[2].map(c => c.userEnteredValue.stringValue), ['日','月','火','水','木','金','土']);

  // 2026-09-01 は火曜 → 4行目の3列目(index 2)
  assert.equal(rows[3][2].userEnteredValue.numberValue, 1);
  assert.equal(rows[3][0].userEnteredValue.stringValue, undefined); // 日曜は空
  // 9/7(月)は2週目の月曜。日付行は6行目(index 5)、内容行はその下
  assert.equal(rows[5][1].userEnteredValue.numberValue, 7);
  assert.equal(rows[6][1].userEnteredValue.stringValue, '14:00 花子(小3)');
});

test('同じ日の複数予約が時刻順に改行で並ぶ', () => {
  const byDate = { '2026-09-01': [
    { time: '10:00', childName: 'A', grade: '小1' },
    { time: '11:00', childName: 'B', grade: '' },
  ] };
  const rows = cellsOf(buildMonthRequests(1, 2026, 9, school, byDate, '2026-09-01', '2026-09-30'));
  assert.equal(rows[4][2].userEnteredValue.stringValue, '10:00 A(小1)\n11:00 B');
});

test('期間外の日はグレーアウトされる', () => {
  const rows = cellsOf(buildMonthRequests(1, 2026, 9, school, {}, '2026-09-10', '2026-09-20'));
  // 9/1(期間外)の日付セル
  assert.deepEqual(rows[3][2].userEnteredFormat.backgroundColor, { red: 237/255, green: 242/255, blue: 247/255 });
  // 9/10(期間内)の日付セル: 4行目の木曜(index 4)
  assert.deepEqual(rows[5][4].userEnteredFormat.backgroundColor, { red: 247/255, green: 250/255, blue: 252/255 });
});

test('月末が土曜で終わる月(2026年10月)でも行数が破綻しない', () => {
  const reqs = buildMonthRequests(1, 2026, 10, school, {}, '2026-10-01', '2026-10-31');
  const rows = cellsOf(reqs);
  const days = rows.flat().filter(c => c.userEnteredValue.numberValue !== undefined).map(c => c.userEnteredValue.numberValue);
  assert.deepEqual(days, Array.from({ length: 31 }, (_, i) => i + 1));
  // 罫線・結合・固定行のリクエストが揃っている
  assert.ok(reqs.some(r => r.updateBorders));
  assert.equal(reqs.filter(r => r.mergeCells).length, 3);  // タイトル・期間・フッター
  assert.ok(reqs.some(r => r.updateSheetProperties));
});

test('すべての月で日付が1〜末日まで欠けずに配置される', () => {
  for (let m = 1; m <= 12; m++) {
    const rows = cellsOf(buildMonthRequests(1, 2027, m, school, {}, `2027-${String(m).padStart(2,'0')}-01`, `2027-12-31`));
    const days = rows.flat().filter(c => c.userEnteredValue.numberValue !== undefined).map(c => c.userEnteredValue.numberValue);
    const expected = new Date(Date.UTC(2027, m, 0)).getUTCDate();
    assert.equal(days.length, expected, `${m}月の日数`);
    assert.deepEqual(days, Array.from({ length: expected }, (_, i) => i + 1), `${m}月の並び`);
  }
});

console.log(`\n${passed} 件のテストが通りました。`);
