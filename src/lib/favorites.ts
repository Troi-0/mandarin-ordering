export const FAVORITES_KEY = 'mandarin-favorite-dishes-v1'

interface FavoritesPreference {
  favorites: Set<string>
  available: boolean
}

// Menu IDs include position and portion. Match the full name across publications,
// preserving ingredients and variants while tolerating case and whitespace changes.
export function favoriteNameKey(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase('bg-BG').trim().replace(/\s+/g, ' ')
}

export function loadFavorites(storage?: Storage): FavoritesPreference {
  const favorites = new Set<string>()
  try {
    const store = storage ?? localStorage
    const raw = store.getItem(FAVORITES_KEY)
    if (raw === null) return { favorites, available: true }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { parsed = null }
    if (!Array.isArray(parsed)) {
      store.removeItem(FAVORITES_KEY)
      return { favorites, available: true }
    }

    let repaired = false
    for (const entry of parsed) {
      if (typeof entry !== 'string') {
        repaired = true
        continue
      }
      const key = favoriteNameKey(entry)
      if (key.length < 2 || key.length > 220) {
        repaired = true
        continue
      }
      if (key !== entry || favorites.has(key)) repaired = true
      favorites.add(key)
    }
    return { favorites, available: !repaired || saveFavorites(favorites, store) }
  } catch {
    return { favorites, available: false }
  }
}

export function saveFavorites(favorites: ReadonlySet<string>, storage?: Storage): boolean {
  try {
    const store = storage ?? localStorage
    if (favorites.size > 0) store.setItem(FAVORITES_KEY, JSON.stringify([...favorites].sort()))
    else store.removeItem(FAVORITES_KEY)
    return true
  } catch {
    return false
  }
}
