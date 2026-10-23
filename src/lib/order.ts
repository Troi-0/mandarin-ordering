import type { Menu, MenuItem } from './menu-schema.ts'

export type Quantities = Record<string, number>

export const BOX_FEE_CENTS = 10
// The restaurant charges for takeaway boxes on top of these categories' published prices.
const BOXED_CATEGORY_NAMES = new Set(['супи', 'основни', 'скара'])

interface OrderLine {
  itemId: string
  name: string
  portion?: string
  quantity: number
  unitPriceCents: number
  lineTotalCents: number
  boxCount: number
}

interface OrderTotals {
  boxCount: number
  boxesCents: number
  totalCents: number
}

interface OrderSummary extends OrderTotals {
  participantName: string
  note?: string
  menuDate: string
  sourceUrl: string
  lines: OrderLine[]
}

const euroFormatter = new Intl.NumberFormat('bg-BG', {
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

function needsBox(categoryName: string): boolean {
  return BOXED_CATEGORY_NAMES.has(categoryName.trim().toLocaleLowerCase('bg-BG'))
}

export function createOrderLines(menu: Menu, quantities: Quantities): OrderLine[] {
  const items = new Map<string, { item: MenuItem; boxed: boolean }>()
  menu.categories.forEach((category) => {
    const boxed = needsBox(category.name)
    category.items.forEach((item) => items.set(item.id, { item, boxed }))
  })

  return Object.entries(quantities)
    .filter(([, quantity]) => quantity > 0)
    .map(([itemId, quantity]) => {
      const entry = items.get(itemId)
      if (!entry) throw new Error(`Unknown item id: ${itemId}`)
      const { item, boxed } = entry
      const safeQuantity = clampQuantity(quantity)
      return {
        itemId,
        name: item.name,
        ...(item.portion ? { portion: item.portion } : {}),
        quantity: safeQuantity,
        unitPriceCents: item.priceCents,
        lineTotalCents: item.priceCents * safeQuantity,
        boxCount: boxed ? safeQuantity : 0,
      }
    })
}

export function calculateTotals(lines: OrderLine[]): OrderTotals {
  const boxCount = lines.reduce((sum, line) => sum + line.boxCount, 0)
  const boxesCents = boxCount * BOX_FEE_CENTS
  return {
    boxCount,
    boxesCents,
    totalCents: lines.reduce((sum, line) => sum + line.lineTotalCents, boxesCents),
  }
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
    ...calculateTotals(lines),
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
    ...(summary.boxCount > 0 ? [`${summary.boxCount} × Кутия — ${formatEuro(summary.boxesCents)}`] : []),
    '',
    `Общо: ${formatEuro(summary.totalCents)}`,
  ]
  if (summary.note) lines.push(`Бележка: ${summary.note}`)
  return lines.join('\n')
}
