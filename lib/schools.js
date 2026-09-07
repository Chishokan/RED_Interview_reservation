/**
 * 校舎マスタと、スプレッドシート上のシート名の規約。
 * GAS版の SCHOOLS / slotsSheetName / bookingsSheetName をそのまま移植している。
 */

export const SCHOOLS = [
  { id: 'hirota', name: 'RED広田教室' },
  { id: 'kyomachi', name: 'RED京町教室' },
  { id: 'hino', name: 'RED日野教室' },
  { id: 'saza', name: 'RED佐々教室' },
  { id: 'oshima', name: 'RED西海大島教室' },
  { id: 'ono', name: 'RED大野教室' },
  { id: 'nexta', name: 'ネクスタ' },
];

export function slotsSheetName(school) {
  return school.name + '予約枠';
}

export function bookingsSheetName(school) {
  return school.name + '予約データ';
}

export function findSchoolById(id) {
  return SCHOOLS.find((s) => s.id === id);
}

/** 通知先メールアドレスを管理するシート名 */
export const NOTIFY_SHEET_NAME = '通知先';

// ===== 予約データの列定義(1-indexed) =====
export const COL = {
  ID: 1,
  DATE: 2,
  TIME: 3,
  CHILD: 4,
  PARENT: 5,
  EMAIL: 6,
  GRADE: 7,
  NOTE: 8,
  STATUS: 9,
  CREATED: 10,
  STAFF_NOTE: 11,
  REMINDER_SENT: 12,
  INTERVIEW_DONE: 13,
  INTERVIEW_NOTE: 14,
  INTERVIEW_UPDATED: 15,
};
export const BOOKING_COL_COUNT = 15;

export const BOOKING_HEADERS = [
  '予約ID', '日付', '時刻', 'お子様名', '保護者名', 'メールアドレス', '学年', '相談内容',
  '状態', '予約日時', '職員メモ', 'リマインド送信済', '面談実施', '面談記録', '記録更新日時',
];

// ===== 予約枠の列定義(1-indexed) =====
export const SLOT_COL = {
  DATE: 1,
  TIME: 2,
  LABEL: 3,
  PUBLISHED: 4,
  CAPACITY: 5,
};
export const SLOT_COL_COUNT = 5;
export const DEFAULT_CAPACITY = 1;

export const SLOT_HEADERS = ['日付', '時刻', '枠ラベル(任意)', '公開(TRUE/FALSE)', '定員'];

export const NOTIFY_HEADERS = ['校舎ID', '校舎名', '通知先メールアドレス'];
