import { expect, test } from '@playwright/test'

/**
 * 皮肤、抽屉、取消等待：三件"交互逻辑"，都不能靠肉眼抽查。
 *
 * 前两条会真的读写 localStorage 与 DOM class；第三条用 route mock 把生成流程
 * 钉在"永远 running"上——真跑一次生成要 Key、要钱、要等 8–15 秒，
 * 而这个用例要验的是"取消后不再轮询"，与模型无关。
 */

test('菜单：⋯ 打开抽屉 → 切暗色 → 刷新保持 → Esc 关闭并还焦点', async ({ page }) => {
  await page.goto('./')

  const trigger = page.getByRole('button', { name: '打开菜单' })
  await trigger.click()

  const dialog = page.getByRole('dialog', { name: '菜单' })
  await expect(dialog).toBeVisible()
  // 焦点进层落在"关闭"：进来就能退出，是弹层的底线
  await expect(page.getByRole('button', { name: '关闭' })).toBeFocused()

  await page.getByRole('switch', { name: '外观' }).click()
  await expect(page.locator('html')).toHaveClass(/theme-dark/)
  expect(await page.evaluate(() => localStorage.getItem('electro-theme'))).toBe('dark')

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  // 焦点回到触发键，键盘用户不会掉到 body 上
  await expect(trigger).toBeFocused()

  // 刷新后仍是暗色：皮肤存在 localStorage，不跟随系统
  await page.reload()
  await expect(page.locator('html')).toHaveClass(/theme-dark/)
})

test('暗色下 A1 出现逃生条，一键切回亮色', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('electro-theme', 'dark'))
  await page.goto('./')

  await page.locator('.guide-card').filter({ hasText: '开关门' }).first().click()
  await page.getByRole('button', { name: '开始引导作业' }).click()
  await expect(page).toHaveURL(/\/run\/s_/)

  const notice = page.locator('.theme-notice')
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('现场作业建议切换亮色')

  await notice.getByRole('button', { name: '切回亮色' }).click()
  await expect(page.locator('html')).not.toHaveClass(/theme-dark/)
  await expect(notice).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('electro-theme'))).toBe('light')
})

test('生成可取消：停止等待后不再轮询任务状态', async ({ page }) => {
  let polls = 0

  await page.route('**/api/electro/generate', (route) =>
    route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        job_id: 'j_0123456789abcdef',
        status: 'queued',
        poll_after_ms: 250,
      }),
    }),
  )
  await page.route('**/api/electro/jobs/**', (route) => {
    polls += 1
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'j_0123456789abcdef',
        status: 'running',
        guide_id: null,
        error_code: null,
        error_message: null,
        created_at: '2026-10-30T12:00:00+00:00',
        finished_at: null,
        duration_ms: null,
        usage: { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0 },
        cost_micros: 0,
        poll_after_ms: 250,
      }),
    })
  })

  await page.goto('./new')
  await page
    .locator('textarea')
    .fill('确认门控器供电 110V，单门开关门各 3 次，开门时间应 2.0–3.5s，作业前确认门区无人。')
  await page.getByRole('button', { name: '生成指导书' }).click()

  await expect(page.getByRole('button', { name: '停止等待' })).toBeVisible()
  await expect.poll(() => polls, { timeout: 5_000 }).toBeGreaterThan(0)

  await page.getByRole('button', { name: '停止等待' }).click()
  await expect(page.getByText('已停止等待，可以继续修改文本或单独提交。')).toBeVisible()
  await expect(page.getByRole('button', { name: '停止等待' })).toHaveCount(0)

  // 取消后必须真的停：再等两个轮询周期，请求数不能涨
  const frozen = polls
  await page.waitForTimeout(900)
  expect(polls).toBe(frozen)
})

test('暗色下打印仍是亮色（令牌优先级回归）', async ({ page }) => {
  // 这条是给 print.css 的 specificity 兜底：暗色令牌写在 html.theme-dark 上，
  // 只覆盖 :root 压不过它，暗色用户点打印会得到黑底白字。
  await page.addInitScript(() => localStorage.setItem('electro-theme', 'dark'))
  await page.goto('./')
  await expect(page.locator('html')).toHaveClass(/theme-dark/)

  await page.emulateMedia({ media: 'print' })
  const style = await page.evaluate(() => {
    const s = getComputedStyle(document.body)
    return { bg: s.backgroundColor, color: s.color }
  })
  expect(style.bg).toBe('rgb(255, 255, 255)')
  expect(style.color).toBe('rgb(0, 0, 0)')
})
