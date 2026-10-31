import { expect, test } from '@playwright/test'

/**
 * A1 横屏短高两栏（视觉规范 v1.5 §3.2 / 体验 §4）。
 *
 * 为什么单开一条：这段样式只在 `(orientation: landscape) and (max-height: 560px)`
 * 下生效，常规冒烟（1280×800 竖屏）永远跑不到；而它是"用高度换宽度"的重排，
 * 一旦回归就是右栏被挤出屏幕——桌面浏览器里肉眼很难发现。
 *
 * 三条视口写在**同一个用例**里：建会话是按 IP 限流的（2 次/小时），
 * 拆成三个 test 会互相抢额度，第 3 条必然 429——那不是布局问题。
 *
 * 断言的是几何事实，不是"有某个 class"。
 */

test('横屏两栏 / SE 回落 / 竖屏不变', async ({ page }) => {
  // ---------- 1) 844×390：两栏 ----------
  await page.setViewportSize({ width: 844, height: 390 })
  await page.goto('./')
  await page.locator('.guide-card').filter({ hasText: '开关门' }).first().click()
  await page.getByRole('button', { name: '开始引导作业' }).click()
  await expect(page).toHaveURL(/\/run\/s_/)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('第 1 / 8 步')

  const box = await page.evaluate(() => {
    const rect = (sel: string) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right }
    }
    const panel = document.querySelector('.run-step__panel') as HTMLElement
    return {
      panelCols: getComputedStyle(panel).gridTemplateColumns,
      figure: rect('.run-split__figure'),
      read: rect('.run-step__read'),
      criteria: rect('.run-split__criteria'),
      btn: rect('.bar-primary'),
      bar: rect('.run-bar'),
      vw: window.innerWidth,
    }
  })

  // 两栏：图示在左、判据在右，右栏宽 ≥280
  expect(box.panelCols.split(' ').length).toBe(2)
  expect(box.figure!.right).toBeLessThanOrEqual(box.read!.x)
  expect(box.read!.w).toBeGreaterThanOrEqual(280)

  // 判据整块落在底栏上方 —— "不被图示挤出首屏"的可测形式
  expect(box.criteria!.bottom).toBeLessThanOrEqual(box.bar!.y + 1)

  // 底栏主按钮：固定 240、右对齐（右边缘距屏右 16）
  expect(Math.round(box.btn!.w)).toBe(240)
  expect(Math.abs(box.vw - box.btn!.right - 16)).toBeLessThanOrEqual(1)

  // ---------- 2) 667×375（SE 横屏）：回落单列 + 逃生条短文案 ----------
  await page.setViewportSize({ width: 667, height: 375 })
  await page.evaluate(() => localStorage.setItem('electro-theme', 'dark'))
  await page.reload()
  await expect(page.locator('html')).toHaveClass(/theme-dark/)

  // 右栏算下来只有 248px（< 280），必须回落单列
  await expect(page.locator('.run-card')).toHaveCSS('display', 'block')

  const notice = page.locator('.theme-notice')
  await expect(notice).toBeVisible()
  await expect(notice.locator('.theme-notice__short')).toBeVisible()
  await expect(notice.locator('.theme-notice__full')).toBeHidden()
  // h44 与热区不放宽
  expect(await notice.evaluate((el) => Math.round(el.getBoundingClientRect().height))).toBe(44)
  await expect(notice.getByRole('button', { name: '切回亮色' })).toHaveCSS('min-height', '44px')

  // ---------- 3) 390×844（竖屏）：完全不受影响 ----------
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('.run-card')).toHaveCSS('display', 'block')
  const portrait = await page.evaluate(() => {
    const btn = document.querySelector('.bar-primary')!.getBoundingClientRect()
    return { w: btn.width, right: btn.right }
  })
  // 竖屏主按钮仍吃掉整行剩余宽度（左边是「中止」），没被横屏的 240 规则污染
  expect(portrait.w).toBeGreaterThan(240)
  expect(Math.abs(390 - portrait.right - 16)).toBeLessThanOrEqual(1)
})
