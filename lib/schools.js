/**
 * 部門マスタと校舎マスタ。
 *
 * 保護者・職員には部門ごとに別のURLで見せるため、校舎の取得は必ず部門で絞る。
 * 校舎IDはDB全体で一意だが、部門をまたいで同じ名前の校舎があるため
 * (RED日野教室 と 中等部の日野校 など)、必ず部門とセットで扱うこと。
 */

import { getDb, unwrap } from './db.js';

/** 部門・校舎はほとんど変化しないので、関数の実行中だけ短くキャッシュする */
const CACHE_MS = 30 * 1000;
let cache = null;
let cachedAt = 0;

export function clearSchoolCache() {
  cache = null;
  cachedAt = 0;
}

async function load() {
  if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
  const db = getDb();
  const [departments, schools] = await Promise.all([
    unwrap(
      await db
        .from('departments')
        .select('id, name, slug, accent_color, grades, sort_order, active')
        .order('sort_order', { ascending: true }),
      '部門マスタの取得'
    ),
    unwrap(
      await db
        .from('schools')
        .select('id, name, department_id, notify_email, line_works_channel_id, sort_order, active')
        .order('sort_order', { ascending: true }),
      '校舎マスタの取得'
    ),
  ]);
  cache = { departments: departments || [], schools: schools || [] };
  cachedAt = Date.now();
  return cache;
}

/** 有効な部門の一覧 */
export async function listDepartments({ includeInactive = false } = {}) {
  const { departments } = await load();
  return includeInactive ? departments : departments.filter((d) => d.active !== false);
}

/** URLのslugから部門を引く。見つからなければ null */
export async function findDepartmentBySlug(slug) {
  if (!slug) return null;
  const departments = await listDepartments({ includeInactive: true });
  return departments.find((d) => d.slug === String(slug)) || null;
}

/** 画面に渡す形の部門一覧(トップの選択画面用) */
export async function listDepartmentsForClient() {
  const departments = await listDepartments();
  return departments.map((d) => ({
    slug: d.slug,
    name: d.name,
    accentColor: d.accent_color,
  }));
}

/**
 * 指定した部門の校舎一覧。
 * 部門が存在しなければ空配列を返す(他部門の校舎が混ざることはない)。
 */
export async function listSchools(departmentSlug, { includeInactive = false } = {}) {
  const dept = await findDepartmentBySlug(departmentSlug);
  if (!dept) return [];
  const { schools } = await load();
  return schools.filter(
    (s) => s.department_id === dept.id && (includeInactive || s.active !== false)
  );
}

/** 画面に渡す形(idとnameだけ)の校舎一覧 */
export async function listSchoolsForClient(departmentSlug) {
  const schools = await listSchools(departmentSlug);
  return schools.map((s) => ({ id: s.id, name: s.name }));
}

/**
 * 校舎をIDで引く。**部門の指定は必須**で、その部門の校舎でなければ null を返す。
 *
 * 部門を渡し忘れたときに全部門の校舎が引けてしまうと、他部門のデータを
 * 操作できる抜け道になる。そのため、指定が無い場合も null を返す(閉じる側に倒す)。
 */
export async function findSchoolById(id, departmentSlug) {
  if (!id || !departmentSlug) return null;
  const dept = await findDepartmentBySlug(departmentSlug);
  if (!dept) return null;
  const { schools } = await load();
  const school = schools.find((s) => s.id === id);
  if (!school || school.department_id !== dept.id) return null;
  return school;
}

/**
 * 部門を問わず校舎をIDで引く。
 * 通知の送信先を調べるときなど、すでに部門の確認が済んでいる内部処理でのみ使う。
 * 外部からの入力で分岐する箇所では findSchoolById を使うこと。
 */
export async function findSchoolByIdAnyDepartment(id) {
  if (!id) return null;
  const { schools } = await load();
  return schools.find((s) => s.id === id) || null;
}

/** 全部門の校舎(リマインドの一括送信など、部門を横断する処理用) */
export async function listAllSchools() {
  const { schools } = await load();
  return schools;
}

/** 校舎の通知先(メール・LINE WORKS)を更新する */
export async function updateSchoolNotify(schoolId, { notifyEmail, lineWorksChannelId }) {
  const patch = {};
  if (notifyEmail !== undefined) patch.notify_email = String(notifyEmail || '').trim();
  if (lineWorksChannelId !== undefined) {
    patch.line_works_channel_id = String(lineWorksChannelId || '').trim();
  }
  if (!Object.keys(patch).length) return;
  const db = getDb();
  unwrap(await db.from('schools').update(patch).eq('id', schoolId), '通知先の更新');
  clearSchoolCache();
}
