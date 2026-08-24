import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { menuFixture } from './test/menu-fixture.ts'
import { MenuApp } from './App.tsx'

describe('interactive menu', () => {
  it('requires a name and copies the exact selection when Web Share is unavailable', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
    render(<MenuApp menu={menuFixture} />)

    await user.click(screen.getByRole('button', { name: 'Добави Пилешка супа' }))
    const shareButtons = screen.getAllByRole('button', { name: /Сподели избора/ })
    await user.click(shareButtons[0])
    expect(screen.getAllByText('Името е задължително.').length).toBeGreaterThan(0)

    await user.type(screen.getAllByLabelText(/Твоето име/)[0], 'Мария')
    await user.click(shareButtons[0])

    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText.mock.calls[0][0]).toContain('Обяд за 2026-08-24 — Мария')
    expect(writeText.mock.calls[0][0]).toContain('Общо:')
  })
})
