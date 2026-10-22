import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures'

async function focused(window: Page): Promise<{ text: string; focusVisible: boolean }> {
  return window.evaluate(() => {
    const el = document.activeElement
    return { text: el?.textContent ?? '', focusVisible: el?.matches(':focus-visible') ?? false }
  })
}

test('the window renders the empty-project state with app info', async ({ window }) => {
  await expect(window).toHaveTitle('Veydr')
  await expect(window.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible()
  await expect(window.getByTestId('empty-projects')).toContainText('No projects yet')
  await expect(window.getByTestId('app-info-summary')).toHaveText('Veydr 0.0.0 · linux')
  await expect(window.getByRole('alert')).toHaveCount(0)
})

test('the shell is keyboard navigable in a stable focus order', async ({ window }) => {
  await expect(window.getByTestId('app-info-summary')).toHaveText(/Veydr/)

  await window.keyboard.press('Tab')
  expect(await focused(window)).toEqual({ text: 'Projects', focusVisible: true })
  await window.keyboard.press('Tab')
  expect(await focused(window)).toEqual({ text: 'About', focusVisible: true })

  await window.keyboard.press('Enter')
  await expect(window.getByRole('heading', { level: 1, name: 'About' })).toBeVisible()
  await expect(window.getByRole('button', { name: 'About' })).toHaveAttribute('aria-current', 'page')
  const info = window.getByTestId('app-info')
  await expect(info).toContainText('linux')
  await expect(info).toContainText(/Electron\s*44\.9\.3/)

  await window.keyboard.press('Shift+Tab')
  expect(await focused(window)).toEqual({ text: 'Projects', focusVisible: true })
  await window.keyboard.press('Space')
  await expect(window.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible()
  await expect(window.getByRole('button', { name: 'Projects' })).toHaveAttribute('aria-current', 'page')
})
