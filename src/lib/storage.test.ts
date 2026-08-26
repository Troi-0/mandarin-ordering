import { describe, expect, it } from 'vitest'
import { clearDraft, loadDraft, saveDraft } from './storage.ts'

describe('local basket lifetime', () => {
  it('round-trips quantities, participant name, and note locally', () => {
    const draft = {
      date: '2026-08-24',
      quantities: { soup: 2, main: 1 },
      participantName: 'Мария',
      note: 'Без люто',
    }
    saveDraft(draft)
    expect(loadDraft('2026-08-24')).toEqual(draft)
  })

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

  it('defaults missing optional draft fields without inventing selections', () => {
    localStorage.setItem('mandarin-order-draft-v1', JSON.stringify({ date: '2026-08-24' }))
    expect(loadDraft('2026-08-24')).toEqual({
      date: '2026-08-24',
      quantities: {},
      participantName: '',
      note: '',
    })
  })

  it('clears a saved draft explicitly', () => {
    saveDraft({ date: '2026-08-24', quantities: { soup: 1 }, participantName: '', note: '' })
    clearDraft()
    expect(loadDraft('2026-08-24')).toBeNull()
  })
})
