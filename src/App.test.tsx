import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import currentPublicationData from '../data/current-menu.json'
import { nextWorkingSofiaDate } from './lib/date.ts'
import { menuFixture } from './test/menu-fixture.ts'
import { App, MenuApp } from './App.tsx'

function installClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  return writeText
}

function mobileViewport() {
  const media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(media))
  return media
}

beforeEach(() => mobileViewport())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('interactive menu', () => {
  it('fails closed on a working day when the embedded publication date is not today in Sofia', () => {
    if (currentPublicationData.status !== 'ready') throw new Error('Expected a ready test publication')
    const [year, month, day] = nextWorkingSofiaDate(currentPublicationData.menu.date).split('-').map(Number)
    vi.useFakeTimers()
    // 06:00Z is a Sofia morning on that date, so this asserts the pending screen
    // rather than the overdue one.
    vi.setSystemTime(new Date(Date.UTC(year, month - 1, day, 6)))

    render(<App />)

    expect(screen.getByRole('heading', { name: 'Днешното меню все още не е налично' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Добави/ })).not.toBeInTheDocument()
  })

  it.each([
    ['събота', '2026-09-05', 'понеделник, 7 септември 2026 г.'],
    ['неделя', '2026-09-06', 'понеделник, 7 септември 2026 г.'],
  ])('explains the weekend closure instead of a pending import on %s', (_weekday, date, nextService) => {
    const [year, month, day] = date.split('-').map(Number)
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.UTC(year, month - 1, day, 12)))

    render(<App />)

    expect(screen.getByRole('heading', { name: 'Днес ресторантът почива' })).toBeInTheDocument()
    expect(screen.getByText(/не предлага обедно меню/)).toBeInTheDocument()
    expect(screen.getByText(nextService)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Днешното меню все още не е налично' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Добави/ })).not.toBeInTheDocument()
  })

  it('waits quietly before the cutoff and names the Facebook page after it', () => {
    // 2026-09-14 is the Monday the restaurant reopens; 07:00Z is 10:00 Sofia.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-14T07:00:00Z'))
    const early = render(<App />)

    expect(screen.getByRole('heading', { name: 'Днешното меню все още не е налично' })).toBeInTheDocument()
    early.unmount()

    vi.setSystemTime(new Date('2026-09-14T08:00:00Z'))
    render(<App />)

    expect(screen.getByRole('heading', { name: 'Все още няма меню за днес' })).toBeInTheDocument()
    expect(screen.getByText(/може да е затворен или още да не е публикувал/)).toBeInTheDocument()
    expect(screen.getByText('08:30')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Виж Facebook страницата/ })).toHaveAttribute(
      'href',
      'https://www.facebook.com/profile.php?id=100063668642218',
    )
    expect(screen.queryByRole('button', { name: /Добави/ })).not.toBeInTheDocument()
  })

  it('keeps the weekend closure ahead of the overdue cutoff', () => {
    // Saturday 2026-09-12 at 15:00 Sofia is past the cutoff but still a rest day.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-12T12:00:00Z'))

    render(<App />)

    expect(screen.getByRole('heading', { name: 'Днес ресторантът почива' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Все още няма меню за днес' })).not.toBeInTheDocument()
  })

  it('renders menu categories, exact prices, the source link, and the informational disclaimer', () => {
    render(<MenuApp menu={menuFixture} />)

    expect(screen.getByRole('heading', { name: 'Днешното меню' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Супи' })).toHaveAttribute('href', '#soups')
    expect(screen.getByText('Пилешка супа')).toBeInTheDocument()
    expect(screen.getAllByText(/2,70\s*€/).length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: /Оригиналът във Facebook/ })).toHaveAttribute(
      'href',
      menuFixture.source.postUrl,
    )
    expect(screen.getByText(/Не представлява поръчка към Mandarin House/)).toBeInTheDocument()
  })

  it('updates quantities and totals using integer cents', async () => {
    const user = userEvent.setup()
    render(<MenuApp menu={menuFixture} />)

    await user.click(screen.getByRole('button', { name: 'Добави Пилешка супа' }))
    await user.click(screen.getByRole('button', { name: 'Добави Пилешка супа' }))
    await user.click(screen.getByRole('button', { name: 'Добави Пилешко филе' }))

    expect(screen.getByLabelText('Избрано количество: 2')).toHaveTextContent('2')
    expect(screen.getAllByText(/10,50\s*€/).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: 'Намали Пилешка супа' }))
    expect(screen.getAllByText(/7,80\s*€/).length).toBeGreaterThan(0)
  })

  it('stops incrementing at the twenty-item limit', async () => {
    const user = userEvent.setup()
    render(<MenuApp menu={menuFixture} />)
    const add = screen.getByRole('button', { name: 'Добави Пилешка супа' })

    for (let index = 0; index < 20; index += 1) await user.click(add)

    expect(add).toBeDisabled()
    expect(screen.getByLabelText('Избрано количество: 20')).toHaveTextContent('20')
    expect(screen.getAllByText(/54,00\s*€/).length).toBeGreaterThan(0)
  })

  it.each([0, 1])('edits and removes basket lines in basket view %i, updating the menu, totals, copy, and saved draft', async (view) => {
    const user = userEvent.setup()
    const writeText = installClipboard()
    render(<MenuApp menu={menuFixture} />)
    await user.click(screen.getByRole('button', { name: 'Добави Пилешка супа' }))
    await user.click(screen.getByRole('button', { name: 'Добави Пилешко филе' }))
    if (view === 1) await user.click(screen.getByRole('button', { name: /2 избора/ }))
    const basket = within(view === 0
      ? screen.getByRole('complementary', { name: 'Обобщение на избора' })
      : screen.getByRole('dialog', { name: 'Обядът ти' }))

    await user.click(basket.getByRole('button', { name: 'Добави Пилешка супа в избора' }))
    expect(screen.getByLabelText('Избрано количество: 2')).toHaveTextContent('2')
    expect(basket.getByText(/10,50\s*€/)).toBeInTheDocument()
    await user.click(basket.getByRole('button', { name: 'Намали Пилешка супа в избора' }))
    expect(within(screen.getByLabelText('Количество за Пилешка супа')).getByLabelText('Избрано количество: 1')).toHaveTextContent('1')
    await user.click(basket.getByRole('button', { name: 'Премахни Пилешко филе от избора' }))
    expect(basket.queryByText('Пилешко филе')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Намали Пилешко филе' })).toBeDisabled()

    await user.click(basket.getByRole('button', { name: /Копирай избора/ }))
    expect(basket.getByLabelText(/Твоето име/)).toHaveFocus()
    await user.type(basket.getByLabelText(/Твоето име/), 'Мария')
    await user.click(basket.getByRole('button', { name: /Копирай избора/ }))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('1 × Пилешка супа'))
    expect(writeText.mock.calls[0][0]).not.toContain('Пилешко филе')
    await waitFor(() => expect(JSON.parse(localStorage.getItem('mandarin-order-draft-v1') ?? '{}').quantities).toEqual({ soup: 1 }))

    await user.click(basket.getByRole('button', { name: 'Намали Пилешка супа в избора' }))
    expect(basket.getByText('Добави нещо вкусно от менюто.')).toBeInTheDocument()
    expect(basket.getByText(/0,00\s*€/)).toBeInTheDocument()
    if (view === 1) expect(basket.getByRole('heading', { name: 'Обядът ти' })).toHaveFocus()
  })

  it('enforces the quantity limit when editing from the basket', async () => {
    localStorage.setItem('mandarin-order-draft-v1', JSON.stringify({ date: menuFixture.date, quantities: { soup: 19 } }))
    const user = userEvent.setup()
    render(<MenuApp menu={menuFixture} />)
    const basket = within(screen.getAllByRole('complementary', { name: 'Обобщение на избора' })[0])
    await user.click(basket.getByRole('button', { name: 'Добави Пилешка супа в избора' }))
    expect(basket.getByRole('button', { name: 'Добави Пилешка супа в избора' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Добави Пилешка супа' })).toBeDisabled()
    expect(basket.getAllByText(/54,00\s*€/)).toHaveLength(2)
  })

  it('restores quantities, name, and note after clearing, and expires undo after a new selection', async () => {
    const user = userEvent.setup()
    render(<MenuApp menu={menuFixture} />)
    const basket = within(screen.getAllByRole('complementary', { name: 'Обобщение на избора' })[0])
    await user.click(screen.getByRole('button', { name: 'Добави Пилешка супа' }))
    await user.type(basket.getByLabelText(/Твоето име/), 'Мария')
    await user.type(basket.getByLabelText(/Бележка/), 'Без хляб')
    await user.click(basket.getByRole('button', { name: 'Изчисти' }))
    expect(basket.getByLabelText(/Твоето име/)).toHaveValue('')
    await user.click(basket.getByRole('button', { name: 'Върни избора' }))
    expect(screen.getByLabelText('Избрано количество: 1')).toHaveTextContent('1')
    expect(basket.getByLabelText(/Твоето име/)).toHaveValue('Мария')
    expect(basket.getByLabelText(/Бележка/)).toHaveValue('Без хляб')
    await waitFor(() => expect(JSON.parse(localStorage.getItem('mandarin-order-draft-v1') ?? '{}')).toMatchObject({ quantities: { soup: 1 }, participantName: 'Мария', note: 'Без хляб' }))
    await user.click(basket.getByRole('button', { name: 'Изчисти' }))
    await user.click(screen.getByRole('button', { name: 'Добави Пилешко филе' }))
    expect(basket.queryByRole('button', { name: 'Върни избора' })).not.toBeInTheDocument()
  })

  it('searches Bulgarian names without case or word-order sensitivity and hides empty category links', async () => {
    const user = userEvent.setup()
    render(<MenuApp menu={menuFixture} />)
    const menu = within(screen.getByRole('region', { name: 'Днешното меню' }))
    await user.type(screen.getByRole('searchbox', { name: 'Търси ястие' }), '  СУПА   ПИЛЕШКА ')
    expect(menu.getByText('Пилешка супа')).toBeInTheDocument()
    expect(menu.queryByText('Пилешко филе')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Супи' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Основни' })).not.toBeInTheDocument()
    expect(menu.getByText(/Показани ястия:/)).toHaveTextContent('Показани ястия: 1 от 2')
    await user.click(screen.getByRole('button', { name: 'Изчисти филтрите' }))
    expect(menu.getByText('Пилешко филе')).toBeInTheDocument()
  })

  it('includes dishes exactly at the price limit and combines price, search, and selected-only filters', async () => {
    const filterMenu = structuredClone(menuFixture)
    filterMenu.categories[0].items.push({ id: 'vegetable-soup', name: 'Зеленчукова супа', priceCents: 300 })
    filterMenu.categories[1].items.push({ id: 'expensive-soup', name: 'Специална супа', priceCents: 301 })
    const user = userEvent.setup()
    render(<MenuApp menu={filterMenu} />)
    const menu = within(screen.getByRole('region', { name: 'Днешното меню' }))
    await user.click(screen.getByRole('button', { name: 'Добави Зеленчукова супа' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Максимална цена' }), '300')
    expect(menu.getByText('Зеленчукова супа')).toBeInTheDocument()
    expect(menu.queryByText('Специална супа')).not.toBeInTheDocument()
    await user.type(screen.getByRole('searchbox', { name: 'Търси ястие' }), 'супа')
    await user.click(screen.getByRole('checkbox', { name: 'Само избраните' }))
    expect(menu.getByText('Зеленчукова супа')).toBeInTheDocument()
    expect(menu.queryByText('Пилешка супа')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Намали Зеленчукова супа' }))
    expect(menu.getByRole('heading', { name: 'Още няма избрани ястия' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Изчисти филтрите' }))
    expect(screen.getByRole('searchbox', { name: 'Търси ястие' })).toHaveValue('')
    expect(screen.getByRole('combobox', { name: 'Максимална цена' })).toHaveValue('')
    expect(screen.getByRole('checkbox', { name: 'Само избраните' })).not.toBeChecked()
    expect(menu.getByText(/Показани ястия:/)).toHaveTextContent('Показани ястия: 4 от 4')
  })

  it('keeps hidden selections in the basket and copied summary, and immediately updates selected-only results after basket removal', async () => {
    const user = userEvent.setup()
    const writeText = installClipboard()
    render(<MenuApp menu={menuFixture} />)
    const menu = within(screen.getByRole('region', { name: 'Днешното меню' }))
    const basket = within(screen.getAllByRole('complementary', { name: 'Обобщение на избора' })[0])
    await user.click(screen.getByRole('button', { name: 'Добави Пилешко филе' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Максимална цена' }), '300')
    expect(menu.queryByText('Пилешко филе')).not.toBeInTheDocument()
    expect(basket.getByText('Пилешко филе')).toBeInTheDocument()
    await user.type(basket.getByLabelText(/Твоето име/), 'Мария')
    await user.click(basket.getByRole('button', { name: /Копирай избора/ }))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('1 × Пилешко филе'))
    await user.click(screen.getByRole('button', { name: 'Изчисти филтрите' }))
    await user.click(screen.getByRole('checkbox', { name: 'Само избраните' }))
    expect(menu.getByText('Пилешко филе')).toBeInTheDocument()
    await user.click(basket.getByRole('button', { name: 'Премахни Пилешко филе от избора' }))
    expect(menu.queryByText('Пилешко филе')).not.toBeInTheDocument()
    expect(menu.getByRole('heading', { name: 'Още няма избрани ястия' })).toBeInTheDocument()
    await user.type(screen.getByRole('searchbox', { name: 'Търси ястие' }), 'несъществуващо')
    await user.click(screen.getByRole('checkbox', { name: 'Само избраните' }))
    expect(menu.getByRole('heading', { name: 'Няма намерени ястия' })).toBeInTheDocument()
  })

  it('requires a name and copies the exact selection without opening Web Share', async () => {
    const user = userEvent.setup()
    const writeText = installClipboard()
    const share = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    render(<MenuApp menu={menuFixture} />)

    await user.click(screen.getByRole('button', { name: 'Добави Пилешка супа' }))
    const copyButtons = screen.getAllByRole('button', { name: /Копирай избора/ })
    await user.click(copyButtons[0])
    expect(screen.getAllByText('Името е задължително.').length).toBeGreaterThan(0)

    await user.type(screen.getAllByLabelText(/Твоето име/)[0], 'Мария')
    await user.click(copyButtons[0])

    expect(writeText).toHaveBeenCalledOnce()
    expect(share).not.toHaveBeenCalled()
    expect(writeText.mock.calls[0][0]).toContain('Обяд за 2026-08-24 — Мария')
    expect(writeText.mock.calls[0][0]).toContain('Общо:')
    expect(writeText.mock.calls[0][0]).not.toContain('Обяд — Мария')
    expect(writeText.mock.calls[0][0]).not.toContain('Източник:')
  })

  it('does not copy an empty selection even when a participant name is present', async () => {
    const user = userEvent.setup()
    const writeText = installClipboard()
    render(<MenuApp menu={menuFixture} />)

    await user.type(screen.getAllByLabelText(/Твоето име/)[0], 'Иван')
    await user.click(screen.getAllByRole('button', { name: /Копирай избора/ })[0])

    expect(writeText).not.toHaveBeenCalled()
    expect(screen.getAllByText('Избери поне едно ястие.').length).toBeGreaterThan(0)
  })

  it('includes the optional note and reports clipboard failures', async () => {
    const user = userEvent.setup()
    const writeText = installClipboard(vi.fn().mockRejectedValue(new Error('denied')))
    render(<MenuApp menu={menuFixture} />)

    await user.click(screen.getByRole('button', { name: 'Добави Пилешка супа' }))
    await user.type(screen.getAllByLabelText(/Твоето име/)[0], 'Мария')
    await user.type(screen.getAllByLabelText(/Бележка/)[0], 'Без хляб')
    await user.click(screen.getAllByRole('button', { name: /Копирай избора/ })[0])

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Бележка: Без хляб'))
    expect(screen.getByText('Автоматичното копиране не успя. Копирай обобщението ръчно.')).toBeInTheDocument()
    const manual = screen.getByRole('textbox', { name: 'Обобщение за ръчно копиране' }) as HTMLTextAreaElement
    expect(manual).toHaveValue(writeText.mock.calls[0][0])
    expect(manual).toHaveFocus()
    expect(manual.selectionStart).toBe(0)
    expect(manual.selectionEnd).toBe(manual.value.length)
    await user.click(screen.getByRole('button', { name: 'Избери целия текст' }))
    expect(manual).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Добави Пилешка супа' }))
    expect(screen.queryByRole('textbox', { name: 'Обобщение за ръчно копиране' })).not.toBeInTheDocument()
  })

  it('uses the local copy fallback when the Clipboard API is unavailable', async () => {
    const user = userEvent.setup()
    const execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    render(<MenuApp menu={menuFixture} />)

    await user.click(screen.getByRole('button', { name: 'Добави Пилешка супа' }))
    await user.type(screen.getAllByLabelText(/Твоето име/)[0], 'Иван')
    await user.click(screen.getAllByRole('button', { name: /Копирай избора/ })[0])

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(screen.getAllByText('Обобщението е копирано.').length).toBeGreaterThan(0)
    expect(document.querySelector('textarea[style*="opacity"]')).not.toBeInTheDocument()
  })

  it('restores the same-day basket locally and clears every field on reset', async () => {
    const user = userEvent.setup()
    const firstRender = render(<MenuApp menu={menuFixture} />)

    await user.click(screen.getByRole('button', { name: 'Добави Пилешка супа' }))
    await user.type(screen.getAllByLabelText(/Твоето име/)[0], 'Мария')
    await user.type(screen.getAllByLabelText(/Бележка/)[0], 'Без люто')
    await waitFor(() => expect(localStorage.length).toBe(1))
    firstRender.unmount()

    render(<MenuApp menu={menuFixture} />)
    expect(screen.getByLabelText('Избрано количество: 1')).toHaveTextContent('1')
    expect(screen.getAllByLabelText(/Твоето име/)[0]).toHaveValue('Мария')
    expect(screen.getAllByLabelText(/Бележка/)[0]).toHaveValue('Без люто')

    await user.click(screen.getAllByRole('button', { name: 'Изчисти' })[0])
    expect(screen.getAllByLabelText('Избрано количество: 0')).toHaveLength(2)
    expect(screen.getAllByLabelText(/Твоето име/)[0]).toHaveValue('')
    expect(screen.getAllByLabelText(/Бележка/)[0]).toHaveValue('')
    await waitFor(() => expect(localStorage.length).toBe(1))
    expect(JSON.parse(localStorage.getItem('mandarin-order-draft-v1') ?? '{}')).toMatchObject({
      quantities: {},
      participantName: '',
      note: '',
    })
  })

  it('opens the mobile dialog at its title, wraps Tab in both directions, validates the visible field, and restores focus on cancel', async () => {
    const user = userEvent.setup()
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    render(<MenuApp menu={menuFixture} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.getElementById('mobile-participant-name')).toBeNull()
    expect(screen.getAllByLabelText(/Твоето име/)).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Добави Пилешка супа' }))
    const opener = screen.getByRole('button', { name: /1 избор/ })
    await user.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'Обядът ти' })
    const basket = within(dialog)
    expect(showModal).toHaveBeenCalledOnce()
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(document.body.style.overflow).toBe('hidden')
    expect(basket.getByRole('heading', { name: 'Обядът ти' })).toHaveFocus()
    await user.tab()
    expect(basket.getByRole('button', { name: 'Изчисти' })).toHaveFocus()
    await user.tab({ shift: true })
    expect(basket.getByRole('button', { name: 'Затвори избора' })).toHaveFocus()
    expect(fireEvent.keyDown(basket.getByRole('button', { name: 'Затвори избора' }), { key: 'Tab', shiftKey: true })).toBe(false)
    expect(basket.getByRole('button', { name: /Копирай избора/ })).toHaveFocus()
    expect(fireEvent.keyDown(basket.getByRole('button', { name: /Копирай избора/ }), { key: 'Tab' })).toBe(false)
    expect(basket.getByRole('button', { name: 'Затвори избора' })).toHaveFocus()
    await user.click(basket.getByRole('button', { name: /Копирай избора/ }))
    expect(basket.getByLabelText(/Твоето име/)).toHaveFocus()
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
    expect(opener).toHaveAttribute('aria-expanded', 'false')
    expect(document.body.style.overflow).toBe('')
    expect(document.getElementById('mobile-participant-name')).toBeNull()
  })

  it.each(['button', 'backdrop'])('closes the mobile dialog via its %s and returns focus', async (method) => {
    const user = userEvent.setup()
    render(<MenuApp menu={menuFixture} />)
    const opener = screen.getByRole('button', { name: /0 избора/ })
    await user.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'Обядът ти' })
    if (method === 'button') await user.click(within(dialog).getByRole('button', { name: 'Затвори избора' }))
    else {
      fireEvent.click(dialog, { clientX: 0, clientY: 0 })
      expect(dialog).toHaveAttribute('open')
      fireEvent.click(dialog, { clientX: -1, clientY: -1 })
    }
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('closes the modal when switching to desktop and focuses the visible basket', async () => {
    const media = mobileViewport()
    const user = userEvent.setup()
    render(<MenuApp menu={menuFixture} />)
    await user.click(screen.getByRole('button', { name: /0 избора/ }))
    act(() => { media.matches = true; media.addEventListener.mock.calls[0][1]() })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(screen.getByRole('complementary', { name: 'Обобщение на избора' })).getByRole('heading', { name: 'Обядът ти' })).toHaveFocus()
    expect(media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
  })

  it.each(['false', 'throw', 'missing'])('offers a manual summary when the legacy copy result is %s', async (result) => {
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: result === 'missing' ? undefined : vi.fn(() => {
      if (result === 'throw') throw new Error('denied')
      return false
    }) })
    render(<MenuApp menu={menuFixture} />)
    await user.click(screen.getByRole('button', { name: 'Добави Пилешка супа' }))
    await user.type(screen.getByLabelText(/Твоето име/), 'Иван')
    await user.click(screen.getByRole('button', { name: /Копирай избора/ }))
    expect(screen.queryByText('Обобщението е копирано.')).not.toBeInTheDocument()
    expect((screen.getByRole('textbox', { name: 'Обобщение за ръчно копиране' }) as HTMLTextAreaElement).value).toContain('1 × Пилешка супа')
    expect(document.querySelector('textarea[style*="opacity"]')).toBeNull()
  })

  it('keeps the legacy copy fallback inside the modal and offers recovery there if it fails', async () => {
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    const execCommand = vi.fn(() => {
      expect(document.activeElement?.closest('dialog')).toHaveAttribute('open')
      return false
    })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    render(<MenuApp menu={menuFixture} />)
    await user.click(screen.getByRole('button', { name: 'Добави Пилешка супа' }))
    await user.click(screen.getByRole('button', { name: /1 избор/ }))
    const basket = within(screen.getByRole('dialog', { name: 'Обядът ти' }))
    await user.type(basket.getByLabelText(/Твоето име/), 'Иван')
    await user.click(basket.getByRole('button', { name: /Копирай избора/ }))
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(basket.getByRole('textbox', { name: 'Обобщение за ръчно копиране' })).toHaveFocus()
  })

  it('does not show an obsolete summary when a pending copy fails after editing the basket', async () => {
    const user = userEvent.setup()
    let rejectCopy!: (error: Error) => void
    installClipboard(vi.fn(() => new Promise((_resolve, reject) => { rejectCopy = reject })))
    render(<MenuApp menu={menuFixture} />)
    await user.click(screen.getByRole('button', { name: 'Добави Пилешка супа' }))
    await user.type(screen.getByLabelText(/Твоето име/), 'Иван')
    await user.click(screen.getByRole('button', { name: /Копирай избора/ }))
    await user.click(screen.getByRole('button', { name: 'Добави Пилешка супа' }))
    await act(async () => rejectCopy(new Error('denied')))
    expect(screen.queryByRole('textbox', { name: 'Обобщение за ръчно копиране' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Автоматичното копиране не успя/)).not.toBeInTheDocument()
  })

  it.each(['blocked', 'full'])('keeps selection, copying, clearing, and Undo usable when storage is %s', async (failure) => {
    const user = userEvent.setup()
    const writeText = installClipboard()
    if (failure === 'blocked') {
      vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
      vi.spyOn(localStorage, 'removeItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
    }
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('unavailable', 'QuotaExceededError') })
    render(<MenuApp menu={menuFixture} />)
    expect(screen.getByText(/Браузърът не позволява запазване/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Добави Пилешка супа' }))
    await user.type(screen.getByLabelText(/Твоето име/), 'Иван')
    await user.click(screen.getByRole('button', { name: /Копирай избора/ }))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('1 × Пилешка супа'))
    await user.click(screen.getByRole('button', { name: 'Изчисти' }))
    await user.click(screen.getByRole('button', { name: 'Върни избора' }))
    expect(screen.getByLabelText('Избрано количество: 1')).toHaveTextContent('1')
    expect(screen.getByLabelText(/Твоето име/)).toHaveValue('Иван')
  })

  it('reconciles a corrected same-day menu, retains valid choices, reprices, and copies only current dishes', async () => {
    const user = userEvent.setup()
    const writeText = installClipboard()
    const view = render(<MenuApp menu={menuFixture} />)
    await user.click(screen.getByRole('button', { name: 'Добави Пилешка супа' }))
    await user.click(screen.getByRole('button', { name: 'Добави Пилешка супа' }))
    await user.click(screen.getByRole('button', { name: 'Добави Пилешко филе' }))
    await user.type(screen.getByLabelText(/Твоето име/), 'Иван')
    await user.type(screen.getByLabelText(/Бележка/), 'Без хляб')
    const corrected = structuredClone(menuFixture)
    corrected.categories[0].items[0].priceCents = 300
    corrected.categories[1].items[0].id = 'new-main'
    view.rerender(<MenuApp menu={corrected} />)
    expect(screen.getByText(/Менюто или запазеният избор е променен/)).toBeInTheDocument()
    const basket = within(screen.getByRole('complementary', { name: 'Обобщение на избора' }))
    expect(basket.queryByText('Пилешко филе')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Избрано количество: 2')).toHaveTextContent('2')
    expect(basket.getAllByText(/6,00\s*€/)).toHaveLength(2)
    await user.click(basket.getByRole('button', { name: /Копирай избора/ }))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('2 × Пилешка супа'))
    expect(writeText.mock.calls[0][0]).not.toContain('Пилешко филе')
    expect(writeText.mock.calls[0][0]).toContain('Бележка: Без хляб')
    expect(JSON.parse(localStorage.getItem('mandarin-order-draft-v1')!).quantities).toEqual({ soup: 2 })
  })
})
