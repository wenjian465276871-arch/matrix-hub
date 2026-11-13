/**
 * 升弓试验样板：六屏真的能走完，且联锁真的会拦。
 *
 * ## 为什么必须有这条（第六轮评审 P2-3 / R14-2）
 *
 * 这是全站交互密度最高的一页：六个状态灯、MON 三页签五项确认、选弓、按住 4.6 秒
 * 才升到位、第 6 屏读网压。而它的全部覆盖此前只有 jsdom 组件用例——**组件用例测的是
 * "点了函数返回什么"，不是"页面上真的发生了什么"**。翻页会不会丢状态、三维画布会不会
 * 压根没建起来、第 6 屏读数对不对，只有端到端能答。
 *
 * ## 两条用例各钉一件事
 *
 * 1. **正路**：状态灯变蓝 → 三页签五项确认 → 选弓 → 按住升弓 → 第 6 屏「升起 / 25.1」。
 *    一条走完，任何一环断掉都红。
 * 2. **反路**：只确认第一个页签（3/5）就去升弓 —— 第 5 步**必须拒绝**，并且点名缺哪几项。
 *    这条比正路更重要：联锁如果退化成"点一下就升"，正路照样全绿。
 *
 * ## 为什么不断言三维像素
 *
 * CI runner 没有 GPU，WebGL 可能拿不到上下文。这里断言的是**状态与文案**
 * （`aria-pressed`、状态条、MON 读数），三维建不起来时这些照样成立——
 * 三维本身由 `demo.spec.ts` 那两条盯（画布有尺寸或明确降级）。
 */
import { expect, test } from '@playwright/test'

const GUIDE = './guide/g_pantograph_raise_test'

/** 下一步。版式里的按钮名就是「下一步 ›」。 */
function next(page: import('@playwright/test').Page) {
  return page.getByRole('button', { name: /下一步/ })
}

/** 点某个状态灯并断言它变蓝（`aria-pressed` 是"做过了"的唯一机读口径）。 */
async function press(page: import('@playwright/test').Page, name: string) {
  const button = page.getByRole('button', { name })
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
}

/** 把 MON 当前页签上的确认行全部点一遍。 */
async function confirmTab(page: import('@playwright/test').Page, tab: string) {
  await page.getByRole('tab', { name: tab }).click()
  const rows = page.locator('.mon__hit')
  const count = await rows.count()
  expect(count, `${tab} 页签应有可确认行`).toBeGreaterThan(0)
  for (let i = 0; i < count; i += 1) {
    await rows.nth(i).click()
  }
}

test('六屏走完：三灯 → MON 五项 → 选弓 → 升弓到位 → 第 6 屏确认网压', async ({ page }) => {
  // 三维建场景 + 升弓动画 4.6s + 六屏翻页，默认 30s 不够
  test.setTimeout(90_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto(GUIDE)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('受电弓升弓试验')

  // --- 第 2 屏：上电激活（三个状态灯） ---
  await next(page).click()
  await expect(page.locator('.ops__btn').first()).toBeVisible()
  await press(page, '钥匙插入')
  await press(page, '钥匙右旋')
  await press(page, '手柄快速位')
  // 上电后状态条要说"可升弓"，而不是只把按钮染色
  await expect(page.locator('.ops__chip')).toContainText('MON')

  // --- 第 3 屏：MON 三页签五项确认 ---
  await next(page).click()
  await expect(page.getByRole('tab', { name: '电源电压' })).toBeVisible()
  for (const tab of ['电源电压', '车辆信息', '远程控制切除']) {
    await confirmTab(page, tab)
  }
  await page.getByRole('tab', { name: '电源电压' }).click()
  await expect(page.locator('.mon')).toContainText('五项已确认')

  // --- 第 4 屏：选弓 ---
  await next(page).click()
  await expect(page.locator('.ops__btn').first()).toBeVisible()
  await press(page, /选弓/)
  // 状态灯文案会带上选中的单元（`选弓 2U`），这是"选弓真的生效"的机读口径
  await expect(page.getByRole('button', { name: /选弓 2U/ })).toBeVisible()

  // --- 第 5 屏：按住升弓旋钮 ---
  await next(page).click()
  await page.getByRole('button', { name: '按住升弓旋钮' }).click()
  // 升到位要 4.6 秒；状态条是"真的升上去了"的唯一文字口径
  await expect(page.locator('.ops__chip')).toContainText('升弓到位', { timeout: 20_000 })
  await expect(page.getByRole('button', { name: '松开旋钮' })).toBeVisible()

  // --- 第 6 屏：确认网压 ---
  await next(page).click()
  const monitor = page.locator('.mon')
  await expect(monitor).toContainText('升起')
  await expect(monitor).toContainText('25.1')

  expect(errors, `页面抛错：${errors.join(' | ')}`).toEqual([])
})

test('联锁：只确认一个页签（3/5）就去升弓，第 5 步必须拒绝并点名缺项', async ({ page }) => {
  test.setTimeout(90_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto(GUIDE)

  // 上电（这一步不能省：MON 没电时屏是暗的，确认动作本来就会被拒）
  await next(page).click()
  await expect(page.locator('.ops__btn').first()).toBeVisible()
  await press(page, '钥匙插入')
  await press(page, '钥匙右旋')
  await press(page, '手柄快速位')

  // 只确认第一个页签 —— 车辆信息页的 EGS / VCB 与远程控制切除页两项故意不确认。
  // 注意别断言精确的 `3/5`：电源电压页有三行，但第三行（蓄电池电压）是参考行、
  // 不带确认键，点不动。真正被确认的是 2 条，所以只断言"没确认完"。
  await next(page).click()
  await expect(page.getByRole('tab', { name: '电源电压' })).toBeVisible()
  await confirmTab(page, '电源电压')
  await expect(page.locator('.mon')).toHaveText(/已确认 [1-4]\/5/)

  // 选弓照常可以（选弓不依赖 MON 五项）
  await next(page).click()
  await expect(page.locator('.ops__btn').first()).toBeVisible()
  await press(page, /选弓/)

  // 发升弓指令：必须被拒，且要点名缺哪几项
  await next(page).click()
  const knob = page.getByRole('button', { name: '按住升弓旋钮' })
  await knob.click()

  const toast = page.locator('.ops__toast')
  await expect(toast).toContainText('MON 确认未完成')
  await expect(toast).toContainText('受电弓远程切除')

  // 按钮文案不许变成"松开旋钮"——那意味着升弓指令真的发出去了
  await expect(knob).toBeVisible()
  await expect(page.locator('.ops__chip')).not.toContainText('升弓到位')

  expect(errors, `页面抛错：${errors.join(' | ')}`).toEqual([])
})
