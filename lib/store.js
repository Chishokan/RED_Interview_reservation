/**
 * 予約枠・予約データのドメインロジック。
 * GAS版の getAvailableSlots / createBooking / adminXxx をそのまま移植している。
 */

import {
  SCHOOLS,
  findSchoolById,
  slotsSheetName,
  bookingsSheetName,
  COL,
  BOOKING_COL_COUNT,
  SLOT_COL,
  SLOT_COL_COUNT,
  DEFAULT_CAPACITY,
} from './schools.js';
import {
  formatDate,
  formatTime,
  formatDateTime,
  makeKey,
  nowStamp,
  zonedToEpochMs,
} from './format.js';
import {
  readRows,
  appendRow,
  appendRows,
  updateCells,
  batchUpdateValues,
  deleteRows,
  colLetter,
} from './sheets.js';

/** チェックボックス等の TRUE 判定(boolean / 'TRUE' 文字列の両方に対応) */
export function isTrue(v) {
  if (v === true) return true;
  if (typeof v === 'string') return v.trim().toUpperCase() === 'TRUE';
  return false;
}

/** 公開フラグの判定。GAS版と同じく「明示的に FALSE のときだけ非公開」 */
export function isPublished(v) {
  if (v === false) return false;
  if (typeof v === 'string' && v.trim().toUpperCase() === 'FALSE') return false;
  return true;
}

/** 定員セルの値を正規化(未設定・不正値は既定値) */
function normalizeCapacity(raw) {
  const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAPACITY;
}

/** 予約データの1行を予約オブジェクトに変換する */
export function rowToBooking(r, school) {
  return {
    id: r[0],
    schoolId: school.id,
    schoolName: school.name,
    date: formatDate(r[1]),
    time: formatTime(r[2]),
    childName: r[3],
    parentName: r[4],
    email: r[5],
    grade: r[6],
    note: r[7],
    status: r[8],
    createdAt: formatDateTime(r[9]),
    staffNote: r[10] || '',
    reminderSent: formatDateTime(r[11]),
    interviewDone: isTrue(r[12]),
    interviewNote: r[13] || '',
    interviewUpdated: formatDateTime(r[14]),
  };
}

/** 予約データシートを読む(存在しなければ空配列) */
async function readBookingRows(school) {
  const rows = await readRows(bookingsSheetName(school), BOOKING_COL_COUNT);
  return rows || [];
}

/** 予約枠シートを読む(存在しなければ null) */
async function readSlotRows(school) {
  return readRows(slotsSheetName(school), SLOT_COL_COUNT);
}

/** 枠ごとの有効な予約件数を数える */
function countBookedByKey(bookingRows) {
  const map = new Map();
  bookingRows.forEach((r) => {
    if (r[8] !== 'cancelled') {
      const key = makeKey(r[1], r[2]);
      map.set(key, (map.get(key) || 0) + 1);
    }
  });
  return map;
}

// ========== 保護者向け ==========

/**
 * 予約可能な枠の一覧。
 * 公開済み・定員に空きがある・現在時刻+1時間以降、の枠だけを返す。
 */
export async function getAvailableSlots(schoolId) {
  const school = findSchoolById(schoolId);
  if (!school) return [];
  const [slotRows, bookingRows] = await Promise.all([
    readSlotRows(school),
    readBookingRows(school),
  ]);
  if (!slotRows) return [];

  const bookedCount = countBookedByKey(bookingRows);
  const cutoff = Date.now() + 60 * 60 * 1000; // 直前1時間以内は予約させない

  const result = [];
  slotRows.forEach((r) => {
    const [dateVal, timeVal, label, published] = r;
    if (!dateVal || !timeVal) return;
    if (!isPublished(published)) return;
    const date = formatDate(dateVal);
    const time = formatTime(timeVal);
    if (!date || !time) return;
    const capacity = normalizeCapacity(r[4]);
    const cnt = bookedCount.get(makeKey(date, time)) || 0;
    if (cnt >= capacity) return; // 定員に達している
    if (zonedToEpochMs(date, time) < cutoff) return;
    result.push({
      date,
      time,
      label: label ? String(label) : '',
      capacity,
      booked: cnt,
      remaining: capacity - cnt,
    });
  });
  return result;
}

/** メールアドレスから全校舎の予約を横断検索する */
export async function getMyBookings(email) {
  if (!email) return [];
  const normEmail = String(email).trim().toLowerCase();
  const perSchool = await Promise.all(
    SCHOOLS.map(async (school) => {
      const rows = await readBookingRows(school);
      return rows
        .filter((r) => String(r[5]).trim().toLowerCase() === normEmail)
        .map((r) => rowToBooking(r, school));
    })
  );
  return perSchool.flat();
}

/**
 * 予約を作成する。
 *
 * GAS版は LockService で排他制御していたが、サーバーレスでは同等の仕組みが無い。
 * そこで「追記 → 再読込 → 定員超過なら自分の行を取り消す」という楽観的な方式で
 * 二重予約を防いでいる(先に行が入った予約が勝つ)。
 */
export async function createBooking(body) {
  const { schoolId, email, date, time, childName, parentName, grade, note } = body || {};
  if (!schoolId || !email || !date || !time || !childName || !parentName) {
    return { ok: false, error: 'パラメータが不足しています' };
  }
  const school = findSchoolById(schoolId);
  if (!school) return { ok: false, error: '校舎が見つかりません' };

  const available = await getAvailableSlots(schoolId);
  const found = available.find((s) => s.date === date && s.time === time);
  if (!found) {
    return { ok: false, error: 'その枠はすでに予約されているか、公開されていません' };
  }

  const id = 'b_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const sheetName = bookingsSheetName(school);
  await appendRow(sheetName, [
    id, date, time, childName, parentName, email,
    grade || '', note || '', 'confirmed', nowStamp(), '', '', false, '', '',
  ]);

  // 追記直後にもう一度読み直し、同時アクセスで定員を超えていないか確認する
  const rowsAfter = await readBookingRows(school);
  const key = makeKey(date, time);
  const sameSlot = [];
  rowsAfter.forEach((r, idx) => {
    if (r[8] !== 'cancelled' && makeKey(r[1], r[2]) === key) {
      sameSlot.push({ id: r[0], rowNum: idx + 2 });
    }
  });
  const myIndex = sameSlot.findIndex((x) => x.id === id);
  if (myIndex >= 0 && myIndex >= found.capacity) {
    // 競合に負けたので自分の予約を取り消す
    await updateCells(sheetName, sameSlot[myIndex].rowNum, [
      { col: COL.STATUS, value: 'cancelled' },
      { col: COL.STAFF_NOTE, value: '同時予約のため自動取消' },
    ]);
    return {
      ok: false,
      error: 'ちょうど同じ枠が埋まってしまいました。別の枠をお選びください。',
    };
  }

  return {
    ok: true,
    id,
    booking: {
      schoolId: school.id,
      schoolName: school.name,
      date, time, childName, parentName, email,
      grade: grade || '',
      note: note || '',
    },
  };
}

/** 保護者による予約キャンセル(本人のメールアドレス一致が条件) */
export async function cancelBooking(body) {
  const { schoolId, email, id } = body || {};
  const school = findSchoolById(schoolId);
  if (!school) return { ok: false, error: '校舎が見つかりません' };
  const rows = await readBookingRows(school);
  const normEmail = String(email || '').trim().toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === id && String(rows[i][5]).trim().toLowerCase() === normEmail) {
      await updateCells(bookingsSheetName(school), i + 2, [
        { col: COL.STATUS, value: 'cancelled' },
      ]);
      return { ok: true };
    }
  }
  return { ok: false, error: '予約が見つかりません' };
}

/** 保護者による予約内容の変更(本人のメールアドレス一致が条件) */
export async function updateBooking(body) {
  const { schoolId, email, id, date, time, childName, parentName, grade, note } = body || {};
  const school = findSchoolById(schoolId);
  if (!school) return { ok: false, error: '校舎が見つかりません' };
  const rows = await readBookingRows(school);
  const normEmail = String(email || '').trim().toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] !== id) continue;
    if (String(rows[i][5]).trim().toLowerCase() !== normEmail) continue;

    const oldDate = formatDate(rows[i][1]);
    const oldTime = formatTime(rows[i][2]);
    if (oldDate !== date || oldTime !== time) {
      const available = await getAvailableSlots(schoolId);
      if (!available.find((s) => s.date === date && s.time === time)) {
        return { ok: false, error: '変更先の枠はすでに予約されているか、公開されていません' };
      }
    }
    await updateCells(bookingsSheetName(school), i + 2, [
      { col: COL.DATE, value: date },
      { col: COL.TIME, value: time },
      { col: COL.CHILD, value: childName },
      { col: COL.PARENT, value: parentName },
      { col: COL.GRADE, value: grade || '' },
      { col: COL.NOTE, value: note || '' },
    ]);
    return { ok: true };
  }
  return { ok: false, error: '予約が見つかりません' };
}

// ========== 管理画面向け ==========

/** 全ての枠(過去・非公開・予約済みも含む)を、予約者情報つきで返す */
export async function getAllSlots(schoolId) {
  const school = findSchoolById(schoolId);
  if (!school) return [];
  const [slotRows, bookingRows] = await Promise.all([
    readSlotRows(school),
    readBookingRows(school),
  ]);
  if (!slotRows) return [];

  const bookingsMap = new Map();
  bookingRows.forEach((r) => {
    if (r[8] !== 'cancelled') {
      const key = makeKey(r[1], r[2]);
      const list = bookingsMap.get(key) || [];
      list.push({ childName: r[3], parentName: r[4], email: r[5], grade: r[6] });
      bookingsMap.set(key, list);
    }
  });

  const now = Date.now();
  const result = [];
  slotRows.forEach((r, idx) => {
    const [dateVal, timeVal, label, published] = r;
    if (!dateVal || !timeVal) return;
    const date = formatDate(dateVal);
    const time = formatTime(timeVal);
    if (!date || !time) return;
    const bookings = bookingsMap.get(makeKey(date, time)) || [];
    result.push({
      rowNum: idx + 2,
      date,
      time,
      label: label ? String(label) : '',
      published: isPublished(published),
      isPast: zonedToEpochMs(date, time) < now,
      capacity: normalizeCapacity(r[4]),
      booked: bookings.length,
      bookings,
      booking: bookings[0] || null, // 旧API互換
    });
  });
  result.sort((a, b) => makeKey(a.date, a.time).localeCompare(makeKey(b.date, b.time)));
  return result;
}

/** 校舎の全予約を返す */
export async function getAllBookings(schoolId) {
  const school = findSchoolById(schoolId);
  if (!school) return [];
  const rows = await readBookingRows(school);
  return rows
    .map((r, idx) => {
      const b = rowToBooking(r, school);
      b.rowNum = idx + 2;
      return b;
    })
    .sort((a, b) => makeKey(a.date, a.time).localeCompare(makeKey(b.date, b.time)));
}

/** 枠をまとめて追加する(既存と重複する日時はスキップ) */
export async function adminAddSlots(body) {
  const { schoolId, slots } = body || {};
  const school = findSchoolById(schoolId);
  if (!school) return { ok: false, error: '校舎が見つかりません' };
  if (!slots || slots.length === 0) return { ok: false, error: '追加する枠がありません' };

  const sheetName = slotsSheetName(school);
  const slotRows = await readSlotRows(school);
  if (!slotRows) return { ok: false, error: 'シートが見つかりません' };

  const existing = new Set();
  slotRows.forEach((r) => {
    if (r[0] && r[1]) existing.add(makeKey(r[0], r[1]));
  });

  const toAdd = [];
  let skipped = 0;
  slots.forEach((s) => {
    const date = formatDate(s.date);
    const time = formatTime(s.time);
    if (!date || !time) { skipped++; return; }
    const key = date + ' ' + time;
    if (existing.has(key)) { skipped++; return; }
    let cap = parseInt(s.capacity, 10);
    if (!cap || cap < 1) cap = DEFAULT_CAPACITY;
    toAdd.push([date, time, s.label || '', true, cap]);
    existing.add(key);
  });

  if (toAdd.length > 0) await appendRows(sheetName, toAdd);
  return { ok: true, added: toAdd.length, skipped };
}

/** 枠1件の公開状態・ラベル・定員を更新する */
export async function adminUpdateSlot(body) {
  const { schoolId, rowNum } = body || {};
  const school = findSchoolById(schoolId);
  if (!school) return { ok: false, error: '校舎が見つかりません' };
  const slotRows = await readSlotRows(school);
  if (!slotRows) return { ok: false, error: 'シートが見つかりません' };
  if (!(rowNum >= 2 && rowNum <= slotRows.length + 1)) {
    return { ok: false, error: '行番号が不正です' };
  }

  const updates = [];
  if (body.published !== undefined) {
    updates.push({ col: SLOT_COL.PUBLISHED, value: body.published === true || body.published === 'true' });
  }
  if (body.label !== undefined) {
    updates.push({ col: SLOT_COL.LABEL, value: body.label || '' });
  }
  if (body.capacity !== undefined) {
    const cap = parseInt(body.capacity, 10);
    if (!cap || cap < 1) return { ok: false, error: '定員は1以上の数字を指定してください' };
    // 既存予約数を下回る定員には変更できない
    const bookingRows = await readBookingRows(school);
    const row = slotRows[rowNum - 2];
    const cnt = countBookedByKey(bookingRows).get(makeKey(row[0], row[1])) || 0;
    if (cnt > cap) {
      return { ok: false, error: `この枠にはすでに${cnt}件の予約があるため、定員${cap}にはできません` };
    }
    updates.push({ col: SLOT_COL.CAPACITY, value: cap });
  }
  if (!updates.length) return { ok: true };

  await updateCells(slotsSheetName(school), rowNum, updates);
  return { ok: true };
}

/** 複数の枠の定員をまとめて変更する */
export async function adminBulkUpdateCapacity(body) {
  const { schoolId, rowNums, capacity } = body || {};
  const school = findSchoolById(schoolId);
  if (!school) return { ok: false, error: '校舎が見つかりません' };
  if (!rowNums || rowNums.length === 0) return { ok: false, error: '対象の枠が選択されていません' };
  const cap = parseInt(capacity, 10);
  if (!cap || cap < 1) return { ok: false, error: '定員は1以上の数字を指定してください' };

  const [slotRows, bookingRows] = await Promise.all([
    readSlotRows(school),
    readBookingRows(school),
  ]);
  if (!slotRows) return { ok: false, error: 'シートが見つかりません' };
  const bookedCount = countBookedByKey(bookingRows);

  const data = [];
  let skipped = 0;
  const skipReasons = [];
  rowNums.forEach((rowNum) => {
    if (!(rowNum >= 2 && rowNum <= slotRows.length + 1)) { skipped++; return; }
    const row = slotRows[rowNum - 2];
    const cnt = bookedCount.get(makeKey(row[0], row[1])) || 0;
    if (cnt > cap) {
      skipped++;
      skipReasons.push(
        `${formatDate(row[0])} ${formatTime(row[1])} (予約${cnt}件あり、定員${cap}未満にできず)`
      );
      return;
    }
    data.push({ range: `${colLetter(SLOT_COL.CAPACITY)}${rowNum}`, values: [[cap]] });
  });

  if (data.length) await batchUpdateValues(slotsSheetName(school), data);
  return { ok: true, updated: data.length, skipped, skipReasons };
}

/** 枠を1件削除する */
export async function adminDeleteSlot(body) {
  const { schoolId, rowNum } = body || {};
  const school = findSchoolById(schoolId);
  if (!school) return { ok: false, error: '校舎が見つかりません' };
  const slotRows = await readSlotRows(school);
  if (!slotRows) return { ok: false, error: 'シートが見つかりません' };
  if (!(rowNum >= 2 && rowNum <= slotRows.length + 1)) {
    return { ok: false, error: '行番号が不正です' };
  }
  await deleteRows(slotsSheetName(school), [rowNum]);
  return { ok: true };
}

/**
 * 枠をまとめて削除する(削除モード用)。
 * 予約が入っている枠は安全のため削除せずスキップする。
 */
export async function adminDeleteSlots(body) {
  const { schoolId, rowNums } = body || {};
  const school = findSchoolById(schoolId);
  if (!school) return { ok: false, error: '校舎が見つかりません' };
  if (!rowNums || rowNums.length === 0) return { ok: false, error: '削除対象が指定されていません' };

  const [slotRows, bookingRows] = await Promise.all([
    readSlotRows(school),
    readBookingRows(school),
  ]);
  if (!slotRows) return { ok: false, error: 'シートが見つかりません' };

  const bookedKeys = new Set();
  bookingRows.forEach((r) => {
    if (r[8] !== 'cancelled') bookedKeys.add(makeKey(r[1], r[2]));
  });

  const validRows = [];
  let skippedBooked = 0;
  rowNums.forEach((rowNum) => {
    if (!(rowNum >= 2 && rowNum <= slotRows.length + 1)) return;
    const row = slotRows[rowNum - 2];
    if (bookedKeys.has(makeKey(row[0], row[1]))) { skippedBooked++; return; }
    validRows.push(rowNum);
  });

  const deleted = validRows.length ? await deleteRows(slotsSheetName(school), validRows) : 0;
  return { ok: true, deleted, skippedBooked };
}

/** 職員による予約キャンセル */
export async function adminCancelBooking(body) {
  const { schoolId, id } = body || {};
  const school = findSchoolById(schoolId);
  if (!school) return { ok: false, error: '校舎が見つかりません' };
  const rows = await readBookingRows(school);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === id) {
      await updateCells(bookingsSheetName(school), i + 2, [
        { col: COL.STATUS, value: 'cancelled' },
      ]);
      return { ok: true };
    }
  }
  return { ok: false, error: '予約が見つかりません' };
}

/**
 * 職員による予約変更。送られてきたフィールドだけを部分更新する。
 */
export async function adminUpdateBooking(body) {
  const { schoolId, id } = body || {};
  const school = findSchoolById(schoolId);
  if (!school) return { ok: false, error: '校舎が見つかりません' };
  const rows = await readBookingRows(school);

  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] !== id) continue;
    const rowNum = i + 2;
    const oldDate = formatDate(rows[i][1]);
    const oldTime = formatTime(rows[i][2]);
    const newDate = body.date !== undefined ? body.date : oldDate;
    const newTime = body.time !== undefined ? body.time : oldTime;

    if (oldDate !== newDate || oldTime !== newTime) {
      const isDup = rows.some(
        (r, idx) =>
          idx !== i &&
          r[8] !== 'cancelled' &&
          formatDate(r[1]) === newDate &&
          formatTime(r[2]) === newTime
      );
      if (isDup) return { ok: false, error: '変更先の枠はすでに予約されています' };
    }

    const updates = [];
    if (body.date !== undefined) updates.push({ col: COL.DATE, value: newDate });
    if (body.time !== undefined) updates.push({ col: COL.TIME, value: newTime });
    if (body.childName !== undefined) updates.push({ col: COL.CHILD, value: body.childName });
    if (body.parentName !== undefined) updates.push({ col: COL.PARENT, value: body.parentName });
    if (body.grade !== undefined) updates.push({ col: COL.GRADE, value: body.grade || '' });
    if (body.note !== undefined) updates.push({ col: COL.NOTE, value: body.note || '' });
    if (body.staffNote !== undefined) {
      updates.push({ col: COL.STAFF_NOTE, value: body.staffNote || '' });
    }

    let touchedInterview = false;
    if (body.interviewDone !== undefined) {
      updates.push({ col: COL.INTERVIEW_DONE, value: body.interviewDone === true });
      touchedInterview = true;
    }
    if (body.interviewNote !== undefined) {
      updates.push({ col: COL.INTERVIEW_NOTE, value: body.interviewNote || '' });
      touchedInterview = true;
    }
    if (touchedInterview) {
      updates.push({ col: COL.INTERVIEW_UPDATED, value: nowStamp() });
    }

    if (updates.length) await updateCells(bookingsSheetName(school), rowNum, updates);
    return { ok: true };
  }
  return { ok: false, error: '予約が見つかりません' };
}
