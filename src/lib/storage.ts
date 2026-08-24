import type { Quantities } from './order.ts'

export interface BasketDraft {
  date: string
  quantities: Quantities
  participantName: string
  note: string
}

const STORAGE_KEY = 'mandarin-order-draft-v1'

export function loadDraft(date: string, storage: Storage = localStorage): BasketDraft | null {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<BasketDraft>
    if (parsed.date !== date) {
      storage.removeItem(STORAGE_KEY)
      return null
    }
    return {
      date,
      quantities: parsed.quantities ?? {},
      participantName: parsed.participantName ?? '',
      note: parsed.note ?? '',
    }
  } catch {
    storage.removeItem(STORAGE_KEY)
    return null
  }
}

export function saveDraft(draft: BasketDraft, storage: Storage = localStorage): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(draft))
}

export function clearDraft(storage: Storage = localStorage): void {
  storage.removeItem(STORAGE_KEY)
}
