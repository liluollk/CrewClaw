/**
 * 解析后端时间戳：SQLite datetime('now') 产出的是无时区的 UTC 串
 * （"2026-09-13 04:27:08"），直接 new Date 会被当本地时间导致偏差；
 * 这里统一补 Z 按_utc 解析。已是 ISO 带 Z/偏移的串原样解析。
 */
export function parseDbTime(value: string | null | undefined): Date {
  if (!value) return new Date(NaN);
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)) return new Date(value);
  return new Date(value.replace(' ', 'T') + 'Z');
}
