const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

export interface CalendarDate {
  year: number
  month: number
  day: number
}

export function parseCalendarDate(value: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const check = new Date(0)
  check.setUTCFullYear(year, month - 1, day)
  check.setUTCHours(0, 0, 0, 0)
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) return null
  return { year, month, day }
}

export function shanghaiDateParts(date: Date): CalendarDate & { weekday: number } {
  const local = new Date(date.getTime() + SHANGHAI_OFFSET_MS)
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    weekday: local.getUTCDay(),
  }
}

// month/day 可越界，用于计算次日、周一及跨年的零点。
export function shanghaiDayStartIso(year: number, month: number, day: number): string {
  const local = new Date(0)
  local.setUTCFullYear(year, month - 1, day)
  local.setUTCHours(0, 0, 0, 0)
  return new Date(local.getTime() - SHANGHAI_OFFSET_MS).toISOString()
}
