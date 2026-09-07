-- ============================================================
-- 面談予約システム スキーマ (Supabase / PostgreSQL)
--
-- Supabaseの SQL Editor にこのファイルの内容を貼り付けて実行してください。
-- 何度実行しても安全です(既にある場合は作り直しません)。
-- ============================================================

-- ---------- 校舎マスタ ----------
-- GAS版ではコード内の定数と「通知先」シートに分かれていたものを1つにまとめている。
create table if not exists public.schools (
  id           text primary key,
  name         text not null,
  notify_email text not null default '',   -- 新規予約の通知先(カンマ区切りで複数可)
  sort_order   int  not null default 0,
  active       boolean not null default true
);

comment on table public.schools is '校舎マスタ。notify_email は新規予約時の通知先';

-- ---------- 予約枠 ----------
create table if not exists public.slots (
  id         bigint generated always as identity primary key,
  school_id  text not null references public.schools(id) on update cascade,
  date       date not null,
  time       time not null,
  label      text not null default '',
  published  boolean not null default true,
  capacity   int not null default 1 check (capacity >= 1),
  created_at timestamptz not null default now(),
  unique (school_id, date, time)
);

create index if not exists slots_school_date_idx on public.slots (school_id, date);

comment on table public.slots is '面談の予約枠。(校舎, 日付, 時刻) で一意';

-- ---------- 予約 ----------
create table if not exists public.bookings (
  id                   text primary key,
  school_id            text not null references public.schools(id) on update cascade,
  date                 date not null,
  time                 time not null,
  child_name           text not null,
  parent_name          text not null,
  email                text not null,
  grade                text not null default '',
  note                 text not null default '',
  status               text not null default 'confirmed'
                         check (status in ('confirmed', 'cancelled')),
  created_at           timestamptz not null default now(),
  staff_note           text not null default '',
  reminder_sent_at     timestamptz,
  interview_done       boolean not null default false,
  interview_note       text not null default '',
  interview_updated_at timestamptz
);

create index if not exists bookings_school_date_idx on public.bookings (school_id, date);
create index if not exists bookings_email_idx       on public.bookings (lower(email));
-- 前日リマインドは「キャンセルでない・未送信」の予約を日付で引くので、その条件で索引を張る
create index if not exists bookings_reminder_idx    on public.bookings (date)
  where status <> 'cancelled' and reminder_sent_at is null;

comment on table public.bookings is '面談の予約。idはGAS版と同じ b_<ミリ秒>_<乱数> 形式';

-- ---------- 枠の空き状況ビュー ----------
-- 枠ごとの有効な予約件数を数えたもの。保護者向けの空き枠表示と管理画面で使う。
create or replace view public.slot_availability
with (security_invoker = on) as
select
  s.id,
  s.school_id,
  s.date,
  s.time,
  s.label,
  s.published,
  s.capacity,
  coalesce(b.booked, 0)::int as booked
from public.slots s
left join (
  select school_id, date, time, count(*) as booked
    from public.bookings
   where status <> 'cancelled'
   group by school_id, date, time
) b
  on b.school_id = s.school_id
 and b.date      = s.date
 and b.time      = s.time;

-- ---------- 予約作成(排他制御つき) ----------
-- GAS版の LockService の代わり。枠の行をロックしてから件数を数えて挿入するため、
-- 同時に予約が来ても定員を超えることがない。
create or replace function public.create_booking(
  p_school_id   text,
  p_date        date,
  p_time        time,
  p_child_name  text,
  p_parent_name text,
  p_email       text,
  p_grade       text default '',
  p_note        text default ''
) returns table (booking_id text, error_message text)
language plpgsql
as $$
declare
  v_capacity  int;
  v_published boolean;
  v_booked    int;
  v_id        text;
begin
  -- 対象の枠を行ロックする(同じ枠への同時予約はここで直列化される)
  select capacity, published
    into v_capacity, v_published
    from public.slots
   where school_id = p_school_id and date = p_date and time = p_time
     for update;

  if not found then
    return query select null::text, 'その枠は存在しません'::text;
    return;
  end if;

  if not v_published then
    return query select null::text, 'その枠は公開されていません'::text;
    return;
  end if;

  select count(*) into v_booked
    from public.bookings
   where school_id = p_school_id and date = p_date and time = p_time
     and status <> 'cancelled';

  if v_booked >= v_capacity then
    return query select null::text, 'その枠はすでに予約されているか、公開されていません'::text;
    return;
  end if;

  v_id := 'b_'
       || (extract(epoch from clock_timestamp()) * 1000)::bigint::text
       || '_' || substr(md5(random()::text), 1, 5);

  insert into public.bookings
    (id, school_id, date, time, child_name, parent_name, email, grade, note)
  values
    (v_id, p_school_id, p_date, p_time, p_child_name, p_parent_name, p_email,
     coalesce(p_grade, ''), coalesce(p_note, ''));

  return query select v_id, null::text;
end;
$$;

-- ---------- 枠の定員変更(予約数を下回れないようにする) ----------
create or replace function public.update_slot_capacity(
  p_slot_id  bigint,
  p_capacity int
) returns table (updated boolean, booked int)
language plpgsql
as $$
declare
  v_school_id text;
  v_date      date;
  v_time      time;
  v_booked    int;
begin
  select school_id, date, time
    into v_school_id, v_date, v_time
    from public.slots where id = p_slot_id for update;

  if not found then
    return query select false, 0;
    return;
  end if;

  select count(*) into v_booked
    from public.bookings
   where school_id = v_school_id and date = v_date and time = v_time
     and status <> 'cancelled';

  -- すでに入っている予約より少ない定員にはできない
  if v_booked > p_capacity then
    return query select false, v_booked;
    return;
  end if;

  update public.slots set capacity = p_capacity where id = p_slot_id;
  return query select true, v_booked;
end;
$$;

-- ---------- 枠の削除(予約が入っている枠は残す) ----------
create or replace function public.delete_empty_slots(
  p_slot_ids bigint[]
) returns table (deleted_id bigint)
language sql
as $$
  delete from public.slots s
   where s.id = any(p_slot_ids)
     and not exists (
       select 1 from public.bookings b
        where b.school_id = s.school_id
          and b.date = s.date
          and b.time = s.time
          and b.status <> 'cancelled'
     )
  returning s.id;
$$;

-- ============================================================
-- アクセス制御
--
-- このアプリはVercelのサーバーからのみDBに触れる(service_roleキーを使う)。
-- ブラウザに配られる anon キーからは一切読み書きできないようにするため、
-- 全テーブルでRLSを有効にしたうえで、ポリシーを1つも作らない。
-- ============================================================
alter table public.schools  enable row level security;
alter table public.slots    enable row level security;
alter table public.bookings enable row level security;

revoke all on public.slot_availability      from anon, authenticated;
revoke all on public.schools                from anon, authenticated;
revoke all on public.slots                  from anon, authenticated;
revoke all on public.bookings               from anon, authenticated;
revoke execute on function public.create_booking(text, date, time, text, text, text, text, text)
  from anon, authenticated;
revoke execute on function public.update_slot_capacity(bigint, int) from anon, authenticated;
revoke execute on function public.delete_empty_slots(bigint[])      from anon, authenticated;
