-- ============================================================
-- 校舎マスタの初期データ
-- schema.sql を実行したあとに、続けてこれを実行してください。
--
-- 通知先メールアドレスは空にしてあります。
-- 管理画面の「🛠 システム設定」タブから設定するか、
-- 既存データの移行スクリプト(npm run import:xlsx)で取り込まれます。
-- ============================================================

insert into public.schools (id, name, sort_order) values
  ('hirota',   'RED広田教室',     1),
  ('kyomachi', 'RED京町教室',     2),
  ('hino',     'RED日野教室',     3),
  ('saza',     'RED佐々教室',     4),
  ('oshima',   'RED西海大島教室', 5),
  ('ono',      'RED大野教室',     6),
  ('nexta',    'ネクスタ',        7)
on conflict (id) do update
  set name       = excluded.name,
      sort_order = excluded.sort_order;
