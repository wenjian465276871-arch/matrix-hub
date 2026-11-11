import { expect, test } from '@playwright/test'

/**
 * 计划 §12.5 的四条移动端规格 + §12.4 的「超限提示但不阻断」。
 *
 * 这五条都有同一个特点：**桌面浏览器里看不见**。1280 宽的冒烟永远跑不到
 * `<360px` 断点、横屏短高档、软键盘顶升，也点不到「仍要提交」——不写这条用例，
 * 它们只能靠人记得去改窗口大小。
 *
 * 五条写在同一个用例里：建会话按 IP 限流 2 次/小时，拆开就会互抢额度并误报 429。
 */

test('窄屏 / 键盘顶升 / 表格堆叠 / 点击放大 / 仍要提交', async ({ page }) => {
  // 模拟 iOS 软键盘：visualViewport 变小，innerHeight 不变。真机无法在 CI 里按出来。
  await page.addInitScript(() => {
    const listeners: Record<string, Array<(e: { type: string }) => void>> = {}
    const vv = {
      height: window.innerHeight,
      offsetTop: 0,
      addEventListener: (t: string, fn: (e: { type: string }) => void) => {
        ;(listeners[t] ||= []).push(fn)
      },
      removeEventListener: (t: string, fn: (e: { type: string }) => void) => {
        listeners[t] = (listeners[t] || []).filter((f) => f !== fn)
      },
    }
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv })
    ;(window as unknown as { __kb: (h: number) => void }).__kb = (h: number) => {
      vv.height = h
      ;(listeners.resize || []).forEach((f) => f({ type: 'resize' }))
    }
  })

  // ---------- ① 表格在 <360px 转「标签-值」堆叠 ----------
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto('./')
  await page.locator('.guide-card').filter({ hasText: '开关门' }).first().click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('开关门')

  // 2026-11-11 起 /guide/:id 默认是探索台（三栏），分页阅读器在 /read。
  // 本用例要验的是阅读器里的图表堆叠与翻页，所以从探索台的「打印视图」进。
  await page.getByRole('button', { name: '打印视图' }).click()
  await expect(page.locator('.cover__toc-item').first()).toBeVisible()

  // 2026-11-10 起是「一步一屏」：表格在第 7 步，必须先进那一页。
  // 顺带把翻页本身也验了——封面目录跳步 → 圆点回封面。
  await page.locator('.cover__toc-item').filter({ hasText: '锁闭到位与门扇间隙' }).click()
  await expect(page.locator('.pager__count')).toContainText(/8\s*\/\s*9/)
  await expect(page.locator('.fig-table__stack')).toBeVisible()
  await expect(page.locator('.fig-table__svg').first()).toBeHidden()
  // 标签来自表头，不是写死的
  await expect(page.locator('.fig-table__stack td').first()).toHaveAttribute('data-label', '标准')

  // 回封面再进 A1：开始引导的按钮只在封面。
  // 窄屏没有圆点（1080px 以下换成下拉），所以走 select——这也顺带验了窄屏的跳页入口。
  await page.getByLabel('跳转到页').selectOption('0')
  await expect(page.locator('.pager__count')).toContainText(/1\s*\/\s*9/)

  // ---------- 进 A1，走到有数值判据的第 2 步 ----------
  await page.getByRole('button', { name: '开始引导作业' }).click()
  await expect(page).toHaveURL(/\/run\/s_/)
  await page.getByRole('checkbox').first().check()
  await page.getByRole('button', { name: '提交本步' }).click()
  await expect(page.getByRole('button', { name: '继续下一步' })).toBeVisible()
  await page.getByRole('button', { name: '继续下一步' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('第 2 / 8 步')

  // ---------- ② <360px 判据行上下堆叠 ----------
  const row = page.locator('.input-row').first()
  await expect(row).toHaveCSS('flex-direction', 'column')
  const geom = await page.evaluate(() => {
    const r = document.querySelector('.input-row')!.getBoundingClientRect()
    const i = document.querySelector('.num-input')!.getBoundingClientRect()
    const c = document.querySelector('.unit-chip')!.getBoundingClientRect()
    return { row: r.width, input: i.width, chipBelow: c.top >= i.bottom - 1 }
  })
  // 堆叠后输入框吃满整行、单位落到下一行
  expect(Math.abs(geom.input - geom.row)).toBeLessThanOrEqual(1)
  expect(geom.chipBelow).toBe(true)

  // ---------- ③ 软键盘把底栏顶起来 ----------
  await page.evaluate(() => (window as unknown as { __kb: (h: number) => void }).__kb(400))
  await expect
    .poll(async () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--kb-inset').trim(),
      ),
    )
    .toBe('240px')
  await expect(page.locator('.run-bar')).toHaveCSS('bottom', '240px')
  await page.evaluate(() => (window as unknown as { __kb: (h: number) => void }).__kb(window.innerHeight))
  await expect
    .poll(async () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--kb-inset').trim(),
      ),
    )
    .toBe('0px')

  // ---------- ⑤ 超限：提示 + 按钮改文案，不阻断 ----------
  for (const input of await page.locator('.num-input').all()) await input.fill('200')
  for (const select of await page.locator('.select').all()) {
    if ((await select.locator('option').count()) > 1) await select.selectOption({ index: 1 })
  }
  for (const box of await page.locator('.field input[type=checkbox]').all()) {
    if (!(await box.isChecked())) await box.check()
  }
  for (const area of await page.locator('.field textarea').all()) await area.fill('记录：超差')

  await expect(page.locator('.run-bar__warn')).toContainText('项超差')
  await expect(page.locator('.field__error').first()).toContainText('超出上限')
  const primary = page.locator('.bar-primary')
  await expect(primary).toContainText('仍要提交')
  await expect(primary).toBeEnabled() // 不阻断

  // ---------- ④ 横屏「点击放大」 ----------
  await page.setViewportSize({ width: 844, height: 390 })
  const zoomBtn = page.locator('.figure__zoom').first()
  await expect(zoomBtn).toBeVisible()
  await zoomBtn.click()

  const layer = page.locator('.figure__zoom-layer')
  await expect(layer).toBeVisible()
  await expect(layer).toHaveAttribute('role', 'dialog')
  await expect(layer).toHaveAttribute('aria-modal', 'true')
  await expect(page.locator('.figure__zoom-close')).toBeFocused()
  await expect(page.locator('html')).toHaveClass(/is-figure-zoom/)
  // 放大要真的更大：面板里的 svg 至少是行内图的两倍宽
  const widths = await page.evaluate(() => {
    const inLayer = document.querySelector('.figure__zoom-layer svg')!.getBoundingClientRect().width
    return { inLayer: Math.round(inLayer) }
  })
  expect(widths.inLayer).toBeGreaterThan(340)

  await page.keyboard.press('Escape')
  await expect(layer).toHaveCount(0)
  await expect(page.locator('html')).not.toHaveClass(/is-figure-zoom/)
  await expect(zoomBtn).toBeFocused()

  // ---------- ⑤ 收尾：点了「仍要提交」由服务端判异常 ----------
  await page.setViewportSize({ width: 320, height: 640 })
  await page.getByRole('button', { name: /仍要提交/ }).click()
  await expect(page.locator('.result-box--bad')).toBeVisible()
  await expect(page.locator('.result-box--bad')).toContainText('本步异常')
})
