import type { Menu, MenuItem } from './menu-schema.ts'

export type Quantities = Record<string, number>

export interface OrderLine {
  itemId: string
  name: string
  portion?: string
  quantity: number
  unitPriceCents: number
  lineTotalCents: number
}

export interface OrderSummary {
  participantName: string
  note?: string
  menuDate: string
  sourceUrl: string
  lines: OrderLine[]
  totalCents: number
}

export const euroFormatter = new Intl.NumberFormat('bg-BG', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
})

export function formatEuro(cents: number): string {
  return euroFormatter.format(cents / 100)
}

export function clampQuantity(value: number): number {
  return Math.max(0, Math.min(20, Math.trunc(value)))
}

export function createOrderLines(menu: Menu, quantities: Quantities): OrderLine[] {
  const items = new Map<string, MenuItem>()
  menu.categories.forEach((category) => category.items.forEach((item) => items.set(item.id, item)))

  return Object.entries(quantities)
    .filter(([, quantity]) => quantity > 0)
    .map(([itemId, quantity]) => {
      const item = items.get(itemId)
      if (!item) throw new Error(`Unknown item id: ${itemId}`)
      const safeQuantity = clampQuantity(quantity)
      return {
        itemId,
        name: item.name,
        ...(item.portion ? { portion: item.portion } : {}),
        quantity: safeQuantity,
        unitPriceCents: item.priceCents,
        lineTotalCents: item.priceCents * safeQuantity,
      }
    })
}

export function createOrderSummary(
  menu: Menu,
  quantities: Quantities,
  participantName: string,
  note: string,
): OrderSummary {
  const lines = createOrderLines(menu, quantities)
  return {
    participantName: participantName.trim(),
    ...(note.trim() ? { note: note.trim() } : {}),
    menuDate: menu.date,
    sourceUrl: menu.source.postUrl,
    lines,
    totalCents: lines.reduce((sum, line) => sum + line.lineTotalCents, 0),
  }
}

export function summaryToText(summary: OrderSummary): string {
  const lines = [
    `Обяд за ${summary.menuDate} — ${summary.participantName}`,
    '',
    ...summary.lines.map(
      (line) =>
        `${line.quantity} × ${line.name}${line.portion ? ` (${line.portion})` : ''} — ${formatEuro(line.lineTotalCents)}`,
    ),
    '',
    `Общо: ${formatEuro(summary.totalCents)}`,
  ]
  if (summary.note) lines.push(`Бележка: ${summary.note}`)
  lines.push('', `Източник: ${summary.sourceUrl}`)
  return lines.join('\n')
}
