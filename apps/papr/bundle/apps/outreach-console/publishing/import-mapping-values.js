/* global URL */
export const cell = (row, spec, key) => String(spec.columns[key] ? row[spec.columns[key]] ?? '' : spec.defaults[key] ?? '');
export const list = (value) => value.split(/[\n;,]+/).map((part) => part.trim()).filter(Boolean);
export function nextId(rows, prefix) { const used = new Set(rows.map((row) => row.id)); let n = 1; return () => { while (used.has(`${prefix}-${n}`)) n++; const id = `${prefix}-${n++}`; used.add(id); return id; }; }
export function sourceTable(pack, index) {
  const table = (pack.tables || pack.extractedTables || pack.extracted?.tables || [])[index] || [];
  const rows = table.rows || table; const headers = table.headers || [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return { rows, headers };
}
export function isoSchedule(value) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return false;
  const [, year, month, day, hour, minute, second, zone] = parts; const y = Number(year); const m = Number(month); const d = Number(day);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1] && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60 && (zone === 'Z' || Number(zone.slice(1, 3)) < 24 && Number(zone.slice(4)) < 60) && Number.isFinite(Date.parse(value));
}
export function https(value) { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } }
export const email = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
export function mappingContext(manifest) {
  const errors = []; const repairs = []; const accountRefs = [...(manifest.accountRefs || [])];
  const account = (id, channel, row) => {
    if (!id || id.length > 120) { errors.push(`Row ${row}: choose a logical account reference (1–120 characters).`); return; }
    const ref = accountRefs.find((item) => item.id === id);
    if (ref && ref.channel !== channel) errors.push(`Row ${row}: account ${id} belongs to ${ref.channel}, not ${channel}.`);
    else if (!ref) { accountRefs.push({ id, channel, label: id }); repairs.push(`Map logical account ${id} to a connected ${channel} account after saving.`); }
  };
  return { errors, repairs, accountRefs, account };
}
export function checkSchedule(value, row, errors) { if (!isoSchedule(value)) errors.push(`Row ${row}: schedule must be a real ISO date with seconds and an explicit offset, for example 2026-11-10T09:00:00-05:00.`); }
export function result(manifest, changed, context, rows) { return { manifest: { ...manifest, ...changed, accountRefs: context.accountRefs }, errors: context.errors, repairs: [...new Set(context.repairs)], rows }; }
