import { expect, test } from '@playwright/test'

/**
 * 刷新续接 / 429 倒计时 / 90 秒超时：三条都跟"等待"有关，靠肉眼看不出对错。
 * 生成接口一律 route mock：真跑一次要 Key、要钱，而这里验的是**前端怎么等**。
 */

const JOB = 'j_abcdef0123456789'

function running(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB,
    status: 'running',
    guide_id: null,
    error_code: null,
    error_message: null,
    created_at: '2026-10-30T12:00:00+00:00',
    finished_at: null,
    duration_ms: null,
    usage: { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0 },
    cost_micros: 0,
    poll_after_ms: 200,
    ...overrides,
  }
}

async function mockGenerate(page: import('@playwright/test').Page) {
  await page.route('**/api/electro/generate', (route) =>
    route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ job_id: JOB, status: 'queued', poll_after_ms: 200 }),
    }),
  )
}

async function fillAndSubmit(page: import('@playwright/test').Page) {
  await page.goto('./new')
  await page
    .locator('textarea')
    .fill('确认门控器供电 110V，单门开关门各 3 次，开门时间应 2.0–3.5s，作业前确认门区无人。')
  await page.getByRole('button', { name: '生成指导书' }).click()
}

test('刷新续接：job 落在 sessionStorage，刷新后接着轮询', async ({ page }) => {
  await mockGenerate(page)
  await page.route('**/api/electro/jobs/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(running()) }),
  )

  await fillAndSubmit(page)
  await expect(page.getByRole('button', { name: '停止等待' })).toBeVisible()

  const stored = await page.evaluate(() => sessionStorage.getItem('electro:job'))
  expect(stored).toContain(JOB)

  await page.reload()
  await expect(page.getByText('已续接刷新前的任务')).toBeVisible()
  await expect(page.getByText(JOB)).toBeVisible()

  // 续接后仍可停止，并且会清掉续接记录
  await page.getByRole('button', { name: '停止等待' }).click()
  expect(await page.evaluate(() => sessionStorage.getItem('electro:job'))).toBeNull()
})

test('429：按 Retry-After 倒计时并禁用提交，到时自动解禁', async ({ page }) => {
  await page.route('**/api/electro/generate', (route) =>
    route.fulfill({
      status: 429,
      headers: { 'Retry-After': '3' },
      contentType: 'application/json',
      body: JSON.stringify({
        detail: { code: 'quota_hour', message: '本小时额度已用完', retry_after: 3 },
      }),
    }),
  )

  await fillAndSubmit(page)

  const submit = page.getByRole('button', { name: /额度恢复后可生成/ })
  await expect(submit).toBeVisible()
  await expect(submit).toBeDisabled()
  await expect(page.getByText('额度已用完，3 秒后可以再生成。')).toBeVisible()

  // 3 秒后按钮自动解禁，并且不再显示倒计时
  await expect(page.getByRole('button', { name: '生成指导书' })).toBeEnabled({ timeout: 8_000 })
  await expect(page.getByText(/秒后可以再生成/)).toHaveCount(0)
})

test('90 秒预算：超时后停止等待并给出去重说法', async ({ page }) => {
  await page.clock.install()
  await mockGenerate(page)
  await page.route('**/api/electro/jobs/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(running()) }),
  )

  await fillAndSubmit(page)
  await expect(page.getByRole('button', { name: '停止等待' })).toBeVisible()

  // 把时钟推到 96 秒（90s 预算 + 5s 容差之后再留 1s）
  await page.clock.fastForward(96_000)

  await expect(page.getByText(/等待超过 90 秒仍未完成/)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: '停止等待' })).toHaveCount(0)
})

test('隐私与数据：页脚入口可达，保留期写清楚', async ({ page }) => {
  await page.goto('./')
  await page.getByRole('link', { name: '隐私与数据' }).click()
  await expect(page).toHaveURL(/\/privacy$/)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('隐私与数据')
  await expect(page.getByText(/请勿输入真实企业敏感信息/)).toBeVisible()
  await expect(page.getByText('30 天').first()).toBeVisible()
  await expect(page.getByText('180 天').first()).toBeVisible()
})
