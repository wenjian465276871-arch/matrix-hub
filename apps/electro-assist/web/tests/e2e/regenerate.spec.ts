import { expect, test } from '@playwright/test'

/**
 * 「用同一份工艺再生成」入口（计划 §3.5 的 `POST /processes/{id}/generate`）。
 *
 * 这里只验**前端接线**：按钮在详情页出现、点击后打到正确的端点、
 * 并把 job 交给生成页续接。真正的配额与文本复用由后端契约测试覆盖
 * （`tests/test_process_persist.py`），不在 UI 层重复一遍。
 *
 * 两条路由都用拦截：样例指导书没有工艺来源（`process_id` 为 null），
 * 而这里要验的正是"有来源时才显示入口"。
 */
test('有工艺来源时可以从详情页重新生成', async ({ page }) => {
  const processId = 'p_' + 'a'.repeat(16)
  const jobId = 'j_' + 'b'.repeat(16)

  await page.route('**/api/electro/guides/*', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    body.process_id = processId
    await route.fulfill({ response: res, json: body })
  })
  await page.route(`**/api/electro/processes/${processId}/generate`, async (route) => {
    await route.fulfill({ status: 202, json: { job_id: jobId, status: 'queued' } })
  })

  await page.goto('./')
  await page.locator('.guide-card').first().click()
  const button = page.getByRole('button', { name: '再生成一份草稿' })
  await expect(button).toBeVisible()

  await button.click()
  await expect(page).toHaveURL(/\/new$/)
  // job 交接必须落进 sessionStorage，否则生成页不会续接轮询
  await expect
    .poll(async () => page.evaluate(() => sessionStorage.getItem('electro:job')))
    .toContain(jobId)
})
