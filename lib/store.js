/**
 * 予約枠・予約のドメインロジック(Supabase版)。
 *
 * GAS版の getAvailableSlots / createBooking / adminXxx をそのまま移植している。
 * 画面に返す形(キー名・値の形式)はGAS版と同じに保っているため、
 * フロントエンドの表示ロジックは変わっていない。
 */

import { getDb, unwrap } from './db.js';
import { listSchools, findSchoolById } from './schools.js';
import {
  formatDate,
  formatTime,
  formatDateTime,
  makeKey,
  zonedToEpochMs,
} from './format.js';

/** 予約枠の行を画面用のオブジェクトに変換する */
function toSlot(row, extra = {}) {
  return {
    id: row.id,
    date: formatDate(row.date),
    time: formatTime(row.time),
    label: row.label || '',
    capacity: row.capacity,
    booked: row.booked ?? 0,
    ...extra,
  };
}

/** 予約の行を画面用のオブジェクトに変換する */
export function toBooking(row, school) {
  return {
    id: row.id,
    schoolId: row.school_id,
    schoolName: school ? school.name : '',
    date: formatDate(row.date),
    time: formatTime(row.time),
    childName: row.child_name,
    parentName: row.parent_name,
    email: row.email,
    grade: row.grade || '',
    note: row.note || '',
    status: row.status,
    createdAt: formatDateTime(row.created_at),
    staffNote: row.staff_note || '',
    reminderSent: formatDateTime(row.reminder_sent_at),
    interviewDone: row.interview_done === true,
    interviewNote: row.interview_note || '',
    interviewUpdated: formatDateTime(row.interview_updated_at),
  };
}

const BOOKING_COLUMNS =
  'id, school_id, date, time, child_name, parent_name, email, grade, note, status, ' +
  'created_at, staff_note, reminder_sent_at, interview_done, interview_note, interview_updated_at';

// ========== 保護者向け ==========

/**
 * 予約可能な枠の一覧。
 * 公開済み・定員に空きがある・現在時刻+1時間以降、の枠だけを返す。
 */
export async function getAvailableSlots(schoolId) {
  const school = await findSchoolById(schoolId);
  if (!school) return [];

  const db = getDb();
  const rows = unwrap(
    await db
      .from('slot_availability')
      .select('id, date, time, label, published, capacity, booked')
      .eq('school_id', schoolId)
      .eq('published', true)
      .order('date', { ascending: true })
      .order('time', { ascending: true }),
    '予約枠の取得'
  );

  const cutoff = Date.now() + 60 * 60 * 1000; // 直前1時間以内は予約させない
  return (rows || [])
    .filter((r) => r.booked < r.capacity)
    .map((r) => toSlot(r, { remaining: r.capacity - r.booked }))
    .filter((s) => s.date && s.time && zonedToEpochMs(s.date, s.time) >= cutoff);
}

/** メールアドレスから全校舎の予約を横断検索する */
export async function getMyBookings(email) {
  if (!email) return [];
  const db = getDb();
  const schools = await listSchools({ includeInactive: true });
  const byId = new Map(schools.map((s) => [s.id, s]));

  // ilike はワイルドカード無しなら大文字小文字を区別しない一致になる
  const rows = unwrap(
    await db
      .from('bookings')
      .select(BOOKING_COLUMNS)
      .ilike('email', String(email).trim())
      .order('date', { ascending: true })
      .order('time', { ascending: true }),
    '予約の取得'
  );
  return (rows || []).map((r) => toBooking(r, byId.get(r.school_id)));
}

/**
 * 予約を作成する。
 *
 * 定員の確認と挿入はDBの関数 create_booking の中で行う。
 * 枠の行をロックしてから処理するため、同時に予約が来ても定員を超えない。
 */
export async function createBooking(body) {
  const { schoolId, email, date, time, childName, parentName, grade, note } = body || {};
  if (!schoolId || !email || !date || !time || !childName || !parentName) {
    return { ok: false, error: 'パラメータが不足しています' };
  }
  const school = await findSchoolById(schoolId);
  if (!school) return { ok: false, error: '校舎が見つかりません' };

  const normDate = formatDate(date);
  const normTime = formatTime(time);
  if (!normDate || !normTime) return { ok: false, error: '日時の形式が正しくありません' };

  // 直前1時間以内の枠は受け付けない(画面の表示と同じ条件をサーバー側でも確認する)
  if (zonedToEpochMs(normDate, normTime) < Date.now() + 60 * 60 * 1000) {
    return { ok: false, error: 'その枠は受付時間を過ぎています' };
  }

  const db = getDb();
  const rows = unwrap(
    await db.rpc('create_booking', {
      p_school_id: schoolId,
      p_date: normDate,
      p_time: normTime,
      p_child_name: childName,
      p_parent_name: parentName,
      p_email: String(email).trim(),
      p_grade: grade || '',
      p_note: note || '',
    }),
    '予約の作成'
  );

  const result = Array.isArray(rows) ? rows[0] : rows;
  if (!result || !result.booking_id) {
    return {
      ok: false,
      error: (result && result.error_message) || '予約を作成できませんでした',
    };
  }

  return {
    ok: true,
    id: result.booking_id,
    booking: {
      schoolId: school.id,
      schoolName: school.name,
      date: normDate,
      time: normTime,
      childName,
      parentName,
      email: String(email).trim(),
      grade: grade || '',
      note: note || '',
    },
  };
}

/** 保護者による予約キャンセル(本人のメールアドレス一致が条件) */
export async function cancelBooking(body) {
  const { schoolId, email, id } = body || {};
  const school = await findSchoolById(schoolId);
  if (!school) return { ok: false, error: '校舎が見つかりません' };

  const db = getDb();
  const rows = unwrap(
    await db
      .from('bookings')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('school_id', schoolId)
      .ilike('email', String(email || '').trim())
      .select('id'),
    '予約のキャンセル'
  );
  if (!rows || rows.length === 0) return { ok: false, error: '予約が見つかりません' };
  return { ok: true };
}

/** 保護者による予約内容の変更(本人のメールアドレス一致が条件) */
export async function updateBooking(body) {
  const { schoolId, email, id, date, time, childName, parentName, grade, note } = body || {};
  const school = await findSchoolById(schoolId);
  if (!school) return { ok: false, error: '校舎が見つかりません' };

  const db = getDb();
  const existing = unwrap(
    await db
      .from('bookings')
      .select('id, date, time')
      .eq('id', id)
      .eq('school_id', schoolId)
      .ilike('email', String(email || '').trim())
      .maybeSingle(),
    '予約の取得'
  );
  if (!existing) return { ok: false, error: '予約が見つかりません' };

  const newDate = formatDate(date);
  const newTime = formatTime(time);
  if (!newDate || !newTime) return { ok: false, error: '日時の形式が正しくありません' };

  if (formatDate(existing.date) !== newDate || formatTime(existing.time) !== newTime) {
    const available = await getAvailableSlots(schoolId);
    if (!available.find((s) => s.date === newDate && s.time === newTime)) {
      return { ok: false, error: '変更先の枠はすでに予約されているか、公開されていません' };
    }
  }

  unwrap(
    await db
      .from('bookings')
      .update({
        date: newDate,
        time: newTime,
        child_name: childName,
        parent_name: parentName,
        grade: grade || '',
        note: note || '',
      })
      .eq('id', id),
    '予約の更新'
  );
  return { ok: true };
}

// ========== 管理画面向け ==========

/** 全ての枠(過去・非公開・予約済みも含む)を、予約者情報つきで返す */
export async function getAllSlots(schoolId) {
  const school = await findSchoolById(schoolId);
  if (!school) return [];
  const db = getDb();

  const [slotRows, bookingRows] = await Promise.all([
    listSlotAvailability(db, schoolId),
    unwrap(
      await db
        .from('bookings')
        .select('date, time, child_name, parent_name, email, grade')
        .eq('school_id', schoolId)
        .neq('status', 'cancelled'),
      '予約の取得'
    ),
  ]);

  const bookingsByKey = new Map();
  (bookingRows || []).forEach((b) => {
    const key = makeKey(b.date, b.time);
    const list = bookingsByKey.get(key) || [];
    list.push({
      childName: b.child_name,
      parentName: b.parent_name,
      email: b.email,
      grade: b.grade,
    });
    bookingsByKey.set(key, list);
  });

  const now = Date.now();
  return (slotRows || [])
    .map((r) => {
      const slot = toSlot(r);
      if (!slot.date || !slot.time) return null;
      const bookings = bookingsByKey.get(makeKey(slot.date, slot.time)) || [];
      return {
        ...slot,
        published: r.published !== false,
        isPast: zonedToEpochMs(slot.date, slot.time) < now,
        booked: bookings.length,
        bookings,
        booking: bookings[0] || null, // 旧API互換
      };
    })
    .filter(Boolean);
}

async function listSlotAvailability(db, schoolId) {
  return unwrap(
    await db
      .from('slot_availability')
      .select('id, date, time, label, published, capacity, booked')
      .eq('school_id', schoolId)
      .order('date', { ascending: true })
      .order('time', { ascending: true }),
    '予約枠の取得'
  );
}

/** 校舎の全予約を返す */
export async function getAllBookings(schoolId) {
  const school = await findSchoolById(schoolId);
  if (!school) return [];
  const db = getDb();
  const rows = unwrap(
    await db
      .from('bookings')
      .select(BOOKING_COLUMNS)
      .eq('school_id', schoolId)
      .order('date', { ascending: true })
      .order('time', { ascending: true }),
    '予約の取得'
  );
  return (rows || []).map((r) => toBooking(r, school));
}

/** 枠をまとめて追加する(既存と重複する日時はスキップ) */
export async function adminAddSlots(body) {
  const { schoolId, slots } = body || {};
  const school = await findSchoolById(schoolId);
  if (!school) return { ok: false, error: '校舎が見つかりません' };
  if (!slots || slots.length === 0) return { ok: false, error: '追加する枠がありません' };

  const rows = [];
  const seen = new Set();
  let skipped = 0;
  slots.forEach((s) => {
    const date = formatDate(s.date);
    const time = formatTime(s.time);
    if (!date || !time) { skipped++; return; }
    const key = date + ' ' + time;
    if (seen.has(key)) { skipped++; return; }
    seen.add(key);
    let capacity = parseInt(s.capacity, 10);
    if (!capacity || capacity < 1) capacity = 1;
    rows.push({
      school_id: schoolId,
      date,
      time,
      label: s.label || '',
      published: true,
      capacity,
    });
  });
  if (rows.length === 0) return { ok: true, added: 0, skipped };

  const db = getDb();
  // (校舎, 日付, 時刻) が重複する枠は挿入せず読み飛ばす
  const inserted = unwrap(
    await db
      .from('slots')
      .upsert(rows, { onConflict: 'school_id,date,time', ignoreDuplicates: true })
      .select('id'),
    '予約枠の追加'
  );
  const added = (inserted || []).length;
  return { ok: true, added, skipped: skipped + (rows.length - added) };
}

/** 枠1件の公開状態・ラベル・定員を更新する */
export async function adminUpdateSlot(body) {
  const { schoolId, id } = body || {};
  const school = await findSchoolById(schoolId);
  if (!school) return { ok: false, error: '校舎が見つかりません' };
  if (id === undefined || id === null) return { ok: false, error: '枠が指定されていません' };
  const db = getDb();

  // 定員はDBの関数で変更する(予約数を下回れないことを保証するため)
  if (body.capacity !== undefined) {
    const capacity = parseInt(body.capacity, 10);
    if (!capacity || capacity < 1) {
      return { ok: false, error: '定員は1以上の数字を指定してください' };
    }
    const rows = unwrap(
      await db.rpc('update_slot_capacity', { p_slot_id: Number(id), p_capacity: capacity }),
      '定員の変更'
    );
    const result = Array.isArray(rows) ? rows[0] : rows;
    if (!result || result.updated !== true) {
      const booked = result ? result.booked : 0;
      if (booked > capacity) {
        return {
          ok: false,
          error: `この枠にはすでに${booked}件の予約があるため、定員${capacity}にはできません`,
        };
      }
      return { ok: false, error: '枠が見つかりません' };
    }
  }

  const patch = {};
  if (body.published !== undefined) {
    patch.published = body.published === true || body.published === 'true';
  }
  if (body.label !== undefined) patch.label = body.label || '';

  if (Object.keys(patch).length) {
    const rows = unwrap(
      await db.from('slots').update(patch).eq('id', id).eq('school_id', schoolId).select('id'),
      '予約枠の更新'
    );
    if (!rows || rows.length === 0) return { ok: false, error: '枠が見つかりません' };
  }
  return { ok: true };
}

/** 複数の枠の定員をまとめて変更する */
export async function adminBulkUpdateCapacity(body) {
  const { schoolId, ids, capacity } = body || {};
  const school = await findSchoolById(schoolId);
  if (!school) return { ok: false, error: '校舎が見つかりません' };
  if (!ids || ids.length === 0) return { ok: false, error: '対象の枠が選択されていません' };
  const cap = parseInt(capacity, 10);
  if (!cap || cap < 1) return { ok: false, error: '定員は1以上の数字を指定してください' };

  const db = getDb();
  let updated = 0;
  let skipped = 0;
  const skipReasons = [];

  for (const id of ids) {
    const rows = unwrap(
      await db.rpc('update_slot_capacity', { p_slot_id: Number(id), p_capacity: cap }),
      '定員の変更'
    );
    const result = Array.isArray(rows) ? rows[0] : rows;
    if (result && result.updated === true) {
      updated++;
    } else {
      skipped++;
      if (result && result.booked > cap) {
        skipReasons.push(`枠ID ${id} (予約${result.booked}件あり、定員${cap}未満にできず)`);
      }
    }
  }
  return { ok: true, updated, skipped, skipReasons };
}

/** 枠を1件削除する(予約が入っていれば削除しない) */
export async function adminDeleteSlot(body) {
  const { schoolId, id } = body || {};
  const result = await adminDeleteSlots({ schoolId, ids: [id] });
  if (!result.ok) return result;
  if (result.deleted === 0) {
    return { ok: false, error: 'この枠は予約が入っているため削除できません' };
  }
  return { ok: true };
}

/**
 * 枠をまとめて削除する(削除モード用)。
 * 予約が入っている枠は安全のため削除せずスキップする。
 */
export async function adminDeleteSlots(body) {
  const { schoolId, ids } = body || {};
  const school = await findSchoolById(schoolId);
  if (!school) return { ok: false, error: '校舎が見つかりません' };
  if (!ids || ids.length === 0) return { ok: false, error: '削除対象が指定されていません' };

  const db = getDb();
  // 校舎をまたいだ削除を防ぐため、対象がこの校舎の枠かどうかを先に確認する
  const owned = unwrap(
    await db
      .from('slots')
      .select('id')
      .eq('school_id', schoolId)
      .in('id', ids.map(Number)),
    '予約枠の取得'
  );
  const ownedIds = (owned || []).map((r) => r.id);
  if (ownedIds.length === 0) return { ok: true, deleted: 0, skippedBooked: 0 };

  const rows = unwrap(
    await db.rpc('delete_empty_slots', { p_slot_ids: ownedIds }),
    '予約枠の削除'
  );
  const deleted = (rows || []).length;
  return { ok: true, deleted, skippedBooked: ownedIds.length - deleted };
}

/** 職員による予約キャンセル */
export async function adminCancelBooking(body) {
  const { schoolId, id } = body || {};
  const school = await findSchoolById(schoolId);
  if (!school) return { ok: false, error: '校舎が見つかりません' };
  const db = getDb();
  const rows = unwrap(
    await db
      .from('bookings')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('school_id', schoolId)
      .select('id'),
    '予約のキャンセル'
  );
  if (!rows || rows.length === 0) return { ok: false, error: '予約が見つかりません' };
  return { ok: true };
}

/**
 * 職員による予約変更。送られてきたフィールドだけを部分更新する。
 */
export async function adminUpdateBooking(body) {
  const { schoolId, id } = body || {};
  const school = await findSchoolById(schoolId);
  if (!school) return { ok: false, error: '校舎が見つかりません' };
  const db = getDb();

  const existing = unwrap(
    await db
      .from('bookings')
      .select('id, date, time')
      .eq('id', id)
      .eq('school_id', schoolId)
      .maybeSingle(),
    '予約の取得'
  );
  if (!existing) return { ok: false, error: '予約が見つかりません' };

  const oldDate = formatDate(existing.date);
  const oldTime = formatTime(existing.time);
  const newDate = body.date !== undefined ? formatDate(body.date) : oldDate;
  const newTime = body.time !== undefined ? formatTime(body.time) : oldTime;
  if (!newDate || !newTime) return { ok: false, error: '日時の形式が正しくありません' };

  if (oldDate !== newDate || oldTime !== newTime) {
    // 変更先の枠が他の予約で埋まっていないか確認する
    const others = unwrap(
      await db
        .from('bookings')
        .select('id')
        .eq('school_id', schoolId)
        .eq('date', newDate)
        .eq('time', newTime)
        .neq('status', 'cancelled')
        .neq('id', id),
      '予約の確認'
    );
    if (others && others.length > 0) {
      return { ok: false, error: '変更先の枠はすでに予約されています' };
    }
  }

  const patch = {};
  if (body.date !== undefined) patch.date = newDate;
  if (body.time !== undefined) patch.time = newTime;
  if (body.childName !== undefined) patch.child_name = body.childName;
  if (body.parentName !== undefined) patch.parent_name = body.parentName;
  if (body.grade !== undefined) patch.grade = body.grade || '';
  if (body.note !== undefined) patch.note = body.note || '';
  if (body.staffNote !== undefined) patch.staff_note = body.staffNote || '';

  let touchedInterview = false;
  if (body.interviewDone !== undefined) {
    patch.interview_done = body.interviewDone === true;
    touchedInterview = true;
  }
  if (body.interviewNote !== undefined) {
    patch.interview_note = body.interviewNote || '';
    touchedInterview = true;
  }
  if (touchedInterview) patch.interview_updated_at = new Date().toISOString();

  if (Object.keys(patch).length) {
    unwrap(await db.from('bookings').update(patch).eq('id', id), '予約の更新');
  }
  return { ok: true };
}
