/**
 * 三维演示页：从导航进得去，进去之后场景真的建起来了。
 *
 * ## 为什么单独一条，而不是并进 smoke
 *
 * 这是全站唯一用 WebGL 的页面，也是最容易「看着正常、其实空白」的页面：
 * Three.js 加载失败、几何构建抛错、材质编译不过，页面框架全都还在，只有画布是空的。
 * 2026-11-09 首次上线时，CI 一路全绿，但 E2E **没有任何一条用例访问过这个路由**——
 * 页面是我手动用浏览器验的。这条把那个缺口补上。
 *
 * ## 为什么不硬断言 canvas
 *
 * CI 的 runner 没有 GPU，WebGL 可能拿不到上下文，此时页面会显示
 * 「… · 已降级为文字说明」——那是**设计内的降级**，不是缺陷。硬断言 canvas
 * 会让海外 runner 的显卡能力决定 CI 红绿。所以断言的是：
 * **要么画布有实际尺寸，要么明确降级**，两者都不出现才算失败（那才是白屏）。
 * 另外任何 pageerror 都算失败——Three.js 的异常几乎都会冒到这一层。
 */
import { expect, test } from '@playwright/test'

test('导航入口 → 三维演示：场景建起来（或明确降级），不出现白屏', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('./')
  await page.getByRole('link', { name: '三维演示' }).click()

  await expect(page).toHaveURL(/\/demo\/device$/)
  await expect(page.getByRole('heading', { name: '车门开闭功能检查' })).toBeVisible()

  const canvas = page.locator('canvas').first()
  const degraded = page.getByText(/已降级为文字说明/)
  await expect(canvas.or(degraded)).toBeVisible({ timeout: 20_000 })

  if (await canvas.isVisible()) {
    const box = await canvas.boundingBox()
    expect(box?.width ?? 0, '画布宽度').toBeGreaterThan(200)
    expect(box?.height ?? 0, '画布高度').toBeGreaterThan(150)
  }

  expect(errors, `页面抛错：${errors.join(' | ')}`).toEqual([])
})
