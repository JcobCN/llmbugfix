const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHANGHAI_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23', weekday: 'short',
});

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }
const weekdayNumber: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localParts(value: Date): LocalParts {
  const values = Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value]));
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second),
    weekday: weekdayNumber[values.weekday] ?? 0,
  };
}

function timeZoneOffsetMs(value: Date): number {
  const parts = localParts(value);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.trunc(value.getTime() / 1_000) * 1_000;
}

function localToDate(year: number, month: number, day: number, hour: number): Date {
  const wallClock = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
  let candidate = new Date(wallClock);
  for (let iteration = 0; iteration < 3; iteration += 1) candidate = new Date(wallClock - timeZoneOffsetMs(candidate));
  return candidate;
}

function addLocalDays(parts: Pick<LocalParts, 'year' | 'month' | 'day'>, days: number): Pick<LocalParts, 'year' | 'month' | 'day'> {
  const normalized = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: normalized.getUTCFullYear(), month: normalized.getUTCMonth() + 1, day: normalized.getUTCDate() };
}

function isoWithShanghaiOffset(value: Date): string {
  const parts = localParts(value);
  const offsetMinutes = Math.round(timeZoneOffsetMs(value) / 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const pad = (number: number): string => String(number).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

export interface WeeklyReportPeriod { readonly periodStart: string; readonly periodEnd: string }

function weekPeriod(value: Date, weekOffset = 0): WeeklyReportPeriod {
  const current = localParts(value);
  const daysSinceMonday = (current.weekday + 6) % 7;
  const monday = addLocalDays(current, -daysSinceMonday + weekOffset * 7);
  const saturday = addLocalDays(monday, 5);
  return {
    periodStart: isoWithShanghaiOffset(localToDate(monday.year, monday.month, monday.day, 0)),
    periodEnd: isoWithShanghaiOffset(localToDate(saturday.year, saturday.month, saturday.day, 9)),
  };
}

/** Most recent reporting period whose Saturday 09:00 deadline has arrived. */
export function mostRecentDuePeriod(now: Date): WeeklyReportPeriod {
  if (Number.isNaN(now.getTime())) throw new RangeError('Invalid clock value');
  const current = weekPeriod(now);
  return now.getTime() >= Date.parse(current.periodEnd) ? current : weekPeriod(now, -1);
}

/** The first Shanghai Saturday 09:00 strictly after the supplied instant. */
export function nextScheduledPeriod(now: Date): WeeklyReportPeriod {
  if (Number.isNaN(now.getTime())) throw new RangeError('Invalid clock value');
  const current = weekPeriod(now);
  return now.getTime() < Date.parse(current.periodEnd) ? current : weekPeriod(now, 1);
}

export function shanghaiDate(value: string): string {
  const parts = localParts(new Date(value));
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function shanghaiDateTime(value: string): string {
  const parts = localParts(new Date(value));
  const pad = (number: number): string => String(number).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}
