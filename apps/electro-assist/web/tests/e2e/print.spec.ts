/** 打印态回归（R20-8）。
 *
 *  ## 为什么单独一条
 *
 *  屏幕上"能点、有状态"是好设计，纸上就是噪音甚至误导：
 *  2026-11-14 实测，打印视图里底部六个状态灯、HUD 的「未上电 单元未选择 网压 0 kV」、
 *  「放大操作」「放大看」、以及全站顶栏全都打到纸上；MON 那块深色屏在白纸上
 *  只剩浅色字，等于看不见。这些**不影响任何屏幕用例**，所以必须单独盯着打印媒体。
 *
 *  ## 断言什么
 *
 *  1. 交互控件与运行态文案：打印态下不可见（用渲染盒判断，父级 display:none 也算不可见）；
 *  2. 三维：要么有静态帧 `<img>`，要么有一句文字兜底——**不许留白框**。
 *     CI 的 runner 没有 GPU，`toDataURL` 可能拿不到帧，所以两种都算通过；
 *  3. MON 屏：背景必须被翻成浅色（深色屏在白纸上等于隐形）。
 */
import { expect, test, type Page } from '@playwright/test'

const GUIDE_READ = './guide/g_pantograph_raise_test/read'

/** 切到打印媒体后，某个选择器在纸上是否真的占位置。 */
async function occupiesPaper(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    const box = el.getBoundingClientRect()
    return box.width > 1 && box.height > 1
  }, selector)
}

/** 翻到第 n 页（1 = 封面，2 = 第 1 步…）。翻页按钮在打印态是隐藏的，必须先切回屏幕。 */
async function gotoPage(page: Page, n: number): Promise<void> {
  await page.emulateMedia({ media: 'screen' })
  await page.waitForTimeout(120)
  for (let i = 1; i < n; i += 1) {
    await page.getByRole('button', { name: /下一页/ }).click()
    await page.waitForTimeout(500)
  }
  await page.emulateMedia({ media: 'print' })
  await page.waitForTimeout(350)
}

test('打印态：操作台页无按钮、无运行文案，三维有图或文字兜底', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto(GUIDE_READ)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('受电弓升弓试验')

  // 第 3 页 = 第 2 步（上电激活，操作台）
  await gotoPage(page, 3)

  for (const selector of ['.topbar', '.ops__acts', '.ops__float', '.ops__hud', '.figure__zoom']) {
    expect(await occupiesPaper(page, selector), `${selector} 不该出现在纸上`).toBe(false)
  }
  // 三维：静态帧或文字兜底，二选一即可
  const hasShot = await occupiesPaper(page, '.ops__print')
  const hasText = await occupiesPaper(page, '.ops__print-text')
  expect(hasShot || hasText, '三维区域在纸上既没图也没兜底文字').toBe(true)
  // 画布本身必须退出纸面（否则会留一块空框/透明区）
  expect(await occupiesPaper(page, '.ops__pane canvas')).toBe(false)
})

test('打印态：MON 屏翻成浅色，页签与运行态状态牌都不印', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto(GUIDE_READ)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('受电弓升弓试验')

  // 第 4 页 = 第 3 步（MON 逐项确认）
  await gotoPage(page, 4)

  const brightness = await page.evaluate(() => {
    const frame = document.querySelector('.mon__frame')
    if (!frame) return null
    const bg = getComputedStyle(frame).backgroundColor
    const nums = bg.match(/\d+/g)?.map(Number) ?? []
    if (nums.length < 3) return null
    return { bg, min: Math.min(nums[0], nums[1], nums[2]) }
  })
  expect(brightness, '没找到 MON 屏').not.toBeNull()
  expect(brightness!.min, `MON 屏在纸上仍是深色底：${brightness!.bg}`).toBeGreaterThan(200)

  for (const selector of ['.mon__tabs', '.mon__softkeys', '.mon__stat', '.mon__form']) {
    expect(await occupiesPaper(page, selector), `${selector} 不该出现在纸上`).toBe(false)
  }
})
