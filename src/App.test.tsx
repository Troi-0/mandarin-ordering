import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { menuFixture } from './test/menu-fixture.ts'
import { MenuApp } from './App.tsx'

describe('interactive menu', () => {
  it('requires a name and copies the exact selection without opening Web Share', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    const share = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
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
})
