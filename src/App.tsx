import { useEffect, useMemo, useRef, useState } from 'react'
import currentPublicationData from '../data/current-menu.json'
import {
  formatBulgarianDate,
  isMenuOverdue,
  isSofiaWeekend,
  isTodayInSofia,
  nextWorkingSofiaDate,
  sofiaDate,
} from './lib/date.ts'
import {
  FACEBOOK_PAGE_URL,
  menuPublicationSchema,
  type Menu,
  type MenuItem,
} from './lib/menu-schema.ts'
import {
  clampQuantity,
  createOrderLines,
  createOrderSummary,
  formatEuro,
  summaryToText,
  type Quantities,
} from './lib/order.ts'
import { clearDraft, loadDraft, loadNamePreference, saveDraft, saveNamePreference } from './lib/storage.ts'
import { FAVORITES_KEY, favoriteNameKey, loadFavorites, saveFavorites } from './lib/favorites.ts'

type Notice = { kind: 'success' | 'error'; text: string } | null

function QuantityControl({
  item,
  quantity,
  onChange,
  inBasket = false,
}: {
  item: Pick<MenuItem, 'name'>
  quantity: number
  onChange: (quantity: number) => void
  inBasket?: boolean
}) {
  const context = inBasket ? ' в избора' : ''
  return (
    <div className="quantity-control" aria-label={`Количество${context} за ${item.name}`}>
      <button
        className="quantity-button"
        type="button"
        aria-label={`Намали ${item.name}${context}`}
        disabled={quantity === 0}
        onClick={() => onChange(clampQuantity(quantity - 1))}
      >
        −
      </button>
      <output aria-live="polite" aria-label={`Избрано количество${context}: ${quantity}`}>
        {quantity}
      </output>
      <button
        className="quantity-button quantity-button--add"
        type="button"
        aria-label={`Добави ${item.name}${context}`}
        disabled={quantity >= 20}
        onClick={() => onChange(clampQuantity(quantity + 1))}
      >
        +
      </button>
    </div>
  )
}

const DISCLAIMER = 'Неофициален помощник за координация. Не изпраща поръчка до ресторанта.'

function FacebookLink() {
  return (
    <a className="primary-link" href={FACEBOOK_PAGE_URL} target="_blank" rel="noreferrer">
      Виж Facebook страницата <span aria-hidden="true">↗</span>
    </a>
  )
}

function ClosedCutlery() {
  return (
    <svg className="plate-art" viewBox="0 0 64 64" role="presentation" focusable="false">
      <g className="art-fork" transform="translate(-7 0) rotate(-22 32 32)">
        <path d="M24 9v13M32 9v13M40 9v13" />
        <path d="M24 22c0 5.5 3.5 8 8 8s8-2.5 8-8" />
        <path d="M32 30v26" />
      </g>
      <g className="art-knife" transform="translate(7 0) rotate(22 32 32)">
        <path className="blade" d="M31 8c8 6 8 20 0 24z" />
        <path d="M31 32v24" />
      </g>
    </svg>
  )
}

function ClosedDay() {
  const today = sofiaDate()
  return (
    <main className="unavailable-shell unavailable-shell--closed">
      <section className="unavailable-card" aria-labelledby="closed-title">
        <span className="eyebrow">{formatBulgarianDate(today)}</span>
        <div className="empty-plate empty-plate--closed" aria-hidden="true"><ClosedCutlery /></div>
        <h1 id="closed-title">Днес ресторантът почива</h1>
        <p>
          В събота и неделя Mandarin House не предлага обедно меню, затова днес няма какво да покажем.
        </p>
        <div className="card-note">
          <span aria-hidden="true">→</span>
          Следващо меню: <strong>{formatBulgarianDate(nextWorkingSofiaDate(today))}</strong>
        </div>
        <FacebookLink />
        <small>{DISCLAIMER}</small>
      </section>
    </main>
  )
}

function OverdueClock() {
  return (
    <svg className="plate-art" viewBox="0 0 64 64" role="presentation" focusable="false">
      <g className="art-clock">
        <circle cx="32" cy="32" r="21" />
        <path d="M32 13v3M51 32h-3M32 51v-3M13 32h3" />
        <path d="M32 32V19" />
        <path d="M32 32l-7-5" />
      </g>
    </svg>
  )
}

function MissingMenu() {
  const today = sofiaDate()
  return (
    <main className="unavailable-shell unavailable-shell--missing">
      <section className="unavailable-card" aria-labelledby="missing-title">
        <span className="eyebrow">Меню за {formatBulgarianDate(today)}</span>
        <div className="empty-plate empty-plate--missing" aria-hidden="true"><OverdueClock /></div>
        <h1 id="missing-title">Все още няма меню за днес</h1>
        <p>
          Ресторантът може да е затворен или още да не е публикувал днешното меню.
          Провери Facebook страницата за най-новата информация.
        </p>
        <div className="card-note card-note--alert">
          <span aria-hidden="true">!</span>
          Обикновено менюто се публикува около <strong>08:30</strong>.
        </div>
        <FacebookLink />
        <small>{DISCLAIMER}</small>
      </section>
    </main>
  )
}

function PendingMenu() {
  const today = sofiaDate()
  return (
    <main className="unavailable-shell">
      <section className="unavailable-card" aria-labelledby="unavailable-title">
        <span className="eyebrow">Меню за {formatBulgarianDate(today)}</span>
        <div className="empty-plate" aria-hidden="true"><span>?</span></div>
        <h1 id="unavailable-title">Днешното меню все още не е налично</h1>
        <p>
          Проверяваме страницата на ресторанта. Няма да покажем старо меню като днешно.
        </p>
        <FacebookLink />
        <small>{DISCLAIMER}</small>
      </section>
    </main>
  )
}

function UnavailableMenu() {
  if (isSofiaWeekend(sofiaDate())) return <ClosedDay />
  return isMenuOverdue() ? <MissingMenu /> : <PendingMenu />
}

export function MenuApp({ menu }: { menu: Menu }) {
  // Reconcile the saved draft again if a corrected publication replaces this menu.
  return <MenuContent key={JSON.stringify([menu.date, menu.categories])} menu={menu} />
}

function MenuContent({ menu }: { menu: Menu }) {
  const [initialDraft] = useState(() => loadDraft(menu))
  const [initialName] = useState(() => loadNamePreference())
  const [quantities, setQuantities] = useState<Quantities>(initialDraft.draft?.quantities ?? {})
  const [participantName, setParticipantName] = useState(initialDraft.draft?.participantName ?? initialName.participantName)
  const [rememberName, setRememberName] = useState(initialName.remember)
  const [nameStorageAvailable, setNameStorageAvailable] = useState(initialName.available)
  const [favoritePreference, setFavoritePreference] = useState(() => loadFavorites())
  const [note, setNote] = useState(initialDraft.draft?.note ?? '')
  const [storageAvailable, setStorageAvailable] = useState(initialDraft.available)
  const [draftAdjusted, setDraftAdjusted] = useState(initialDraft.adjusted)
  const [basketOpen, setBasketOpen] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [nameError, setNameError] = useState(false)
  const [manualCopy, setManualCopy] = useState<{ text: string; view: 'desktop' | 'mobile' } | null>(null)
  const [sharing, setSharing] = useState(false)
  const copyAttempt = useRef(0)
  const mobileDialog = useRef<HTMLDialogElement>(null)
  const [search, setSearch] = useState('')
  const [clearedDraft, setClearedDraft] = useState<{
    quantities: Quantities
    participantName: string
    note: string
  } | null>(null)

  const orderLines = useMemo(() => createOrderLines(menu, quantities), [menu, quantities])
  const itemCount = orderLines.reduce((sum, line) => sum + line.quantity, 0)
  const totalCents = orderLines.reduce((sum, line) => sum + line.lineTotalCents, 0)
  const filteredCategories = useMemo(() => {
    const terms = search.trim().toLocaleLowerCase('bg-BG').split(/\s+/).filter(Boolean)
    return menu.categories.map((category, index) => ({
      ...category,
      position: index + 1,
      items: category.items.filter((item) => terms.every((term) => item.name.toLocaleLowerCase('bg-BG').includes(term))),
    })).filter((category) => category.items.length > 0)
  }, [menu, search])

  useEffect(() => {
    setStorageAvailable(saveDraft({ date: menu.date, quantities, participantName, note }, menu))
  }, [menu, note, participantName, quantities])

  useEffect(() => {
    setNameStorageAvailable(saveNamePreference(participantName, rememberName))
  }, [participantName, rememberName])

  useEffect(() => {
    function syncFavorites(event: StorageEvent) {
      if (event.key === FAVORITES_KEY || event.key === null) setFavoritePreference(loadFavorites())
    }
    window.addEventListener('storage', syncFavorites)
    return () => window.removeEventListener('storage', syncFavorites)
  }, [])

  function toggleFavorite(name: string) {
    const key = favoriteNameKey(name)
    // Merge with the latest saved list when another tab has changed it. If a
    // previous write failed, keep this page's unsaved favorites in memory.
    const latest = loadFavorites()
    const favorites = new Set(favoritePreference.available && latest.available
      ? latest.favorites : favoritePreference.favorites)
    if (favoritePreference.favorites.has(key)) favorites.delete(key)
    else favorites.add(key)
    setFavoritePreference({ favorites, available: saveFavorites(favorites) })
  }

  useEffect(() => {
    if (!basketOpen) return
    const dialog = mobileDialog.current!
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const desktop = window.matchMedia('(min-width: 901px)')
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.showModal()
    document.getElementById('mobile-basket-title')?.focus()
    function closeOnDesktop() {
      if (desktop.matches) setBasketOpen(false)
    }
    desktop.addEventListener('change', closeOnDesktop)
    closeOnDesktop()
    return () => {
      desktop.removeEventListener('change', closeOnDesktop)
      dialog.close()
      document.body.style.overflow = previousOverflow
      if (desktop.matches) document.getElementById('desktop-basket-title')?.focus()
      else opener?.focus()
    }
  }, [basketOpen])

  useEffect(() => {
    // Removing a focused line or Clear/Undo button must not strand keyboard focus.
    if (basketOpen && !mobileDialog.current?.contains(document.activeElement)) {
      document.getElementById('mobile-basket-title')?.focus()
    }
  }, [basketOpen, quantities])

  useEffect(() => {
    if (!manualCopy) return
    const field = document.getElementById(`${manualCopy.view}-copy-summary`) as HTMLTextAreaElement | null
    field?.focus()
    field?.select()
  }, [manualCopy])

  function clearCopyFeedback() {
    copyAttempt.current += 1
    setNotice(null)
    setManualCopy(null)
  }

  function setQuantity(itemId: string, quantity: number) {
    clearCopyFeedback()
    setDraftAdjusted(false)
    setClearedDraft(null)
    setQuantities((current) => {
      if (quantity === 0) {
        const next = { ...current }
        delete next[itemId]
        return next
      }
      return { ...current, [itemId]: quantity }
    })
  }

  function resetOrder() {
    setClearedDraft({ quantities, participantName, note })
    setQuantities({})
    if (!rememberName) setParticipantName('')
    setNote('')
    clearCopyFeedback()
    setDraftAdjusted(false)
    setNameError(false)
    setStorageAvailable(clearDraft())
  }

  function restoreOrder() {
    if (!clearedDraft) return
    setQuantities(clearedDraft.quantities)
    setParticipantName(clearedDraft.participantName)
    setNote(clearedDraft.note)
    setNameError(false)
    clearCopyFeedback()
    setDraftAdjusted(false)
    setClearedDraft(null)
  }

  async function copyText(text: string, container: HTMLElement) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // A modal makes elements outside it inert, so keep the fallback inside the active basket.
    container.append(textarea)
    try {
      textarea.focus()
      textarea.select()
      if (!document.execCommand?.('copy')) throw new Error('Copy was not completed')
    } finally {
      textarea.remove()
      previousFocus?.focus()
    }
  }

  function orderText(view: 'desktop' | 'mobile'): string | null {
    const nameInput = document.getElementById(`${view}-participant-name`)!
    const cleanName = participantName.trim()
    if (!cleanName) {
      setNameError(true)
      setNotice({ kind: 'error', text: 'Добави име, за да се знае чий е изборът.' })
      nameInput.focus()
      return null
    }
    setNameError(false)
    if (orderLines.length === 0) {
      setNotice({ kind: 'error', text: 'Избери поне едно ястие.' })
      return null
    }
    return summaryToText(createOrderSummary(menu, quantities, cleanName, note))
  }

  async function copyOrder(view: 'desktop' | 'mobile') {
    const attempt = ++copyAttempt.current
    setManualCopy(null)
    setNotice(null)
    const text = orderText(view)
    if (text === null) return
    const nameInput = document.getElementById(`${view}-participant-name`)!
    try {
      await copyText(text, nameInput.closest('.basket-content') as HTMLElement)
      if (attempt !== copyAttempt.current) return
      setNotice({ kind: 'success', text: 'Обобщението е копирано.' })
    } catch {
      if (attempt !== copyAttempt.current) return
      setManualCopy({ text, view })
      setNotice({ kind: 'error', text: 'Автоматичното копиране не успя. Копирай обобщението ръчно.' })
    }
  }

  async function shareOrder(view: 'desktop' | 'mobile') {
    if (sharing) return
    const attempt = ++copyAttempt.current
    setManualCopy(null)
    setNotice(null)
    const text = orderText(view)
    if (text === null) return
    setSharing(true)
    try {
      // Call directly from the click so the browser retains user activation.
      await navigator.share({ title: `Обяд за ${menu.date}`, text })
      if (attempt === copyAttempt.current) {
        setNotice({ kind: 'success', text: 'Обобщението е предадено за споделяне.' })
      }
    } catch (error) {
      if (attempt !== copyAttempt.current || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')) return
      setNotice({ kind: 'error', text: 'Споделянето не успя. Използвай „Копирай избора“.' })
    } finally {
      setSharing(false)
    }
  }

  function renderBasket(view: 'desktop' | 'mobile') {
    const nameInputId = `${view}-participant-name`
    const noteInputId = `${view}-order-note`
    const nameErrorId = `${view}-name-error`
    return (
      <div className="basket-content">
        <div className="basket-heading">
          <div>
            <span className="eyebrow">Твоят избор</span>
            <h2 id={`${view}-basket-title`} tabIndex={-1}>Обядът ти</h2>
          </div>
          {itemCount > 0 && (
            <button className="text-button" type="button" onClick={resetOrder}>Изчисти</button>
          )}
        </div>

        {clearedDraft && (
          <div className="basket-undo" role="status">
            <span>Изборът е изчистен.</span>
            <button className="text-button" type="button" onClick={restoreOrder}>Върни избора</button>
          </div>
        )}

        {draftAdjusted && <p className="notice notice--warning" role="status">Менюто или запазеният избор е променен. Провери ястията и сумата.</p>}
        {(!storageAvailable || !nameStorageAvailable) && <p className="notice notice--warning" role="status">Браузърът не позволява запазване на промените. Копирай избора, преди да затвориш страницата.</p>}

        {orderLines.length === 0 ? (
          <div className="basket-empty">
            <span aria-hidden="true">＋</span>
            <p>Добави нещо вкусно от менюто.</p>
          </div>
        ) : (
          <ul className="basket-lines" aria-label="Избрани ястия">
            {orderLines.map((line) => (
              <li key={line.itemId}>
                <div className="basket-line-copy">
                  <strong>{line.name}</strong>
                  <small>{line.portion ? `${line.portion} · ` : ''}{formatEuro(line.unitPriceCents)} за порция</small>
                </div>
                <span className="basket-line-total">{formatEuro(line.lineTotalCents)}</span>
                <div className="basket-line-actions">
                  <QuantityControl item={line} quantity={line.quantity} onChange={(value) => setQuantity(line.itemId, value)} inBasket />
                  <button className="text-button" type="button" aria-label={`Премахни ${line.name} от избора`} onClick={() => setQuantity(line.itemId, 0)}>
                    Премахни
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="basket-total">
          <span>Общо</span>
          <strong>{formatEuro(totalCents)}</strong>
        </div>

        <div className="basket-form">
          <label htmlFor={nameInputId}>Твоето име <span aria-hidden="true">*</span></label>
          <input
            id={nameInputId}
            name="participantName"
            value={participantName}
            aria-invalid={nameError}
            aria-describedby={nameError ? nameErrorId : undefined}
            autoComplete="name"
            placeholder="Напр. Иван"
            onChange={(event) => {
              clearCopyFeedback()
              setClearedDraft(null)
              setParticipantName(event.target.value)
              if (event.target.value.trim()) setNameError(false)
            }}
          />
          {nameError && <small id={nameErrorId} className="field-error">Името е задължително.</small>}
          <label className="remember-name">
            <input type="checkbox" checked={rememberName} aria-describedby={`${view}-remember-note`} onChange={(event) => setRememberName(event.target.checked)} />
            Запомни името ми
          </label>
          <small id={`${view}-remember-note`} className="remember-name-note">За следващите дни в този браузър.</small>
          <label htmlFor={noteInputId}>Бележка <span>(по желание)</span></label>
          <textarea
            id={noteInputId}
            name="orderNote"
            value={note}
            maxLength={240}
            placeholder="Напр. без люто"
            onChange={(event) => {
              clearCopyFeedback()
              setClearedDraft(null)
              setNote(event.target.value)
            }}
          />
        </div>

        {notice && <p className={`notice notice--${notice.kind}`} role="status">{notice.text}</p>}
        {manualCopy && (
          <div className="manual-copy">
            <label htmlFor={`${view}-copy-summary`}>Обобщение за ръчно копиране</label>
            <textarea id={`${view}-copy-summary`} value={manualCopy.text} readOnly rows={6} onFocus={(event) => event.currentTarget.select()} />
            <button className="text-button" type="button" onClick={() => {
              const field = document.getElementById(`${view}-copy-summary`) as HTMLTextAreaElement
              field.focus()
              field.select()
            }}>Избери целия текст</button>
          </div>
        )}
        <button className="share-button" type="button" onClick={() => copyOrder(view)}>
          <span>Копирай избора</span><span aria-hidden="true">⧉</span>
        </button>
        {typeof navigator.share === 'function' && (
          <button className="native-share-button" type="button" disabled={sharing} onClick={() => shareOrder(view)}>
            <span>{sharing ? 'Отваряне…' : 'Сподели избора'}</span><span aria-hidden="true">↗</span>
          </button>
        )}
        <p className="privacy-note">Нищо не се изпраща автоматично и не се съхранява онлайн.</p>
      </div>
    )
  }

  return (
    <>
      <header className="hero">
        <nav className="topbar" aria-label="Основна навигация">
          <a className="wordmark" href="#top" aria-label="Mandarin House — начало">
            <span>Mandarin</span><small>lunch picker</small>
          </a>
          <a className="source-link" href={menu.source.postUrl} target="_blank" rel="noreferrer">
            Оригиналът във Facebook <span aria-hidden="true">↗</span>
          </a>
        </nav>
        <aside className="important-banner" aria-labelledby="important-title">
          <span aria-hidden="true">!</span>
          <div>
            <strong id="important-title">Важно</strong>
            <p>Това е неофициален помощник за избор. Не представлява поръчка към Mandarin House.</p>
          </div>
        </aside>
        <div className="hero-grid" id="top">
          <div className="hero-copy">
            <span className="eyebrow eyebrow--light">Обедно меню · {formatBulgarianDate(menu.date)}</span>
            <h1>Какво ще<br />хапваш <em>днес?</em></h1>
            <p>Избери ястията си, виж точната сума и копирай готовото обобщение.</p>
          </div>
          <div className="hero-plate" aria-hidden="true">
            <span className="plate-leaf plate-leaf--one" />
            <span className="plate-leaf plate-leaf--two" />
            <span className="plate-center">М</span>
          </div>
        </div>
        <div className="hero-wave" aria-hidden="true" />
      </header>

      <main className="page-shell">
        <section className="menu-area" aria-labelledby="menu-title">
          <div className="section-intro">
            <div>
              <span className="eyebrow">Прясно приготвено</span>
              <h2 id="menu-title">Днешното меню</h2>
            </div>
            <p>Цените и грамажите са преписани от днешната публикация.</p>
          </div>

          <div className="menu-search" role="search" aria-label="Търсене в менюто">
            <label className="sr-only" htmlFor="menu-search">Търси ястие</label>
            <svg className="search-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" />
            </svg>
            <input
              id="menu-search"
              type="search"
              value={search}
              placeholder="Търси ястие…"
              onChange={(event) => setSearch(event.target.value)}
            />
            {search !== '' && (
              <button className="search-clear" type="button" aria-label="Изчисти търсенето" onClick={() => {
                setSearch('')
                document.getElementById('menu-search')?.focus()
              }}>×</button>
            )}
          </div>

          {!favoritePreference.available && (
            <p className="notice notice--warning" role="status">Любимите ястия не могат да се запазят в този браузър. Ще останат отбелязани само докато страницата е отворена.</p>
          )}

          {filteredCategories.length > 0 ? (
            <nav className="category-nav" aria-label="Категории от менюто">
              {filteredCategories.map((category) => (
                <a key={category.id} href={`#${category.id}`}>{category.name}</a>
              ))}
            </nav>
          ) : (
            <div className="menu-empty">
              <h3>Няма намерени ястия</h3>
              <p>Пробвай друго име или изчисти търсенето, за да видиш менюто.</p>
            </div>
          )}

          {filteredCategories.map((category) => (
            <section className="category-section" id={category.id} key={category.id}>
              <div className="category-title">
                <span>{String(category.position).padStart(2, '0')}</span>
                <h3>{category.name}</h3>
                <div />
              </div>
              <div className="menu-list">
                {category.items.map((item) => {
                  const quantity = quantities[item.id] ?? 0
                  const favorite = favoritePreference.favorites.has(favoriteNameKey(item.name))
                  return (
                    <article className={`menu-item ${favorite ? 'menu-item--favorite' : ''} ${quantity > 0 ? 'menu-item--selected' : ''}`} key={item.id}>
                      <div className="item-copy">
                        <div className="item-heading">
                          <h4>{item.name}</h4>
                          <button
                            className="favorite-button"
                            type="button"
                            aria-label={`Любимо ястие: ${item.name}`}
                            aria-pressed={favorite}
                            title={favorite ? 'Премахни от любимите' : 'Добави в любимите'}
                            onClick={() => toggleFavorite(item.name)}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />
                            </svg>
                          </button>
                        </div>
                        {(item.portion || favorite) && <p className="item-meta">
                          {item.portion && <span>{item.portion}</span>}
                          {favorite && <span className="favorite-label">Любимо</span>}
                        </p>}
                      </div>
                      <strong className="item-price">{formatEuro(item.priceCents)}</strong>
                      <QuantityControl item={item} quantity={quantity} onChange={(value) => setQuantity(item.id, value)} />
                    </article>
                  )
                })}
              </div>
            </section>
          ))}

        </section>

        <aside className="basket-panel" aria-label="Обобщение на избора">{renderBasket('desktop')}</aside>
      </main>

      <button
        className="mobile-basket-button"
        type="button"
        aria-expanded={basketOpen}
        aria-controls="mobile-basket"
        aria-haspopup="dialog"
        onClick={() => setBasketOpen(true)}
      >
        <span><b>{itemCount}</b> {itemCount === 1 ? 'избор' : 'избора'}</span>
        <strong>{formatEuro(totalCents)}</strong>
        <span aria-hidden="true">{basketOpen ? '↓' : '↑'}</span>
      </button>
      <dialog
        ref={mobileDialog}
        id="mobile-basket"
        className="mobile-basket"
        aria-labelledby="mobile-basket-title"
        aria-modal="true"
        onCancel={(event) => { event.preventDefault(); setBasketOpen(false) }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return
          const bounds = event.currentTarget.getBoundingClientRect()
          if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) setBasketOpen(false)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]')
          const first = controls[0]
          const last = controls[controls.length - 1]
          if (event.shiftKey && (document.activeElement === first || document.activeElement?.id === 'mobile-basket-title')) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }}
      >
        {basketOpen && <>
          <button className="mobile-basket-close" type="button" onClick={() => setBasketOpen(false)} aria-label="Затвори избора">×</button>
          {renderBasket('mobile')}
        </>}
      </dialog>

      <footer>
        <span>Mandarin lunch picker</span>
        <p>Без плащания · без профили · без съхранени поръчки</p>
        <a href={FACEBOOK_PAGE_URL} target="_blank" rel="noreferrer">Facebook ↗</a>
      </footer>
    </>
  )
}

export function App() {
  const result = menuPublicationSchema.safeParse(currentPublicationData)
  if (!result.success || result.data.status !== 'ready' || !isTodayInSofia(result.data.menu.date)) {
    return <UnavailableMenu />
  }
  return <MenuApp menu={result.data.menu} />
}
