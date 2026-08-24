import { useEffect, useMemo, useState } from 'react'
import currentPublicationData from '../data/current-menu.json'
import { formatBulgarianDate, isTodayInSofia, sofiaDate } from './lib/date.ts'
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
import { clearDraft, loadDraft, saveDraft } from './lib/storage.ts'

type Notice = { kind: 'success' | 'error'; text: string } | null

function QuantityControl({
  item,
  quantity,
  onChange,
}: {
  item: MenuItem
  quantity: number
  onChange: (quantity: number) => void
}) {
  return (
    <div className="quantity-control" aria-label={`Количество за ${item.name}`}>
      <button
        className="quantity-button"
        type="button"
        aria-label={`Намали ${item.name}`}
        disabled={quantity === 0}
        onClick={() => onChange(clampQuantity(quantity - 1))}
      >
        −
      </button>
      <output aria-live="polite" aria-label={`Избрано количество: ${quantity}`}>
        {quantity}
      </output>
      <button
        className="quantity-button quantity-button--add"
        type="button"
        aria-label={`Добави ${item.name}`}
        disabled={quantity >= 20}
        onClick={() => onChange(clampQuantity(quantity + 1))}
      >
        +
      </button>
    </div>
  )
}

function UnavailableMenu() {
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
        <a className="primary-link" href={FACEBOOK_PAGE_URL} target="_blank" rel="noreferrer">
          Виж Facebook страницата <span aria-hidden="true">↗</span>
        </a>
        <small>Неофициален помощник за координация. Не изпраща поръчка до ресторанта.</small>
      </section>
    </main>
  )
}

export function MenuApp({ menu }: { menu: Menu }) {
  const initialDraft = useMemo(() => loadDraft(menu.date), [menu.date])
  const [quantities, setQuantities] = useState<Quantities>(initialDraft?.quantities ?? {})
  const [participantName, setParticipantName] = useState(initialDraft?.participantName ?? '')
  const [note, setNote] = useState(initialDraft?.note ?? '')
  const [basketOpen, setBasketOpen] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [nameError, setNameError] = useState(false)

  const orderLines = useMemo(() => createOrderLines(menu, quantities), [menu, quantities])
  const itemCount = orderLines.reduce((sum, line) => sum + line.quantity, 0)
  const totalCents = orderLines.reduce((sum, line) => sum + line.lineTotalCents, 0)

  useEffect(() => {
    saveDraft({ date: menu.date, quantities, participantName, note })
  }, [menu.date, note, participantName, quantities])

  function setQuantity(itemId: string, quantity: number) {
    setNotice(null)
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
    setQuantities({})
    setParticipantName('')
    setNote('')
    setNotice(null)
    setNameError(false)
    clearDraft()
  }

  async function copyText(text: string) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.append(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }

  async function copyOrder() {
    const cleanName = participantName.trim()
    if (!cleanName) {
      setNameError(true)
      setNotice({ kind: 'error', text: 'Добави име, за да се знае чий е изборът.' })
      document.getElementById('participant-name')?.focus()
      return
    }
    if (orderLines.length === 0) {
      setNotice({ kind: 'error', text: 'Избери поне едно ястие.' })
      return
    }

    setNameError(false)
    const summary = createOrderSummary(menu, quantities, cleanName, note)
    const text = summaryToText(summary)
    try {
      await copyText(text)
      setNotice({ kind: 'success', text: 'Обобщението е копирано.' })
    } catch {
      setNotice({ kind: 'error', text: 'Не успяхме да копираме. Опитай отново.' })
    }
  }

  const basket = (
    <div className="basket-content">
      <div className="basket-heading">
        <div>
          <span className="eyebrow">Твоят избор</span>
          <h2>Обядът ти</h2>
        </div>
        {itemCount > 0 && (
          <button className="text-button" type="button" onClick={resetOrder}>Изчисти</button>
        )}
      </div>

      {orderLines.length === 0 ? (
        <div className="basket-empty">
          <span aria-hidden="true">＋</span>
          <p>Добави нещо вкусно от менюто.</p>
        </div>
      ) : (
        <ul className="basket-lines" aria-label="Избрани ястия">
          {orderLines.map((line) => (
            <li key={line.itemId}>
              <div>
                <strong>{line.quantity} × {line.name}</strong>
                {line.portion && <small>{line.portion}</small>}
              </div>
              <span>{formatEuro(line.lineTotalCents)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="basket-total">
        <span>Общо</span>
        <strong>{formatEuro(totalCents)}</strong>
      </div>

      <div className="basket-form">
        <label htmlFor="participant-name">Твоето име <span aria-hidden="true">*</span></label>
        <input
          id="participant-name"
          name="participantName"
          value={participantName}
          aria-invalid={nameError}
          aria-describedby={nameError ? 'name-error' : undefined}
          autoComplete="name"
          placeholder="Напр. Иван"
          onChange={(event) => {
            setParticipantName(event.target.value)
            if (event.target.value.trim()) setNameError(false)
          }}
        />
        {nameError && <small id="name-error" className="field-error">Името е задължително.</small>}
        <label htmlFor="order-note">Бележка <span>(по желание)</span></label>
        <textarea
          id="order-note"
          name="orderNote"
          value={note}
          maxLength={240}
          placeholder="Напр. без люто"
          onChange={(event) => setNote(event.target.value)}
        />
      </div>

      {notice && <p className={`notice notice--${notice.kind}`} role="status">{notice.text}</p>}
      <button className="share-button" type="button" onClick={copyOrder}>
        <span>Копирай избора</span><span aria-hidden="true">⧉</span>
      </button>
      <p className="privacy-note">Нищо не се изпраща автоматично и не се съхранява онлайн.</p>
    </div>
  )

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

          <nav className="category-nav" aria-label="Категории от менюто">
            {menu.categories.map((category) => (
              <a key={category.id} href={`#${category.id}`}>{category.name}</a>
            ))}
          </nav>

          {menu.categories.map((category, categoryIndex) => (
            <section className="category-section" id={category.id} key={category.id}>
              <div className="category-title">
                <span>{String(categoryIndex + 1).padStart(2, '0')}</span>
                <h3>{category.name}</h3>
                <div />
              </div>
              <div className="menu-list">
                {category.items.map((item) => {
                  const quantity = quantities[item.id] ?? 0
                  return (
                    <article className={`menu-item ${quantity > 0 ? 'menu-item--selected' : ''}`} key={item.id}>
                      <div className="item-copy">
                        <h4>{item.name}</h4>
                        {item.portion && <p>{item.portion}</p>}
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

        <aside className="basket-panel" aria-label="Обобщение на избора">{basket}</aside>
      </main>

      <button
        className="mobile-basket-button"
        type="button"
        aria-expanded={basketOpen}
        aria-controls="mobile-basket"
        onClick={() => setBasketOpen((open) => !open)}
      >
        <span><b>{itemCount}</b> {itemCount === 1 ? 'избор' : 'избора'}</span>
        <strong>{formatEuro(totalCents)}</strong>
        <span aria-hidden="true">{basketOpen ? '↓' : '↑'}</span>
      </button>
      <aside
        id="mobile-basket"
        className={`mobile-basket ${basketOpen ? 'mobile-basket--open' : ''}`}
        aria-label="Обобщение на избора"
      >
        <button className="mobile-basket-close" type="button" onClick={() => setBasketOpen(false)} aria-label="Затвори избора">×</button>
        {basket}
      </aside>
      {basketOpen && <button className="basket-backdrop" type="button" aria-label="Затвори избора" onClick={() => setBasketOpen(false)} />}

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
