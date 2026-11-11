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

/**
 * 操作级覆盖（2026-11-10 评审 P2-2）。
 *
 * 第一条用例只证明"页面能打开、画布有尺寸"——切换设备、拖时间轴、开关剖切
 * 三件事坏了，它照样绿。可这三件正是演示当天一定会点的。
 *
 * 只断言"控件状态变了"，不断言画面像素：像素比对在不同机器/字体下会抖，
 * 而控件状态 + 画布仍在，已经能抓住"点了没反应"这一类。
 */
test('三台设备可切换、时间轴可拖动、剖切可开关', async ({ page }) => {
  await page.goto('./demo/device')
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20_000 })

  // 1) 三台设备轮换：每次都要有画布，且标题跟着换
  for (const title of ['受电弓升降功能检查', '配电回路上电自检', '车门开闭功能检查']) {
    await page.getByRole('tab', { name: title }).click()
    await expect(page.getByRole('heading', { name: title })).toBeVisible()
    await expect(page.locator('canvas').first()).toBeVisible()
  }

  // 2) 时间轴：拖到 80%，读数要跟着走
  const timeline = page.locator('.demo__controls input[type="range"]').first()
  await timeline.evaluate((el) => {
    const input = el as HTMLInputElement
    input.value = '800'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await expect(page.locator('.demo__slider-label').first()).toContainText('时间轴 80%')

  // 3) 剖切：配电柜声明了 cut，按钮应是可用的，点了要变成"关闭剖切"并出现切面滑块
  await page.getByRole('tab', { name: '配电回路上电自检' }).click()
  const cutButton = page.getByRole('button', { name: '剖开看内部' })
  await expect(cutButton).toBeVisible()
  // force 不是偷懒：CI 的软件 WebGL 里切完设备后画布还在重排，
  // 按钮的盒子有一段时间在动，Playwright 的"stable"检查会一直等到 30 秒超时
  // （run 43050254650 就是这么挂的）。本用例要验的是"点了会切状态"，
  // 不是点击物理；force 仍会先把元素滚进视口再按当前盒子派发。
  await cutButton.scrollIntoViewIfNeeded()
  await cutButton.click({ force: true })
  const offButton = page.getByRole('button', { name: '关闭剖切' })
  await expect(offButton).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.demo__slider-label', { hasText: '切面位置' })).toBeVisible()
  await expect(page.locator('canvas').first()).toBeVisible()
})

/**
 * 受电弓的第三种工况（ADD 自动降弓）与标注开关。
 *
 * 为什么要单独立一条：这两个控件只在受电弓出现，别的设备没有——
 * 也就是说"整站回归"跑十遍也不会碰到它们。而 ADD 关系到气路三件（滑板破裂、
 * 压力开关断开、快排阀排气）能不能在画面上讲清楚，是本轮的核心交付，
 * 不能只靠肉眼看截图。
 */
test('受电弓可切 ADD 工况、标注可开关、读数跟着工况走', async ({ page }) => {
  await page.goto('./demo/device')
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20_000 })

  await page.getByRole('tab', { name: '受电弓升降功能检查' }).click()
  await expect(page.getByRole('button', { name: '正常升降弓' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // 1) 标注层是第二块 canvas：默认显示，点一下要能关掉
  const annot = page.locator('.scene__annot')
  await expect(annot).toHaveCount(1)
  await page.getByRole('button', { name: '隐藏标注' }).click()
  await expect(page.getByRole('button', { name: '显示标注' })).toHaveAttribute(
    'aria-pressed',
    'false',
  )

  // 2) 切到 ADD：时间轴复位、阶段名进入 ADD 分支
  await page.getByRole('button', { name: 'ADD 自动降弓' }).click()
  await expect(page.getByRole('button', { name: 'ADD 自动降弓' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.locator('.demo__slider-label').first()).toContainText('时间轴 0%')

  const timeline = page.locator('.demo__controls input[type="range"]').first()
  // 升到位
  await timeline.evaluate((el) => {
    const input = el as HTMLInputElement
    input.value = '700'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // 0.68–0.78 是"升弓到位"（开关闭合），0.78 之后才是保压
  await expect(page.locator('.demo__read').filter({ hasText: '动作阶段' })).toContainText(
    '升弓到位',
  )
  // 破裂之后：快排阀排气、弓头更快落下
  await timeline.evaluate((el) => {
    const input = el as HTMLInputElement
    input.value = '860'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await expect(page.locator('.demo__read').filter({ hasText: '动作阶段' })).toContainText('快排阀排气')
  await expect(page.locator('.demo__read').filter({ hasText: '气路压力' })).not.toContainText('0.62')
  await expect(page.locator('canvas').first()).toBeVisible()
})
