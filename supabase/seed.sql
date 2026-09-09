-- ============================================================
-- 部門マスタ・校舎マスタの初期データ
-- schema.sql を実行したあとに、続けてこれを実行してください。
-- 何度実行しても安全です。
--
-- 通知先メールアドレスとLINE WORKSのトークルームIDは、
-- 管理画面の「🛠 システム設定」タブから設定できます。
-- ============================================================

-- ---------- 部門 ----------
insert into public.departments (id, name, slug, accent_color, grades, sort_order) values
  ('red', 'RED部門', 'red', '#3182ce', array[
     '小学1年','小学2年','小学3年','小学4年','小学5年','小学6年',
     '中学1年','中学2年','中学3年',
     '高校1年','高校2年','高校3年','その他'
   ], 1),
  ('chutobu', '中等部', 'chutobu', '#2f855a', array[
     '小学4年','小学5年','小学6年',
     '中学1年','中学2年','中学3年','その他'
   ], 2)
on conflict (id) do update
  set name         = excluded.name,
      slug         = excluded.slug,
      accent_color = excluded.accent_color,
      grades       = excluded.grades,
      sort_order   = excluded.sort_order;

-- ---------- RED部門の校舎 ----------
-- 部門を導入する前から使っているIDなので、そのまま変更していません。
insert into public.schools (id, name, department_id, sort_order) values
  ('hirota',   'RED広田教室',     'red', 1),
  ('kyomachi', 'RED京町教室',     'red', 2),
  ('hino',     'RED日野教室',     'red', 3),
  ('saza',     'RED佐々教室',     'red', 4),
  ('oshima',   'RED西海大島教室', 'red', 5),
  ('ono',      'RED大野教室',     'red', 6),
  ('nexta',    'ネクスタ',        'red', 7)
on conflict (id) do update
  set name          = excluded.name,
      department_id = excluded.department_id,
      sort_order    = excluded.sort_order;

-- ---------- 中等部の校舎 ----------
-- 「日野校」「大野校」はRED部門にも同名IDの校舎があるため、
-- 部門を頭に付けたID(chutobu_...)で区別しています。
insert into public.schools (id, name, department_id, sort_order) values
  ('chutobu_sasebo', '佐世保駅前校', 'chutobu', 1),
  ('chutobu_hino',   '日野校',       'chutobu', 2),
  ('chutobu_ono',    '大野校',       'chutobu', 3),
  ('chutobu_hiu',    '日宇校',       'chutobu', 4),
  -- 校舎ではなくコース。保護者の選択肢としては校舎と同じ扱いになる
  ('chutobu_kenritsu', '県立中受検対策コース', 'chutobu', 5)
on conflict (id) do update
  set name          = excluded.name,
      department_id = excluded.department_id,
      sort_order    = excluded.sort_order;
