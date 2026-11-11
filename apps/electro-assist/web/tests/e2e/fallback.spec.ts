import { expect, test } from '@playwright/test'

/**
 * A2 三级降级的第三级（计划 §2.1）：步骤既没有原语图示、也没有现场素材时，
 * 页面必须**显式**说明"这里没有图、可以怎么补"，不能靠"整块不渲染"静默跳过。
 *
 * 用路由拦截改造真实响应，而不是往产品案例里塞一份缺图样例：
 * 缺图是降级路径，不是演示内容；把它固化成案例会让人误以为正式案例缺图。
 */
test('无图示且无素材的步骤显示占位说明', async ({ page }) => {
  await page.route('**/api/electro/guides/*', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    const step = body.guide.steps[0]
    step.figures = []
    step.assets = []
    await route.fulfill({ response: res, json: body })
  })

  await page.goto('./')
  await page.locator('.guide-card').first().click()

  // 2026-11-11：/guide/:id 默认是探索台，分页阅读器在 /read。
  // 本用例验的是阅读器里的流程，从探索台顶栏的「打印视图」进去。
  await page.getByRole('button', { name: '打印视图' }).click()

  const empty = page.locator('.step__empty').first()
  await expect(empty).toBeVisible()
  await expect(empty).toContainText('本步暂无可视化图示')
  // 占位不能顶掉正文：判据仍在同一张步骤卡里
  await expect(page.locator('.step').first().locator('.criterion').first()).toBeVisible()
})
