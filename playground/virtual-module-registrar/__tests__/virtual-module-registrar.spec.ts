import { expect, test } from 'vitest'
import { page, viteTestUrl } from '~utils'

test('virtual module is resolved and rendered', async () => {
  await page.goto(viteTestUrl)
  await expect.poll(() => page.textContent('#env')).toContain('baz')
  await expect.poll(() => page.textContent('#env')).toContain('foo')
  await expect.poll(() => page.textContent('#env')).toContain('qux')
})
