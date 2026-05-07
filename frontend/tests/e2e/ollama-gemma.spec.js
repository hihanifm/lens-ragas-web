/**
 * Local Ollama + gemma E2E (optional in CI).
 *
 * Prerequisites on your machine:
 * - `make up` (or stack reachable at E2E_BASE_URL / Playwright defaults)
 * - Ollama running with the judge model pulled, e.g. `ollama pull gemma4:e2b`
 *
 * Run:
 *   cd frontend && npm run e2e -- tests/e2e/ollama-gemma.spec.js
 *
 * Model override:
 *   E2E_OLLAMA_MODEL=my:tag npm run e2e -- tests/e2e/ollama-gemma.spec.js
 *
 * CI: skipped unless E2E_RUN_OLLAMA_GEMMA=1 (needs Ollama + model on the runner).
 */
import { test, expect } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = path.resolve(testDir, '..', 'fixtures', 'sample-lens.json')

const OLLAMA_MODEL = process.env.E2E_OLLAMA_MODEL || 'gemma4:e2b'

async function pickOllamaModel(page, model) {
  await expect(page.getByText('Loading models...')).not.toBeVisible({ timeout: 60_000 })

  const plain = page.getByTestId('configure-ollama-model-input')
  const select = page.getByTestId('configure-ollama-model-select')

  if (await plain.isVisible()) {
    await plain.fill(model)
    return
  }

  if (await select.isVisible()) {
    const hasOption = await select.locator(`option[value="${model}"]`).count()
    if (hasOption > 0) {
      await select.selectOption(model)
      return
    }
    await select.selectOption({ label: 'Custom…' })
    const custom = page.getByTestId('configure-ollama-model-custom')
    await expect(custom).toBeVisible({ timeout: 10_000 })
    await custom.fill(model)
    return
  }

  await plain.fill(model)
}

test.describe('Ollama gemma local E2E', () => {
  test.beforeEach(() => {
    test.skip(
      process.env.CI === 'true' && process.env.E2E_RUN_OLLAMA_GEMMA !== '1',
      'CI: set E2E_RUN_OLLAMA_GEMMA=1 when the runner has Ollama and the model',
    )
  })

  test('sample LENS JSON evaluates with Ollama judge model', async ({ page }) => {
    await page.goto('/')

    await page.getByTestId('upload-input').setInputFiles(fixturePath)
    await expect(page.getByText('File loaded')).toBeVisible()

    await page.getByRole('button', { name: /Ollama \(on-prem\)/i }).click()

    await pickOllamaModel(page, OLLAMA_MODEL)

    // One metric keeps the run shorter; sample still has ground_truth for precision.
    await page.getByRole('checkbox', { name: /Context Recall/i }).uncheck()

    await page.getByTestId('run-evaluation').click()

    await expect(page.getByTestId('results-aggregate')).toBeVisible({ timeout: 180_000 })
    await expect(page.getByText(/Aggregate scores/i)).toBeVisible()
  })
})
