/**
 * 日付・時刻のフォーマット関連。
 *
 * GAS版は Session のタイムゾーン(Asia/Tokyo)で動いていたが、Vercelの
 * サーバーレス関数は UTC で動く。そのため「今日」「明日」「過去かどうか」は
 * すべて TIMEZONE(既定 Asia/Tokyo)の壁時計を基準に計算する。
 */

export const TIMEZONE = process.env.TIMEZONE || 'Asia/Tokyo';

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** シリアル値(スプレッドシートの日付数値)の基準日 1899-12-30 */
const SHEETS_EPOCH_UTC = Date.UTC(1899, 11, 30);

/**
 * セルの値を 'YYYY-MM-DD' に正規化する。
 * 文字列(YYYY-MM-DD / YYYY/MM/DD)、Date、シリアル値のいずれにも対応。
 * 変換できない場合は null。
 */
export function formatDate(val) {
  if (val === null || val === undefined || val === '') return null;
  if (val instanceof Date) {
    return (
      val.getFullYear() +
      '-' +
      String(val.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(val.getDate()).padStart(2, '0')
    );
  }
  if (typeof val === 'number' && Number.isFinite(val)) {
    const d = new Date(SHEETS_EPOCH_UTC + Math.floor(val) * 86400000);
    return (
      d.getUTCFullYear() +
      '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') +
      '-' +
      String(d.getUTCDate()).padStart(2, '0')
    );
  }
  const s = String(val).trim();
  const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (m) {
    return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
  }
  // 数字だけの文字列はシリアル値とみなす
  if (/^\d+(\.\d+)?$/.test(s)) return formatDate(Number(s));
  return null;
}

/**
 * セルの値を 'HH:MM' に正規化する。
 * 文字列(HH:MM)、Date、シリアル値(0〜1の小数)に対応。変換できない場合は null。
 */
export function formatTime(val) {
  if (val === null || val === undefined || val === '') return null;
  if (val instanceof Date) {
    return (
      String(val.getHours()).padStart(2, '0') + ':' + String(val.getMinutes()).padStart(2, '0')
    );
  }
  if (typeof val === 'number' && Number.isFinite(val)) {
    const frac = val - Math.floor(val);
    const totalMin = Math.round(frac * 24 * 60);
    const h = Math.floor(totalMin / 60) % 24;
    const mi = totalMin % 60;
    return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
  }
  const s = String(val).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) return String(m[1]).padStart(2, '0') + ':' + m[2];
  if (/^\d*\.\d+$/.test(s)) return formatTime(Number(s));
  return null;
}

/** 日付と時刻から予約枠の一意キーを作る */
export function makeKey(date, time) {
  return formatDate(date) + ' ' + formatTime(time);
}

/** 'YYYY-MM-DD' を「YYYY年M月D日(曜)」に変換 */
export function formatJapaneseDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return y + '年' + m + '月' + d + '日(' + WEEKDAYS_JA[date.getUTCDay()] + ')';
}

/** 指定タイムゾーンでの壁時計のずれ(ミリ秒)を求める */
function tzOffsetMs(epochMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(new Date(epochMs)).map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - epochMs;
}

/**
 * 「タイムゾーン上の YYYY-MM-DD HH:MM」を絶対時刻(epoch ms)に変換する。
 */
export function zonedToEpochMs(dateStr, timeStr, timeZone = TIMEZONE) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [h, mi] = String(timeStr || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  // 2回反復してDST境界でも正しいオフセットに収束させる(日本にDSTは無いが安全のため)
  let epoch = guess - tzOffsetMs(guess, timeZone);
  epoch = guess - tzOffsetMs(epoch, timeZone);
  return epoch;
}

/** 指定タイムゾーンでの「今日」を 'YYYY-MM-DD' で返す */
export function todayStr(timeZone = TIMEZONE, base = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return dtf.format(base); // en-CA は YYYY-MM-DD 形式
}

/** 'YYYY-MM-DD' に日数を足した日付文字列を返す */
export function addDays(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return (
    t.getUTCFullYear() +
    '-' +
    String(t.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(t.getUTCDate()).padStart(2, '0')
  );
}

/** 指定タイムゾーンでの現在時刻を 'YYYY-MM-DD HH:MM' 文字列で返す(予約日時の記録用) */
export function nowStamp(timeZone = TIMEZONE, base = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(base).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
