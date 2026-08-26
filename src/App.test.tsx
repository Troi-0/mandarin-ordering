import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import currentPublicationData from '../data/current-menu.json'
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
  it('fails closed when the embedded publication date is not today in Sofia', () => {
    if (currentPublicationData.status !== 'ready') throw new Error('Expected a ready test publication')
    const [year, month, day] = currentPublicationData.menu.date.split('-').map(Number)
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.UTC(year, month - 1, day + 1, 12)))

    render(<App />)

    expect(screen.getByRole('heading', { name: 'Днешното меню все още не е налично' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Добави/ })).not.toBeInTheDocument()
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
