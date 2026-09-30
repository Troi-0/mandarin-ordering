import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

afterEach(() => vi.useRealTimers())

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
    const basket = within(screen.getAllByRole('complementary', { name: 'Обобщение на избора' })[view])

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
    expect(screen.getAllByText('Не успяхме да копираме. Опитай отново.').length).toBeGreaterThan(0)
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
})
