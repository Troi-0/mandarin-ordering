import { afterEach, describe, expect, it, vi } from 'vitest'
import { FAVORITES_KEY, favoriteNameKey, loadFavorites, saveFavorites } from './favorites.ts'

afterEach(() => vi.restoreAllMocks())

describe('persistent dish favorites', () => {
  it('normalizes Bulgarian case, Unicode composition, and whitespace', () => {
    expect(favoriteNameKey('  ЙОГУРТ\u00a0 с\t ПЛОДОВЕ  ')).toBe('йогурт с плодове')
    expect(favoriteNameKey('И\u0306огурт с плодове')).toBe('йогурт с плодове')
  })

  it('round-trips favorites independently of basket and name preferences', () => {
    localStorage.setItem('mandarin-order-draft-v1', 'draft')
    localStorage.setItem('mandarin-participant-name-v1', 'name')
    expect(loadFavorites()).toEqual({ favorites: new Set(), available: true })
    const favorites = new Set(['пилешка супа', 'пилешко филе'])
    expect(saveFavorites(favorites, localStorage)).toBe(true)
    expect(loadFavorites(localStorage)).toEqual({ favorites, available: true })
    expect(saveFavorites(new Set())).toBe(true)
    expect(localStorage.getItem(FAVORITES_KEY)).toBeNull()
    expect(localStorage.getItem('mandarin-order-draft-v1')).toBe('draft')
    expect(localStorage.getItem('mandarin-participant-name-v1')).toBe('name')
  })

  it.each(['{broken', 'null', '42', '{}', '"пилешка супа"'])('safely discards malformed favorite lists: %s', (raw) => {
    localStorage.setItem(FAVORITES_KEY, raw)
    localStorage.setItem('unrelated', 'keep')
    expect(loadFavorites()).toEqual({ favorites: new Set(), available: true })
    expect(localStorage.getItem(FAVORITES_KEY)).toBeNull()
    expect(localStorage.getItem('unrelated')).toBe('keep')
  })

  it('repairs duplicates and invalid entries while preserving valid favorites', () => {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([
      ' ПИЛЕШКА  СУПА ', 12, null, {}, '', ' ', 'а', 'а'.repeat(221), 'пилешка супа', 'пилешко филе',
    ]))
    expect(loadFavorites()).toEqual({ favorites: new Set(['пилешка супа', 'пилешко филе']), available: true })
    expect(JSON.parse(localStorage.getItem(FAVORITES_KEY)!)).toEqual(['пилешка супа', 'пилешко филе'])
  })

  it('keeps valid favorites in memory when repairing the saved list fails', () => {
    localStorage.setItem(FAVORITES_KEY, '["Пилешка супа",42]')
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
    expect(loadFavorites()).toEqual({ favorites: new Set(['пилешка супа']), available: false })
  })

  it('catches a blocked localStorage getter when loading, saving, and removing', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError') } })
    try {
      expect(loadFavorites()).toEqual({ favorites: new Set(), available: false })
      expect(saveFavorites(new Set(['пилешка супа']))).toBe(false)
      expect(saveFavorites(new Set())).toBe(false)
    } finally {
      Object.defineProperty(globalThis, 'localStorage', descriptor)
    }
  })

  it('reports read failures without throwing', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(loadFavorites()).toEqual({ favorites: new Set(), available: false })
  })

  it('reports failed cleanup without deleting other preferences', () => {
    localStorage.setItem(FAVORITES_KEY, 'null')
    localStorage.setItem('unrelated', 'keep')
    vi.spyOn(localStorage, 'removeItem').mockImplementation(() => { throw new Error('blocked') })
    expect(loadFavorites()).toEqual({ favorites: new Set(), available: false })
    expect(saveFavorites(new Set())).toBe(false)
    expect(localStorage.getItem('unrelated')).toBe('keep')
  })

  it('does not destroy saved favorites when a write fails', () => {
    saveFavorites(new Set(['пилешка супа']))
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
    expect(saveFavorites(new Set(['пилешко филе']))).toBe(false)
    expect(loadFavorites()).toEqual({ favorites: new Set(['пилешка супа']), available: true })
  })
})
