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

  // 2026-11-11：/guide/:id 默认是探索台，分页阅读器在 /read。
  // 本用例验的是阅读器里的流程，从探索台顶栏的「打印视图」进去。
  await page.getByRole('button', { name: '打印视图' }).click()
  await page.getByRole('button', { name: '开始引导作业' }).click()
  await expect(page).toHaveURL(/\/run\/s_/)

  const notice = page.locator('.theme-notice')
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('现场作业建议切换亮色')

  // ---------- 转 B：必须带 from=run 与 sid ----------
  // 第 1 步：勾选人工确认项后提交
  await page.getByRole('checkbox').first().check()
  await page.getByRole('button', { name: '提交本步' }).click()
  await page.getByRole('button', { name: '继续下一步' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('第 2 / 8 步')

  // 第 2 步：填超差值，触发异常分支
  for (const input of await page.locator('.num-input').all()) await input.fill('200')
  for (const select of await page.locator('.select').all()) {
    if ((await select.locator('option').count()) > 1) await select.selectOption({ index: 1 })
  }
  for (const box of await page.locator('.field input[type=checkbox]').all()) {
    if (!(await box.isChecked())) await box.check()
  }
  for (const area of await page.locator('.field textarea').all()) await area.fill('记录：超差')
  await page.getByRole('button', { name: /仍要提交/ }).click()
  await expect(page.locator('.result-box--bad')).toBeVisible()

  await page.getByRole('button', { name: '转故障排查' }).click()
  await expect(page).toHaveURL(/\/diagnose/)
  const url = new URL(page.url())
  expect(url.searchParams.get('from')).toBe('run')
  expect(url.searchParams.get('sid')).toMatch(/^s_[0-9a-f]{16}$/)
  // 转入的 B 会话仍属现场语境：暗色逃生条必须还在
  await expect(notice).toBeVisible()

  // 逐步诊断必须把 sid 带给后端：否则 B 的结论回不到作业记录
  await page.getByRole('tab', { name: '逐步诊断' }).click()
  const started = page.waitForRequest(
    (req) => req.url().includes('/api/electro/diagnose/runs') && req.method() === 'POST',
  )
  await page.getByRole('button', { name: '开始逐步诊断' }).click()
  const runBody = (await started).postDataJSON() as { session_id?: string | null }
  expect(runBody.session_id).toBe(url.searchParams.get('sid'))

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
