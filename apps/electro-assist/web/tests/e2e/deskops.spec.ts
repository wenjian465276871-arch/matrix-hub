/**
 * 司机台两项新试验（空调制冷 / 开关门）的端到端：**动作只能从三维与 MON 来**。
 *
 * ## 2026-11-14 第二版交互（本人明确）
 * - 底部那一排是**状态**，不是按钮：动作只能点三维里的件（钥匙 / 手柄 / 门控按钮 / 试块）
 *   或 MON 弹窗里的按钮；
 * - **一页只做本页主工步的事**：越界的件点了会被拒绝并说明本步做什么；
 * - 空调没有"起动"按钮：MON 上选模式 + 下发 = 起机（通风 = 风机、制冷 = 压缩机）。
 *
 * ## 三维怎么点
 * `DeviceScene` 在 `pick` 场景上挂了 `window.__scenePoints[subject](key)`，返回该部件
 * 包围盒中心在视口里的坐标——直接 `mouse.click(x,y)`。按画布比例猜坐标必然脆
 * （按钮只有几厘米），这条出口只服务测试，不参与业务逻辑。
 *
 * ## 为什么读探针，不等时间
 * CI runner 没有 GPU，软件渲染只有 1–2fps。动画断言都读 `window.__ops()` 的**状态**，
 * 超时给足 40 秒——断言结果，不断言速度。
 */
import { expect, test } from '@playwright/test'

type Probe = {
  scene: string
  phase: string
  power: boolean
  hvac: { mode: string; cooling: boolean; coolT: number }
  door: { openT: number; released: boolean; bumps: number; fault: string }
  block: boolean
}

/**
 * 版式里的翻页控件。探索台是 `button.play-button`（文字「下一步 ›」），
 * 聚焦/窄版会换成 `.focus-arrow[aria-label=下一步]`——两个都指向同一件事。
 * **不能用 `/下一步/` 选**：作业台的「本步完成，进入下一步 ›」也含这三个字，
 * 会同时命中两个按钮（strict mode 直接报错）。
 */
function next(page: import('@playwright/test').Page) {
  return page.locator('button.play-button, button.focus-arrow[aria-label="下一步"]').first()
}

function probe(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const fn = (window as unknown as { __ops?: () => Probe }).__ops
    return fn ? fn() : null
  })
}

/** 点三维里某个部件。`subject` 取 `driver_desk` / `door` / `hvac`。 */
async function clickPart(
  page: import('@playwright/test').Page,
  subject: string,
  key: string,
): Promise<void> {
  const point = await page.evaluate(
    ({ s, k }) => {
      const reg = (window as unknown as {
        __scenePoints?: Record<string, (key: string) => { x: number; y: number } | null>
      }).__scenePoints
      return reg?.[s]?.(k) ?? null
    },
    { s: subject, k: key },
  )
  expect(point, `${subject}.${key} 没拿到屏幕坐标`).not.toBeNull()
  /* 先悬停确认落点真的压在这个件上：小件（试块、门控按钮）中心偶有被前景挡住，
     直接点会静默失败。偏移量按 12px 十字试一遍，命中就点。 */
  const offsets = [
    [0, 0],
    [0, -10],
    [0, 10],
    [-10, 0],
    [10, 0],
  ]
  /* 两遍扫描：CI 的软件渲染只有 1–2 fps，`pointermove` 可能还在队列里，
     第一遍读到的 `__hoverKey` 是**上一个点**的值。第二遍把等待拉到 240ms 再读一次。 */
  let hit: [number, number] | null = null
  for (const settle of [120, 240]) {
    for (const [dx, dy] of offsets) {
      await page.mouse.move(point!.x + dx, point!.y + dy)
      await page.waitForTimeout(settle)
      const hover = await page.evaluate(() => (window as unknown as { __hoverKey?: string }).__hoverKey ?? '')
      if (hover === key) {
        hit = [dx, dy]
        break
      }
    }
    if (hit) break
  }
  const [dx, dy] = hit ?? [0, 0]
  await page.mouse.click(point!.x + dx, point!.y + dy)
  await page.waitForTimeout(350)
}

/** 上电三件：点钥匙（插入）→ 再点钥匙（右旋）→ 点制动手柄。 */
async function powerOn(page: import('@playwright/test').Page) {
  await clickPart(page, 'driver_desk', 'key')
  await clickPart(page, 'driver_desk', 'key')
  await clickPart(page, 'driver_desk', 'brake')
  await expect.poll(() => probe(page).then((p) => p?.power ?? false), { timeout: 15_000 }).toBe(true)
}

/** 点三维里的 MON 屏打开弹窗。 */
/**
 * 三维画布的读屏标签必须**如实**写清"只能鼠标点"（决策 #62）。
 *
 * 这条不能只在文档里写：`role="img"` 的画布对读屏是一张图，用户 Tab 进来若只听到
 * "点主控钥匙进行操作"，会一直找键盘路径。断言它真的在 DOM 上。
 */
async function expectMouseOnlyLabel(page: import('@playwright/test').Page) {
  const label = await page.locator('.ops__pane canvas.scene__canvas').first().getAttribute('aria-label')
  expect(label ?? '').toContain('仅支持鼠标点击')
}

/**
 * 读空调两台叶轮的角度（`name = 'fan-rotor'`，见 `devices/hvac.ts`）。
 *
 * 为什么读角度而不是截图：静止的风机与转动的风机，单帧画面看起来都可以"很正常"。
 * 只有同一个 `t` 下角度还在变，才证明它真的在转（2026-11-14 本人反馈的正是这个）。
 */
async function fanAngles(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    type Obj = { name: string; rotation: { y: number } }
    const reg = (window as unknown as { __rigs?: Record<string, { parts?: Record<string, unknown> }> }).__rigs
    const fans = reg?.hvac?.parts?.fans as { traverse?: (fn: (o: Obj) => void) => void } | undefined
    if (!fans?.traverse) return null
    const out: number[] = []
    fans.traverse((o) => {
      if (o.name === 'fan-rotor') out.push(o.rotation.y)
    })
    return out
  })
}

/** 通风/制冷运行时，两台风机必须真的在转——这是物理逻辑，不是动画彩蛋。 */
async function expectFansSpinning(page: import('@playwright/test').Page) {
  const start = await fanAngles(page)
  expect(start?.length ?? 0, '空调机组应有两台叶轮').toBe(2)
  await expect
    .poll(
      async () => {
        const now = await fanAngles(page)
        if (!now || !start) return 0
        return Math.max(Math.abs(now[0] - start[0]), Math.abs(now[1] - start[1]))
      },
      { timeout: 10_000, message: '通风跑了十秒，两台风机还是静止的' },
    )
    .toBeGreaterThan(0.2)
}

async function openMon(page: import('@playwright/test').Page) {
  await clickPart(page, 'driver_desk', 'mon')
  await expect(page.locator('.ops__mon')).toBeVisible()
}

async function closeMon(page: import('@playwright/test').Page) {
  await page.locator('.ops__mon-close').click()
  await expect(page.locator('.ops__mon')).toHaveCount(0)
}

test('空调：并列看机组 → 点屏换 MON 下发通风 → 三项确认 → 切制冷五项确认', async ({ page }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('./guide/g_hvac_cooling_desk')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('客室空调制冷试验')

  // --- 第 2 屏：上电（只点三维） ---
  await next(page).click()
  await expect(page.locator('.ops__st').first()).toBeVisible()
  await expectMouseOnlyLabel(page)
  await powerOn(page)
  await expect(page.locator('.ops__st.is-on')).toHaveCount(3)
  await expect(page.locator('.ops__go')).toBeVisible()
  await page.locator('.ops__go').click()

  // --- 第 3 屏：司机台与机组并列；点屏后左栏换成 MON，右侧风机由静止转为运转 ---
  await expect(page.locator('.ops__next')).toContainText('MON')
  await expect(page.locator('.ops__pane canvas.scene__canvas')).toHaveCount(2)
  await expect(page.locator('.ops__pane--mon')).toHaveCount(0)
  // 下发之前：叶轮静止（角度为 0）
  expect(await fanAngles(page)).toEqual([0, 0])

  await clickPart(page, 'driver_desk', 'mon')
  // 左栏换成 MON（不是弹窗），右侧机组还在——这正是本人要的"一边设一边看风机"
  await expect(page.locator('.ops__pane--mon')).toHaveCount(1)
  await expect(page.locator('.hmon')).toBeVisible()
  await expect(page.locator('.ops__mon')).toHaveCount(0)
  await expect(page.locator('.ops__mon-back')).toBeVisible()

  await page.locator('.hmon__key', { hasText: /^通风$/ }).click()
  await page.locator('.hmon__apply').click()
  await expect(page.locator('.hmon')).toContainText('已下发：通风')
  await expect
    .poll(() => probe(page).then((p) => p?.hvac.mode ?? ''), { timeout: 10_000 })
    .toBe('vent')
  // 下发 = 起机：两台风机必须当场转起来（同一页里就能看到差别）
  await expectFansSpinning(page)
  await page.locator('.ops__go').click()

  // --- 第 4 屏：MON 为主（不再显示操纵台），确认三项；后两项在通风模式下不判 ---
  await expect(page.locator('.ops__chip')).toContainText('通风运行')
  await expect(page.locator('.ops__pane--mon')).toHaveCount(1)
  // 这一屏没有司机台画布：只有右侧机组一块
  await expect(page.locator('.ops__pane canvas.scene__canvas')).toHaveCount(1)
  await expect(page.getByRole('tab', { name: '机组状态' })).toHaveAttribute('aria-selected', 'true')

  const ventRows = page.locator('.hmon__hit:not(.hmon__hit--static)')
  await expect(ventRows).toHaveCount(3)
  // 压缩机 / 高压侧压力：本工况不可确认，显示值必须是「—」而不是「未确认」
  const naRows = page.locator('.hmon__row.is-na')
  await expect(naRows).toHaveCount(2)
  await expect(naRows.first()).toContainText('—')
  await expect(page.locator('.hmon__na-note')).toBeVisible()
  await expect(page.locator('.ops__next')).toContainText('不判')

  for (let i = 0; i < 3; i += 1) await ventRows.nth(i).click()
  await expect(page.locator('.ops__st.is-on')).toHaveCount(4)
  await expect(page.locator('.ops__st').last()).toContainText('3/3')
  await page.locator('.ops__go').click()

  // --- 第 5 屏：MON 切制冷（下发即起动），机组出现冷气 + 徽标，稳定后确认五项 ---
  await expect(page.locator('.ops__next')).toContainText('制冷')
  await expect(page.locator('.ops__pane--mon')).toHaveCount(1)
  await page.locator('.hmon__tab', { hasText: '空调设定' }).click()
  await page.locator('.hmon__key', { hasText: /^制冷$/ }).click()
  await page.locator('.hmon__apply').click()
  await expect(page.locator('.hmon')).toContainText('已下发：制冷')
  await expect
    .poll(() => probe(page).then((p) => p?.hvac.cooling ?? false), { timeout: 10_000 })
    .toBe(true)

  // 模式切换要有可见变化：机组徽标转"制冷运行"，并出现冷气（叶轮转速也更快）
  await expect(page.locator('.ops__badge.is-cool')).toContainText('制冷运行')
  const mist = await page.evaluate(() => {
    const g = (window as unknown as { __rigs?: Record<string, { root?: { getObjectByName?: (n: string) => { visible?: boolean } | undefined } }> }).__rigs
    const node = g?.hvac?.root?.getObjectByName?.('cold-mist')
    return node?.visible ?? null
  })
  expect(mist, '制冷时应有送风冷气（cold-mist 组）').toBe(true)

  // 制冷进程 25 秒走完（低帧率下更久），等 coolT 到 1
  await expect
    .poll(() => probe(page).then((p) => p?.hvac.coolT ?? 0), {
      timeout: 90_000,
      message: '制冷进程没有走完',
    })
    .toBeGreaterThan(0.999)

  await expect(page.getByRole('tab', { name: '机组状态' })).toHaveAttribute('aria-selected', 'true')
  const coolRows = page.locator('.hmon__hit:not(.hmon__hit--static)')
  await expect(coolRows).toHaveCount(5)
  for (let i = 0; i < 5; i += 1) await coolRows.nth(i).click()
  await expect(page.locator('.ops__st').last()).toContainText('5/5')
  await expect(page.locator('.ops__go')).toBeVisible()

  expect(errors, `页面抛错：${errors.join(' | ')}`).toEqual([])
})

test('换指导书：空调里上过的电不能带到车门那份', async ({ page }) => {
  await page.goto('./guide/g_hvac_cooling_desk')
  await next(page).click()
  await powerOn(page)
  await expect(page.locator('.ops__st.is-on')).toHaveCount(3)

  // 走 **SPA 导航**（作业库 → 车门那份）。刷新页面会把内存状态一起清掉，
  // 测不出这个 bug；本人遇到的是应用内切换。
  await page.locator('a', { hasText: '作业库' }).first().click()
  await page.locator('.guide-card', { hasText: '车门开关门' }).first().click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('客室车门开关门')
  await next(page).click()
  await expect(page.locator('.ops__st').first()).toBeVisible()
  // 三颗灯必须全灭：每份指导书 = 一次独立试验
  await expect(page.locator('.ops__st.is-on')).toHaveCount(0)
})

test('重新开始：从第 2 步回到第一工步，司机台状态一并复位', async ({ page }) => {
  await page.goto('./guide/g_door_switch_desk')
  await next(page).click()
  await expect(page.locator('.ops__st').first()).toBeVisible()
  await powerOn(page)
  await expect(page.locator('.ops__st.is-on')).toHaveCount(3)

  await page.locator('.ops__reset').click()
  // 回到第一工步：条件表那一页没有作业台，也没有状态灯
  await expect(page.locator('.ops__st')).toHaveCount(0)
  await expect
    .poll(() => page.locator('.ex .topic').first().getAttribute('class').catch(() => ''), { timeout: 10_000 })
    .toContain('active')

  // 再走回第 2 步：三颗灯必须是灭的（不是从上一次试验带过来的）
  await next(page).click()
  await expect(page.locator('.ops__st').first()).toBeVisible()
  await expect(page.locator('.ops__st.is-on')).toHaveCount(0)
  await expect(page.locator('.ops__next')).toContainText('插入主控钥匙')
})

test('车门：MON 确认 → 释放开门 → 点试块 + 关门必须反开 → 试块归位后关到位', async ({ page }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('./guide/g_door_switch_desk')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('客室车门开关门试验')

  // --- 第 2 屏：上电 ---
  await next(page).click()
  await expect(page.locator('.ops__st').first()).toBeVisible()
  await expectMouseOnlyLabel(page)
  await powerOn(page)
  await page.locator('.ops__go').click()

  // --- 第 3 屏：MON 三项确认 ---
  await openMon(page)
  const rows = page.locator('.dmon__hit:not(.dmon__hit--static)')
  await expect(rows).toHaveCount(3)
  for (let i = 0; i < 3; i += 1) await rows.nth(i).click()
  await expect(page.locator('.dmon')).toContainText('三项已确认')
  await closeMon(page)
  await page.locator('.ops__go').click()

  // --- 第 4 屏：点台面「释放」→「开门」 ---
  await clickPart(page, 'driver_desk', 'door_l_release')
  await expect.poll(() => probe(page).then((p) => p?.door.released ?? false)).toBe(true)
  await clickPart(page, 'driver_desk', 'door_l_open')
  await expect
    .poll(() => probe(page).then((p) => p?.door.openT ?? 0), {
      timeout: 40_000,
      message: '门扇没有开到 100%',
    })
    .toBeGreaterThan(0.999)
  await page.locator('.ops__go').click()

  // --- 第 5 屏：点门外侧试块 → 门洞；点关门 → 必须反开 ---
  await clickPart(page, 'door', 'block')
  await expect.poll(() => probe(page).then((p) => p?.block ?? false), { timeout: 10_000 }).toBe(true)
  await clickPart(page, 'driver_desk', 'door_l_close')
  await expect
    .poll(() => probe(page).then((p) => p?.door.bumps ?? 0), {
      timeout: 40_000,
      message: '关门没有触发防夹反开',
    })
    .toBeGreaterThan(0)
  await expect
    .poll(() => probe(page).then((p) => p?.door.openT ?? 0), {
      timeout: 40_000,
      message: '反开后没有回到全开位',
    })
    .toBeGreaterThan(0.99)

  // 第 5 屏到此完成（反开已验证、门回到全开），进入下一步
  await page.locator('.ops__go').click()

  // --- 第 6 屏：正常关门（先撤块，门页不得再反开） ---
  await expect(page.locator('.ops__next')).toContainText('试块')
  // 试块在门洞里时紧挨门扇：`clickPart` 的悬停校正会先挪几像素再点（见上面的说明）
  await clickPart(page, 'door', 'block')
  await expect.poll(() => probe(page).then((p) => p?.block ?? true), { timeout: 10_000 }).toBe(false)
  // 撤块会把反开次数清零（这是会话里的既有口径），所以这里以"清零后的 0"为基准
  await expect.poll(() => probe(page).then((p) => p?.door.bumps ?? -1), { timeout: 10_000 }).toBe(0)
  await expect(page.locator('.ops__next')).toContainText('正常关闭')
  await clickPart(page, 'driver_desk', 'door_l_close')
  // 无障碍物：关门过程中不能出现新的反开
  await expect(page.locator('.ops__next')).not.toContainText('碰到试块', { timeout: 5_000 })
  await expect.poll(() => probe(page).then((p) => p?.door.openT ?? 1), { timeout: 40_000 }).toBeLessThan(0.001)
  await expect.poll(() => probe(page).then((p) => p?.door.bumps ?? -1), { timeout: 10_000 }).toBe(0)
  // 这是**最后一工步**：不该再出现"本步完成，进入下一步"（点了没反应比没按钮更差）
  await expect(page.locator('.ops__go')).toHaveCount(0)

  await openMon(page)
  await page.getByRole('tab', { name: '车门状态' }).click()
  await expect(page.locator('.dmon')).toContainText('8/8')

  expect(errors, `页面抛错：${errors.join(' | ')}`).toEqual([])
})
