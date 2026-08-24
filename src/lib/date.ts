import { SOFIA_TIME_ZONE } from './menu-schema.ts'

export function sofiaDate(input: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SOFIA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(input)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export function formatBulgarianDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Intl.DateTimeFormat('bg-BG', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: SOFIA_TIME_ZONE,
  }).format(new Date(Date.UTC(year, month - 1, day, 12)))
}

export function isTodayInSofia(date: string, now: Date = new Date()): boolean {
  return date === sofiaDate(now)
}
