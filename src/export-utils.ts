// Excel serial dates store WIB wall-clock time, independent of the host timezone.
const DAY_MS = 86_400_000;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
export function excelWibDate(iso: string | null): number | string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return (ms + 7 * 3_600_000 - EXCEL_EPOCH) / DAY_MS;
}
export function excelCalendarDate(value: string): number | string {
  const match = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) return value;
  const [, day, month, year] = match;
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const date = new Date(ms);
  if (date.getUTCDate() !== Number(day) || date.getUTCMonth() !== Number(month) - 1) return value;
  return (ms - EXCEL_EPOCH) / DAY_MS;
}
export async function withTimeout<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
