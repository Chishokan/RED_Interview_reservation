/**
 * 校舎マスタ。GAS版はコード内の定数だったが、Supabase版では schools テーブルで管理する。
 * 通知先メールアドレスも同じ行に持つ(GAS版の「通知先」シートの置き換え)。
 */

import { getDb, unwrap } from './db.js';

/**
 * 初期データ。supabase/seed.sql と同じ内容で、
 * DBに校舎が1件も無いときの案内やテストの基準として使う。
 */
export const DEFAULT_SCHOOLS = [
  { id: 'hirota', name: 'RED広田教室', sort_order: 1 },
  { id: 'kyomachi', name: 'RED京町教室', sort_order: 2 },
  { id: 'hino', name: 'RED日野教室', sort_order: 3 },
  { id: 'saza', name: 'RED佐々教室', sort_order: 4 },
  { id: 'oshima', name: 'RED西海大島教室', sort_order: 5 },
  { id: 'ono', name: 'RED大野教室', sort_order: 6 },
  { id: 'nexta', name: 'ネクスタ', sort_order: 7 },
];

// 校舎マスタはほとんど変化しないので、関数の実行中だけ短くキャッシュする
let cache = null;
let cachedAt = 0;
const CACHE_MS = 30 * 1000;

export function clearSchoolCache() {
  cache = null;
  cachedAt = 0;
}

/** 有効な校舎の一覧を並び順で返す */
export async function listSchools({ includeInactive = false } = {}) {
  if (cache && Date.now() - cachedAt < CACHE_MS) {
    return includeInactive ? cache : cache.filter((s) => s.active !== false);
  }
  const db = getDb();
  const rows = unwrap(
    await db
      .from('schools')
      .select('id, name, notify_email, sort_order, active')
      .order('sort_order', { ascending: true }),
    '校舎マスタの取得'
  );
  cache = rows || [];
  cachedAt = Date.now();
  return includeInactive ? cache : cache.filter((s) => s.active !== false);
}

/** 画面に渡す形(idとnameだけ)の校舎一覧 */
export async function listSchoolsForClient() {
  const schools = await listSchools();
  return schools.map((s) => ({ id: s.id, name: s.name }));
}

/** IDから校舎を引く。見つからなければ null */
export async function findSchoolById(id) {
  if (!id) return null;
  const schools = await listSchools({ includeInactive: true });
  return schools.find((s) => s.id === id) || null;
}

/** 通知先メールアドレスを更新する */
export async function updateNotifyEmail(schoolId, email) {
  const db = getDb();
  unwrap(
    await db
      .from('schools')
      .update({ notify_email: String(email || '').trim() })
      .eq('id', schoolId),
    '通知先の更新'
  );
  clearSchoolCache();
}
