const SOFIA_TIME_ZONE = 'Europe/Sofia'
const IMPORT_START_HOUR = 8
const IMPORT_END_HOUR = 11

export interface MenuFreshnessDecision {
  needsImport: boolean
  reason: 'fresh' | 'stale' | 'outside-window'
  sofiaDate: string
}

export interface SofiaClock {
  date: string
  hour: number
  weekday: string
}

export function sofiaClock(now: Date): SofiaClock {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SOFIA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    weekday: values.weekday,
  }
}

function hasPlausibleReadyMenu(value: unknown, expectedDate: string): boolean {
  if (!value || typeof value !== 'object') return false

  const publication = value as Record<string, unknown>
  if (publication.status !== 'ready' || !publication.menu || typeof publication.menu !== 'object') {
    return false
  }

  const menu = publication.menu as Record<string, unknown>
  if (menu.date !== expectedDate || menu.currency !== 'EUR' || !Array.isArray(menu.categories)) {
    return false
  }

  const items = menu.categories.flatMap((category) => {
    if (!category || typeof category !== 'object') return []
    const categoryItems = (category as Record<string, unknown>).items
    return Array.isArray(categoryItems) ? categoryItems : []
  })

  return menu.categories.length >= 2
    && items.length >= 8
    && items.every((item) => {
      if (!item || typeof item !== 'object') return false
      const priceCents = (item as Record<string, unknown>).priceCents
      return Number.isInteger(priceCents) && Number(priceCents) > 0
    })
}

export function evaluateMenuFreshness(
  publication: unknown,
  now: Date = new Date(),
  force = false,
): MenuFreshnessDecision {
  const clock = sofiaClock(now)
  const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(clock.weekday)
  const isImportHour = clock.hour >= IMPORT_START_HOUR && clock.hour <= IMPORT_END_HOUR

  if (!force && (!isWeekday || !isImportHour)) {
    return { needsImport: false, reason: 'outside-window', sofiaDate: clock.date }
  }

  if (hasPlausibleReadyMenu(publication, clock.date)) {
    return { needsImport: false, reason: 'fresh', sofiaDate: clock.date }
  }

  return { needsImport: true, reason: 'stale', sofiaDate: clock.date }
}
