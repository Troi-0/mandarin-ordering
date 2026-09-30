import type { Menu } from './menu-schema.ts'
import { clampQuantity, type Quantities } from './order.ts'

interface BasketDraft {
  date: string
  quantities: Quantities
  participantName: string
  note: string
}

const STORAGE_KEY = 'mandarin-order-draft-v1'
const NAME_KEY = 'mandarin-participant-name-v1'

export function loadNamePreference(storage?: Storage): { participantName: string; remember: boolean; available: boolean } {
  const empty = { participantName: '', remember: false, available: true }
  try {
    const store = storage ?? localStorage
    const raw = store.getItem(NAME_KEY)
    if (raw === null) return empty
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { parsed = null }
    if (typeof parsed !== 'string') {
      store.removeItem(NAME_KEY)
      return empty
    }
    return { participantName: parsed.trim(), remember: true, available: true }
  } catch {
    return { ...empty, available: false }
  }
}

export function saveNamePreference(participantName: string, remember: boolean, storage?: Storage): boolean {
  try {
    const store = storage ?? localStorage
    if (remember) store.setItem(NAME_KEY, JSON.stringify(participantName.trim()))
    else store.removeItem(NAME_KEY)
    return true
  } catch {
    return false
  }
}

interface DraftRecovery {
  draft: BasketDraft | null
  available: boolean
  adjusted: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function loadDraft(menu: Menu, storage?: Storage): DraftRecovery {
  const empty = { draft: null, available: true, adjusted: false }
  let store: Storage
  let raw: string | null
  try {
    // Accessing localStorage itself can throw when persistence is blocked.
    store = storage ?? localStorage
    raw = store.getItem(STORAGE_KEY)
  } catch {
    return { ...empty, available: false }
  }
  if (!raw) return empty

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...empty, available: clearDraft(store) }
  }
  if (!isRecord(parsed) || parsed.date !== menu.date) {
    return { ...empty, available: clearDraft(store) }
  }

  const items = new Map(menu.categories.flatMap((category) => category.items.map((item) => [item.id, item] as const)))
  const quantities: Quantities = {}
  let adjusted = false
  const savedQuantities = isRecord(parsed.quantities) ? parsed.quantities : {}
  if (parsed.quantities !== undefined && !isRecord(parsed.quantities)) adjusted = true

  for (const [id, value] of Object.entries(savedQuantities)) {
    const item = items.get(id)
    if (!item || typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      adjusted = true
      continue
    }
    // Older drafts have no item snapshot. Their IDs must still exist in today's menu.
    if (parsed.items !== undefined) {
      const previous = isRecord(parsed.items) ? parsed.items[id] : undefined
      if (!isRecord(previous) || previous.name !== item.name || previous.portion !== item.portion
        || typeof previous.priceCents !== 'number' || !Number.isFinite(previous.priceCents)) {
        adjusted = true
        continue
      }
      if (previous.priceCents !== item.priceCents) adjusted = true
    }
    quantities[id] = clampQuantity(value)
    if (quantities[id] !== value) adjusted = true
  }

  const participantName = typeof parsed.participantName === 'string' ? parsed.participantName : ''
  const note = typeof parsed.note === 'string' ? parsed.note.slice(0, 240) : ''
  if ((parsed.participantName !== undefined && parsed.participantName !== participantName)
    || (parsed.note !== undefined && parsed.note !== note)) adjusted = true

  return { draft: { date: menu.date, quantities, participantName, note }, available: true, adjusted }
}

export function saveDraft(draft: BasketDraft, menu: Menu, storage?: Storage): boolean {
  try {
    const items = Object.fromEntries(menu.categories.flatMap((category) => category.items
      .filter((item) => (draft.quantities[item.id] ?? 0) > 0)
      .map((item) => [item.id, { name: item.name, portion: item.portion, priceCents: item.priceCents }])))
    const store = storage ?? localStorage
    store.setItem(STORAGE_KEY, JSON.stringify({ ...draft, items }))
    return true
  } catch {
    return false
  }
}

export function clearDraft(storage?: Storage): boolean {
  try {
    const store = storage ?? localStorage
    store.removeItem(STORAGE_KEY)
    return true
  } catch {
    return false
  }
}
