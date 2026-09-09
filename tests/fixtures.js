/** テストで使う部門・校舎の初期データ(supabase/seed.sql と同じ構成) */

export const DEPARTMENTS = [
  {
    id: 'red',
    name: 'RED部門',
    slug: 'red',
    accent_color: '#3182ce',
    grades: ['小学1年', '中学3年', 'その他'],
    sort_order: 1,
  },
  {
    id: 'chutobu',
    name: '中等部',
    slug: 'chutobu',
    accent_color: '#2f855a',
    grades: ['小学4年', '中学3年', 'その他'],
    sort_order: 2,
  },
];

export const SCHOOLS = [
  { id: 'hirota',   name: 'RED広田教室',     department_id: 'red',     sort_order: 1 },
  { id: 'kyomachi', name: 'RED京町教室',     department_id: 'red',     sort_order: 2 },
  { id: 'hino',     name: 'RED日野教室',     department_id: 'red',     sort_order: 3 },
  { id: 'saza',     name: 'RED佐々教室',     department_id: 'red',     sort_order: 4 },
  { id: 'oshima',   name: 'RED西海大島教室', department_id: 'red',     sort_order: 5 },
  { id: 'ono',      name: 'RED大野教室',     department_id: 'red',     sort_order: 6 },
  { id: 'nexta',    name: 'ネクスタ',        department_id: 'red',     sort_order: 7 },
  // 中等部。日野校・大野校はRED部門とIDが衝突しないよう chutobu_ を付けている
  { id: 'chutobu_sasebo', name: '佐世保駅前校', department_id: 'chutobu', sort_order: 1 },
  { id: 'chutobu_hino',   name: '日野校',       department_id: 'chutobu', sort_order: 2 },
  { id: 'chutobu_ono',    name: '大野校',       department_id: 'chutobu', sort_order: 3 },
  { id: 'chutobu_hiu',    name: '日宇校',       department_id: 'chutobu', sort_order: 4 },
];
