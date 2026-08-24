import { describe, expect, it } from 'vitest'
import { loadDraft, saveDraft } from './storage.ts'

describe('local basket lifetime', () => {
  it('restores only the matching menu date', () => {
    saveDraft({ date: '2026-08-24', quantities: { soup: 2 }, participantName: 'Иван', note: '' })
    expect(loadDraft('2026-08-24')?.quantities).toEqual({ soup: 2 })

    expect(loadDraft('2026-08-25')).toBeNull()
    expect(localStorage.length).toBe(0)
  })

  it('fails closed on malformed local data', () => {
    localStorage.setItem('mandarin-order-draft-v1', '{broken')
    expect(loadDraft('2026-08-24')).toBeNull()
    expect(localStorage.length).toBe(0)
  })
})
