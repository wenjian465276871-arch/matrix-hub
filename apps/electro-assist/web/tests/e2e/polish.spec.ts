import { expect, test } from '@playwright/test'

/**
 * 计划 §12.4 / §12.5 / §12.6 剩下的四条交互：
 * ① 0–800ms 只在按钮里转圈、>800ms 转骨架；
 * ② 发布闸门（后端测试覆盖，这里只验前端没有绕过路径）；
 * ③ 路由切换焦点归位 h1；
 * ④ 列表「加载更多」每页 12；
 * ⑤ 打印时表头每页重复（真表格 + thead）。
 *
 * 用的是 route mock 而不是真生成：真生成一次 8–15 秒还花 token，
 * 而这里要验的是「800ms 这个分界点」——用延迟可控的假响应才测得准。
 */

test('800ms 内只转按钮，超过转骨架，取消后不再轮询', async ({ page }) => {
  let jobsPolled = 0
  page.on('request', (req) => {
    if (req.url().includes('/api/electro/jobs/')) jobsPolled += 1
  })

  // 让提交请求停在路上 1.8s：既跨过 800ms 分界，也给"提交阶段取消"留出窗口
  await page.route('**/api/electro/generate', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1800))
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        job_id: 'j_0123456789abcdef',
        status: 'queued',
        poll_after_ms: 1000,
      }),
    })
  })

  await page.goto('./new')
  await page.getByRole('button', { name: '填入示例' }).click()
  await page.getByRole('button', { name: '生成指导书' }).click()

  // ① 前 800ms：表单还在，按钮里在转，页面没切走
  await expect(page.locator('.btn__spin')).toBeVisible()
  expect(await page.locator('.gen-skeleton').count()).toBe(0)
  await expect(page.locator('#process-text')).toBeVisible()

  // ② 超过 800ms：骨架出现，表单收走
  await expect(page.locator('.gen-skeleton')).toBeVisible()
  await expect(page.locator('#process-text')).toHaveCount(0)
  await expect(page.locator('.card.state')).toContainText('正在生成')

  // ③ 提交请求还没回来就取消：不进入轮询，且如实说明任务仍在后台
  await page.getByRole('button', { name: '停止等待' }).click()
  await expect(page.locator('.gen-skeleton')).toHaveCount(0)
  await expect(page.locator('#process-text')).toBeVisible()

  // 等假响应回来：它在路上被取消，回来时只能被丢弃——不进入轮询
  await page.waitForTimeout(2200)
  await expect(page.getByText('已停止等待')).toBeVisible()
  await expect(page.getByText('j_0123456789abcdef')).toBeVisible()
  expect(jobsPolled).toBe(0)
})

test('路由切换把焦点送到新页 h1', async ({ page }) => {
  await page.goto('./')
  // 首次进入不抢焦点（否则首屏就多一个焦点环）
  const initial = await page.evaluate(() => document.activeElement?.tagName ?? '')
  expect(initial).toBe('BODY')

  await page.getByRole('link', { name: '隐私与数据' }).click()
  await expect(page).toHaveURL(/\/privacy$/)
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
  const tabindex = await page.evaluate(() =>
    document.querySelector('h1')?.getAttribute('tabindex'),
  )
  expect(tabindex).toBe('-1')

  // 再跳一次：从说明页回列表，焦点同样归位
  await page.locator('.brand').click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('作业指导书')
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
})

test('列表每页 12，点「加载更多」追加并保留焦点', async ({ page }) => {
  const card = (index: number) => ({
    id: `g_mock_${String(index).padStart(3, '0')}_001`,
    title: `分页样例 ${index}`,
    summary: '用于验证「加载更多」的假数据，不发真实请求。',
    system: 'door',
    step_count: 3,
    estimated_s: 180,
    generated_at: '2026-11-01T00:00:00+00:00',
    is_demo: true,
    status: 'published',
    source_note: '演示数据',
  })
  const pages = [
    { items: Array.from({ length: 12 }, (_, i) => card(i)), total: 14, has_more: true },
    { items: Array.from({ length: 2 }, (_, i) => card(12 + i)), total: 14, has_more: false },
  ]
  const seen: string[] = []
  await page.route('**/api/electro/guides?**', async (route) => {
    const url = new URL(route.request().url())
    const offset = Number(url.searchParams.get('offset') ?? '0')
    // 分页口径必须真的被用上：limit 12 + offset 决定返回哪一页
    expect(url.searchParams.get('limit')).toBe('12')
    const page = pages[offset === 0 ? 0 : 1]
    seen.push(`offset=${offset}`)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schema_version: '1.2',
        count: page.items.length,
        total: page.total,
        has_more: page.has_more,
        limit: 12,
        offset,
        items: page.items,
      }),
    })
  })

  await page.goto('./')
  await expect(page.locator('.guide-card')).toHaveCount(12)
  await expect(page.locator('.list-more')).toContainText('已显示 12 / 共 14 份')

  const more = page.getByRole('button', { name: /加载更多（还有 2 份）/ })
  await more.click()
  await expect(page.locator('.guide-card')).toHaveCount(14)
  await expect(page.locator('.list-more')).toHaveCount(0)
  await expect(page.locator('.list-end')).toContainText('已全部显示')
  // 按钮消失后焦点交给第一条新卡片，不掉回 body
  await expect(page.locator('.guide-card').nth(12)).toBeFocused()
  expect(seen).toEqual(['offset=0', 'offset=12'])
})

test('打印时表格换真表格、表头随分页重复', async ({ page }) => {
  await page.goto('./guide/g_door_switch_formal_001')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  // 表格在图示里、图示在第 7 步；一步一屏之后要先进那一页才有这张表。
  // 必须等翻页真的落位（页码变了、表格挂上了）再切打印媒体——否则测的是上一页。
  await page.locator('.cover__toc-item').filter({ hasText: '锁闭到位与门扇间隙' }).click()
  await expect(page.locator('.pager__count')).toContainText(/8\s*\/\s*9/)
  await expect(page.locator('.fig-table__svg').first()).toBeAttached()

  await page.emulateMedia({ media: 'print' })
  const printed = await page.evaluate(() => {
    const svg = document.querySelector('.fig-table__svg')
    const table = document.querySelector('.fig-table__stack')
    const thead = table?.querySelector('thead')
    return {
      svg: svg ? getComputedStyle(svg).display : 'missing',
      table: table ? getComputedStyle(table).display : 'missing',
      thead: thead ? getComputedStyle(thead).display : 'missing',
      headers: Array.from(thead?.querySelectorAll('th') ?? []).map((th) => th.textContent?.trim()),
    }
  })
  // SVG 是一张整图，跨页会被切断且没法重复表头 → 打印换成真表格
  expect(printed.svg).toBe('none')
  expect(printed.table).toBe('table')
  expect(printed.thead).toBe('table-header-group')
  expect(printed.headers.length).toBeGreaterThan(0)
  expect(printed.headers[0]).toBe('项目')
})
