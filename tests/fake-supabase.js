/**
 * テスト用のインメモリ Supabase クライアント。
 *
 * supabase-js のうち、このアプリが使っている呼び出しだけを再現している。
 * これにより、実際のAPIハンドラとドメインロジックをそのまま動かして検証できる。
 *
 * 対応: from().select/insert/upsert/update/delete + eq/neq/in/ilike/gte/order/
 *       maybeSingle/head+count、rpc()(schema.sql の3つの関数と同じ挙動)
 */

const tables = { schools: [], slots: [], bookings: [] };
let nextSlotId = 1;

export function resetDb() {
  tables.schools = [];
  tables.slots = [];
  tables.bookings = [];
  nextSlotId = 1;
}

export function seedSchools(rows) {
  tables.schools = rows.map((r) => ({
    notify_email: '',
    sort_order: 0,
    active: true,
    ...r,
  }));
}

export function seedSlots(rows) {
  tables.slots = rows.map((r) => ({
    id: nextSlotId++,
    label: '',
    published: true,
    capacity: 1,
    ...r,
  }));
}

export function seedBookings(rows) {
  tables.bookings = rows.map((r) => ({
    grade: '',
    note: '',
    status: 'confirmed',
    created_at: new Date().toISOString(),
    staff_note: '',
    reminder_sent_at: null,
    interview_done: false,
    interview_note: '',
    interview_updated_at: null,
    ...r,
  }));
}

export const db = tables;
export const dump = (name) => tables[name].map((r) => ({ ...r }));

/** 時刻表記のゆらぎ('14:00' と '14:00:00')を吸収して比較する */
function norm(field, value) {
  if (value === null || value === undefined) return value;
  if (field === 'time') return String(value).slice(0, 5);
  if (field === 'date') return String(value).slice(0, 10);
  return value;
}

function matches(row, filters) {
  return filters.every((f) => {
    const actual = norm(f.field, row[f.field]);
    const expected = norm(f.field, f.value);
    switch (f.op) {
      case 'eq': return actual === expected;
      case 'neq': return actual !== expected;
      case 'in': return f.value.map((v) => norm(f.field, v)).includes(actual);
      case 'ilike':
        return String(actual ?? '').toLowerCase() === String(expected ?? '').toLowerCase();
      case 'gte': return actual >= expected;
      case 'lte': return actual <= expected;
      default: throw new Error('未対応の条件: ' + f.op);
    }
  });
}

/** slot_availability ビューと同じ内容を作る */
function slotAvailability() {
  return tables.slots.map((s) => ({
    ...s,
    booked: tables.bookings.filter(
      (b) =>
        b.status !== 'cancelled' &&
        b.school_id === s.school_id &&
        norm('date', b.date) === norm('date', s.date) &&
        norm('time', b.time) === norm('time', s.time)
    ).length,
  }));
}

function sourceRows(table) {
  if (table === 'slot_availability') return slotAvailability();
  if (!tables[table]) throw new Error('未知のテーブル: ' + table);
  return tables[table];
}

class Query {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.orders = [];
    this.mode = 'select';
    this.payload = null;
    this.wantSingle = false;
    this.headOnly = false;
    this.wantCount = false;
    this.returnRows = false;
    this.upsertOptions = null;
  }

  select(_cols, options) {
    if (options && options.head) this.headOnly = true;
    if (options && options.count) this.wantCount = true;
    if (this.mode !== 'select') this.returnRows = true;
    return this;
  }
  insert(rows) { this.mode = 'insert'; this.payload = rows; return this; }
  upsert(rows, options) {
    this.mode = 'upsert'; this.payload = rows; this.upsertOptions = options || {}; return this;
  }
  update(patch) { this.mode = 'update'; this.payload = patch; return this; }
  delete() { this.mode = 'delete'; return this; }

  eq(field, value) { this.filters.push({ op: 'eq', field, value }); return this; }
  neq(field, value) { this.filters.push({ op: 'neq', field, value }); return this; }
  in(field, value) { this.filters.push({ op: 'in', field, value }); return this; }
  ilike(field, value) { this.filters.push({ op: 'ilike', field, value }); return this; }
  gte(field, value) { this.filters.push({ op: 'gte', field, value }); return this; }
  lte(field, value) { this.filters.push({ op: 'lte', field, value }); return this; }
  order(field, options) {
    this.orders.push({ field, asc: !options || options.ascending !== false });
    return this;
  }
  maybeSingle() { this.wantSingle = true; return this; }

  #sorted(rows) {
    const out = rows.slice();
    for (const o of [...this.orders].reverse()) {
      out.sort((a, b) => {
        const av = a[o.field] ?? '';
        const bv = b[o.field] ?? '';
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (o.asc ? 1 : -1);
      });
    }
    return out;
  }

  #run() {
    if (this.mode === 'select') {
      const rows = this.#sorted(sourceRows(this.table).filter((r) => matches(r, this.filters)));
      if (this.headOnly) return { data: null, count: rows.length, error: null };
      if (this.wantSingle) return { data: rows[0] || null, error: null };
      return { data: rows.map((r) => ({ ...r })), count: rows.length, error: null };
    }

    if (this.mode === 'insert' || this.mode === 'upsert') {
      const target = tables[this.table];
      const inserted = [];
      const conflict = (this.upsertOptions && this.upsertOptions.onConflict || '')
        .split(',').map((c) => c.trim()).filter(Boolean);
      for (const row of this.payload) {
        let existingIndex = -1;
        if (conflict.length) {
          existingIndex = target.findIndex((r) =>
            conflict.every((c) => norm(c, r[c]) === norm(c, row[c]))
          );
        }
        if (existingIndex >= 0) {
          if (this.upsertOptions && this.upsertOptions.ignoreDuplicates) continue;
          target[existingIndex] = { ...target[existingIndex], ...row };
          inserted.push(target[existingIndex]);
          continue;
        }
        const created = { ...row };
        if (this.table === 'slots' && created.id === undefined) created.id = nextSlotId++;
        target.push(created);
        inserted.push(created);
      }
      return { data: this.returnRows ? inserted.map((r) => ({ ...r })) : null, error: null };
    }

    if (this.mode === 'update') {
      const hit = tables[this.table].filter((r) => matches(r, this.filters));
      hit.forEach((r) => Object.assign(r, this.payload));
      return { data: this.returnRows ? hit.map((r) => ({ ...r })) : null, error: null };
    }

    if (this.mode === 'delete') {
      const keep = [];
      const removed = [];
      tables[this.table].forEach((r) => (matches(r, this.filters) ? removed : keep).push(r));
      tables[this.table] = keep;
      return { data: this.returnRows ? removed : null, error: null };
    }

    throw new Error('未対応の操作: ' + this.mode);
  }

  then(resolve, reject) {
    try {
      resolve(this.#run());
    } catch (err) {
      // supabase-js は例外ではなく error を返すので、それに合わせる
      resolve({ data: null, error: { message: String(err.message || err) } });
      if (reject) { /* 使わない */ }
    }
  }
}

// ---------- schema.sql の関数と同じ挙動 ----------
const rpcs = {
  create_booking(p) {
    const slot = tables.slots.find(
      (s) =>
        s.school_id === p.p_school_id &&
        norm('date', s.date) === norm('date', p.p_date) &&
        norm('time', s.time) === norm('time', p.p_time)
    );
    if (!slot) return [{ booking_id: null, error_message: 'その枠は存在しません' }];
    if (slot.published === false) {
      return [{ booking_id: null, error_message: 'その枠は公開されていません' }];
    }
    const booked = tables.bookings.filter(
      (b) =>
        b.status !== 'cancelled' &&
        b.school_id === p.p_school_id &&
        norm('date', b.date) === norm('date', p.p_date) &&
        norm('time', b.time) === norm('time', p.p_time)
    ).length;
    if (booked >= slot.capacity) {
      return [{
        booking_id: null,
        error_message: 'その枠はすでに予約されているか、公開されていません',
      }];
    }
    const id = 'b_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    tables.bookings.push({
      id,
      school_id: p.p_school_id,
      date: p.p_date,
      time: p.p_time,
      child_name: p.p_child_name,
      parent_name: p.p_parent_name,
      email: p.p_email,
      grade: p.p_grade || '',
      note: p.p_note || '',
      status: 'confirmed',
      created_at: new Date().toISOString(),
      staff_note: '',
      reminder_sent_at: null,
      interview_done: false,
      interview_note: '',
      interview_updated_at: null,
    });
    return [{ booking_id: id, error_message: null }];
  },

  update_slot_capacity(p) {
    const slot = tables.slots.find((s) => s.id === p.p_slot_id);
    if (!slot) return [{ updated: false, booked: 0 }];
    const booked = tables.bookings.filter(
      (b) =>
        b.status !== 'cancelled' &&
        b.school_id === slot.school_id &&
        norm('date', b.date) === norm('date', slot.date) &&
        norm('time', b.time) === norm('time', slot.time)
    ).length;
    if (booked > p.p_capacity) return [{ updated: false, booked }];
    slot.capacity = p.p_capacity;
    return [{ updated: true, booked }];
  },

  delete_empty_slots(p) {
    const ids = p.p_slot_ids || [];
    const deleted = [];
    tables.slots = tables.slots.filter((s) => {
      if (!ids.includes(s.id)) return true;
      const hasBooking = tables.bookings.some(
        (b) =>
          b.status !== 'cancelled' &&
          b.school_id === s.school_id &&
          norm('date', b.date) === norm('date', s.date) &&
          norm('time', b.time) === norm('time', s.time)
      );
      if (hasBooking) return true;
      deleted.push({ deleted_id: s.id });
      return false;
    });
    return deleted;
  },
};

export const fakeClient = {
  from(table) { return new Query(table); },
  rpc(name, params) {
    return Promise.resolve().then(() => {
      if (!rpcs[name]) return { data: null, error: { message: '未知の関数: ' + name } };
      try {
        return { data: rpcs[name](params), error: null };
      } catch (err) {
        return { data: null, error: { message: String(err.message || err) } };
      }
    });
  },
};
