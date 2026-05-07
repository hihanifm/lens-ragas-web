import { test, expect } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'

test('app loads and API is online', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Upload evaluation file')).toBeVisible()

  const apiPill = page.getByTestId('api-status-pill')
  await expect(apiPill).toBeVisible()
  await expect(apiPill).toContainText('API online', { timeout: 30_000 })
})

test('upload fixture transitions to configure screen', async ({ page }) => {
  await page.goto('/')

  const testDir = path.dirname(fileURLToPath(import.meta.url))
  const fixturePath = path.resolve(testDir, '..', 'fixtures', 'sample-lens.json')
  await page.getByTestId('upload-input').setInputFiles(fixturePath)

  await expect(page.getByText('File parsed.')).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('File loaded')).toBeVisible()
  await expect(page.getByText(/\d+\s+rows/i)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Run Evaluation' })).toBeVisible()
})

test('run evaluation shows results', async ({ page }) => {
  await page.goto('/')

  const testDir = path.dirname(fileURLToPath(import.meta.url))
  const fixturePath = path.resolve(testDir, '..', 'fixtures', 'sample-lens.json')
  await page.getByTestId('upload-input').setInputFiles(fixturePath)

  await expect(page.getByText('File parsed.')).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('File loaded')).toBeVisible()

  await page.getByTestId('run-evaluation').click()

  // This runs against a real judge; allow extra time.
  await expect(page.getByTestId('results-aggregate')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText(/Aggregate scores/i)).toBeVisible()
})

