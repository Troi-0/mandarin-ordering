import { afterEach, describe, expect, it, vi } from 'vitest'
import { menuFixture } from '../test/menu-fixture.ts'
import { NAME_KEY, NAME_CONSENT_KEY, clearDraft, loadDraft, loadNamePreference, saveDraft, saveNamePreference, updateRememberedName } from './storage.ts'

afterEach(() => vi.restoreAllMocks())

describe('local basket lifetime', () => {
  it('round-trips quantities, participant name, and note locally', () => {
    const draft = {
      date: '2026-08-24',
      quantities: { soup: 2, main: 1 },
      participantName: 'Мария',
      note: 'Без люто',
    }
    expect(saveDraft(draft, menuFixture)).toBe(true)
    expect(loadDraft(menuFixture)).toEqual({ draft, available: true, adjusted: false })
  })

  it('restores only the matching menu date', () => {
    saveDraft({ date: '2026-08-24', quantities: { soup: 2 }, participantName: 'Иван', note: '' }, menuFixture)
    expect(loadDraft(menuFixture).draft?.quantities).toEqual({ soup: 2 })

    expect(loadDraft({ ...menuFixture, date: '2026-08-25' }).draft).toBeNull()
    expect(localStorage.length).toBe(0)
  })

  it('fails closed on malformed local data', () => {
    localStorage.setItem('mandarin-order-draft-v1', '{broken')
    expect(loadDraft(menuFixture).draft).toBeNull()
    expect(localStorage.length).toBe(0)
  })

  it('defaults missing optional draft fields without inventing selections', () => {
    localStorage.setItem('mandarin-order-draft-v1', JSON.stringify({ date: '2026-08-24' }))
    expect(loadDraft(menuFixture).draft).toEqual({
      date: '2026-08-24',
      quantities: {},
      participantName: '',
      note: '',
    })
  })

  it('clears a saved draft explicitly', () => {
    saveDraft({ date: '2026-08-24', quantities: { soup: 1 }, participantName: '', note: '' }, menuFixture)
    expect(clearDraft()).toBe(true)
    expect(loadDraft(menuFixture).draft).toBeNull()
  })

  it('drops obsolete IDs while preserving valid legacy selections and text', () => {
    localStorage.setItem('mandarin-order-draft-v1', JSON.stringify({ date: menuFixture.date, quantities: { soup: 2, removed: 1 }, participantName: 'Иван', note: 'Без хляб' }))
    expect(loadDraft(menuFixture)).toEqual({
      draft: { date: menuFixture.date, quantities: { soup: 2 }, participantName: 'Иван', note: 'Без хляб' },
      adjusted: true,
      available: true,
    })
  })

  it.each([null, [], 'text', 3])('rejects an invalid draft root: %j', (value) => {
    localStorage.setItem('mandarin-order-draft-v1', JSON.stringify(value))
    expect(loadDraft(menuFixture).draft).toBeNull()
  })

  it.each([null, [], 'two'])('discards a malformed quantities record: %j', (quantities) => {
    localStorage.setItem('mandarin-order-draft-v1', JSON.stringify({ date: menuFixture.date, quantities, participantName: 'Иван' }))
    expect(loadDraft(menuFixture)).toMatchObject({ draft: { quantities: {}, participantName: 'Иван' }, adjusted: true })
  })

  it.each(['2', null, -1, 0, 1.5])('discards an invalid quantity instead of pricing it: %j', (value) => {
    localStorage.setItem('mandarin-order-draft-v1', JSON.stringify({ date: menuFixture.date, quantities: { soup: value } }))
    expect(loadDraft(menuFixture)).toMatchObject({ draft: { quantities: {} }, adjusted: true })
  })

  it('clamps oversized quantities, validates text, and limits the recovered note', () => {
    localStorage.setItem('mandarin-order-draft-v1', JSON.stringify({ date: menuFixture.date, quantities: { soup: 100 }, participantName: {}, note: 'а'.repeat(241) }))
    expect(loadDraft(menuFixture)).toMatchObject({ draft: { quantities: { soup: 20 }, participantName: '', note: 'а'.repeat(240) }, adjusted: true })
    localStorage.setItem('mandarin-order-draft-v1', JSON.stringify({ date: menuFixture.date, note: [] }))
    expect(loadDraft(menuFixture)).toMatchObject({ draft: { note: '' }, adjusted: true })
  })

  it('keeps quantities when a price is corrected and flags the changed total for review', () => {
    saveDraft({ date: menuFixture.date, quantities: { soup: 2 }, participantName: 'Иван', note: '' }, menuFixture)
    const corrected = structuredClone(menuFixture)
    corrected.categories[0].items[0].priceCents = 300
    expect(loadDraft(corrected)).toMatchObject({ draft: { quantities: { soup: 2 } }, adjusted: true })
    expect(loadDraft(menuFixture).adjusted).toBe(false)
  })

  it.each(['name', 'portion'])('removes a selection if its %s changed under the same ID', (field) => {
    saveDraft({ date: menuFixture.date, quantities: { soup: 2, main: 1 }, participantName: 'Иван', note: '' }, menuFixture)
    const corrected = structuredClone(menuFixture)
    corrected.categories[0].items[0][field as 'name' | 'portion'] = 'Корекция'
    expect(loadDraft(corrected)).toMatchObject({ draft: { quantities: { main: 1 } }, adjusted: true })
  })

  it.each([null, {}, { soup: { name: 'Пилешка супа', portion: '350 мл', priceCents: '270' } }])('does not trust malformed item snapshots: %j', (items) => {
    localStorage.setItem('mandarin-order-draft-v1', JSON.stringify({ date: menuFixture.date, quantities: { soup: 1 }, items }))
    expect(loadDraft(menuFixture)).toMatchObject({ draft: { quantities: {} }, adjusted: true })
  })

  it('catches a blocked storage getter in reads, writes, and clearing', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError') } })
    try {
      expect(loadDraft(menuFixture)).toEqual({ draft: null, adjusted: false, available: false })
      expect(saveDraft({ date: menuFixture.date, quantities: {}, participantName: '', note: '' }, menuFixture)).toBe(false)
      expect(clearDraft()).toBe(false)
      expect(loadNamePreference()).toMatchObject({ remember: false, available: false })
      expect(saveNamePreference('Иван', true)).toBe(false)
      expect(saveNamePreference('', false)).toBe(false)
    } finally {
      Object.defineProperty(globalThis, 'localStorage', descriptor)
    }
  })

  it('handles a failed read and failed cleanup without throwing a second error', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
    vi.spyOn(localStorage, 'removeItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
    expect(loadDraft(menuFixture).available).toBe(false)
    expect(clearDraft()).toBe(false)
  })

  it.each(['{broken', JSON.stringify({ date: '2026-08-23' })])('survives cleanup failures for invalid or expired data: %s', (raw) => {
    localStorage.setItem('mandarin-order-draft-v1', raw)
    vi.spyOn(localStorage, 'removeItem').mockImplementation(() => { throw new Error('blocked') })
    expect(loadDraft(menuFixture)).toEqual({ draft: null, adjusted: false, available: false })
  })

  it('reports full storage without throwing or deleting other site data', () => {
    localStorage.setItem('unrelated', 'keep')
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
    expect(saveDraft({ date: menuFixture.date, quantities: { soup: 1 }, participantName: '', note: '' }, menuFixture)).toBe(false)
    expect(localStorage.getItem('unrelated')).toBe('keep')
  })
})

describe('remembered participant name', () => {
  it('updates only an existing opt-in and retains opt-out even if a stale client writes the legacy name', () => {
    expect(updateRememberedName('Иван')).toMatchObject({ remember: false, available: true })
    expect(localStorage.getItem(NAME_KEY)).toBeNull()
    expect(saveNamePreference('Иван', true)).toBe(true)
    expect(updateRememberedName('  Мария  ')).toMatchObject({ remember: true, available: true })
    expect(localStorage.getItem(NAME_KEY)).toBe('"Мария"')
    expect(saveNamePreference('', false)).toBe(true)
    localStorage.setItem(NAME_KEY, '"От стар раздел"')
    expect(loadNamePreference()).toMatchObject({ remember: false, available: true })
    expect(localStorage.getItem(NAME_KEY)).toBeNull()
    expect(localStorage.getItem(NAME_CONSENT_KEY)).toBe('false')
    expect(saveNamePreference('Ново съгласие', true)).toBe(true)
    expect(loadNamePreference()).toMatchObject({ participantName: 'Ново съгласие', remember: true })
  })

  it.each(['opt-out', 'clear'])('keeps a concurrent %s authoritative when it occurs between an automatic name read and write', (operation) => {
    saveNamePreference('Иван', true)
    const setItem = localStorage.setItem.bind(localStorage)
    const removeItem = localStorage.removeItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === NAME_KEY) {
        if (operation === 'clear') localStorage.clear()
        else {
          setItem(NAME_CONSENT_KEY, 'false') // Other tab opts out after the initial read.
          removeItem(NAME_KEY)
        }
      }
      setItem(key, value)
    })
    expect(updateRememberedName('Мария')).toMatchObject({ remember: false, available: true })
    expect(localStorage.getItem(NAME_KEY)).toBeNull()
    expect(loadNamePreference().remember).toBe(false)
  })

  it('fails closed when consent cannot be read and reports a failed automatic name update', () => {
    saveNamePreference('Иван', true)
    const reads = vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
    const writes = vi.spyOn(localStorage, 'setItem')
    expect(updateRememberedName('Мария')).toMatchObject({ available: false })
    expect(writes).not.toHaveBeenCalled()
    reads.mockRestore()
    writes.mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
    expect(updateRememberedName('Мария')).toEqual({ remember: true, available: false })
    expect(localStorage.getItem(NAME_KEY)).toBe('"Иван"')
  })

  it('is opt-in, survives daily draft expiry, and removes only the preference when disabled', () => {
    expect(loadNamePreference()).toEqual({ participantName: '', remember: false, available: true })
    saveDraft({ date: menuFixture.date, quantities: { soup: 1 }, participantName: 'Иван', note: '' }, menuFixture)
    expect(saveNamePreference('  Иван  ', true)).toBe(true)
    expect(loadDraft({ ...menuFixture, date: '2026-08-25' }).draft).toBeNull()
    expect(loadNamePreference()).toEqual({ participantName: 'Иван', remember: true, available: true })
    localStorage.setItem('unrelated', 'keep')
    expect(saveNamePreference('Иван', false)).toBe(true)
    expect(loadNamePreference().remember).toBe(false)
    expect(localStorage.getItem('unrelated')).toBe('keep')
  })

  it.each(['{broken', 'null', '42', '{"name":"Иван"}'])('discards malformed name preferences: %s', (raw) => {
    localStorage.setItem('mandarin-participant-name-v1', raw)
    expect(loadNamePreference()).toEqual({ participantName: '', remember: false, available: true })
    expect(localStorage.getItem('mandarin-participant-name-v1')).toBeNull()
  })

  it('reports storage failures for saving, opting out, and malformed cleanup', () => {
    localStorage.setItem('mandarin-participant-name-v1', 'null')
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
    vi.spyOn(localStorage, 'removeItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
    expect(saveNamePreference('Иван', true)).toBe(false)
    expect(saveNamePreference('', false)).toBe(false)
    expect(loadNamePreference().available).toBe(false)
  })
})
