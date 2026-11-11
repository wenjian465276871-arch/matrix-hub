import { expect, test } from '@playwright/test'

/**
 * 搜索与草稿修正（2026-11-01 补齐）。
 *
 * **为什么这里不测"发布"**：发布是不可逆状态变更，用完即废——一份草稿只能发布
 * 一次，E2E 每跑一遍就得换一份草稿，本地重跑必然踩到"已发布"。发布的完整边界
 * （口令 401、缺口 409、已发布 409、限流 429）由后端契约测试 `test_revision.py`
 * 的 11 条覆盖，那里可以随意造库，比 UI 层可靠得多。
 *
 * 修正只改内容、不改状态，可以反复跑，所以放在 E2E 里验证：
 * 口令 → 编辑态 → 改字段 → 保存 → 刷新后仍在（证明真的落库，不是只改了内存）。
 *
 * 依赖：`ELECTRO_PASSCODE` 已配、库里有一份草稿（`E2E_DRAFT_ID`）。
 * 不满足时跳过，不是失败——本地没准备环境不该报红。
 */

const DRAFT_ID = process.env.E2E_DRAFT_ID || 'g_e2e_draft_001'
const PASSCODE = 'e2e-pass'
const REVISE = process.env.E2E_REVISE === '1'

test('搜索：按关键词过滤列表并给出命中数', async ({ page }) => {
  await page.goto('./')
  await expect(page.getByRole('heading', { name: '作业指导书' })).toBeVisible()

  const search = page.getByLabel('搜索指导书')
  await search.fill('空调')

  // 防抖 250ms 后才会发请求，状态行出现即说明结果已回。
  // 用 id 而不是文本：同一句话同时出现在读屏播报区（sr-only）与状态行里，
  // 按文本定位会撞上 strict mode。
  await expect(page.locator('#search-status')).toBeVisible()
  await expect(page.locator('.guide-card')).toHaveCount(1)
  await expect(page.locator('.guide-card').first()).toContainText('空调')

  // 搜索词进 URL：刷新后仍然是过滤后的视图
  await expect(page).toHaveURL(/[?&]q=/)
  await page.reload()
  await expect(page.locator('.guide-card')).toHaveCount(1)
})

test('搜索：没有匹配时给空状态，可一键清空', async ({ page }) => {
  await page.goto('./')
  await page.getByLabel('搜索指导书').fill('这个关键词一定不存在')

  await expect(page.getByText(/没有匹配/).first()).toBeVisible()
  await page.getByRole('button', { name: '清空搜索' }).first().click()
  await expect(page.locator('.guide-card').first()).toBeVisible()
})

test.describe('草稿修正', () => {
  test.skip(!REVISE, '需要草稿与口令')

  test('验证口令 → 改标题 → 保存 → 刷新仍在', async ({ page, request }) => {
    const stamp = Date.now().toString(36)
    const newTitle = `E2E 修正-${stamp}`

    // 前置条件用接口判断（body 只读一次：先 text 再 json 会拿到空值）。
    const probe = await request.get(`/api/electro/guides/${DRAFT_ID}`)
    test.skip(probe.status() !== 200, '草稿不存在：先 seed 一份')
    const snapshot = JSON.parse(await probe.text()) as { status: string }
    test.skip(snapshot.status !== 'draft', '这份已经是发布状态，改不了')

    // 草稿编辑只在阅读器（/read）里：探索台不承载长表单。
    await page.goto(`./guide/${DRAFT_ID}/read`)
    await expect(page.locator('.draft-banner')).toBeVisible()

    // 口令是修正的前置：没有令牌先展开口令面板，验完自动进编辑态
    await page.getByRole('button', { name: '修正内容' }).click()
    await page.getByLabel('口令').fill(PASSCODE)
    await page.getByRole('button', { name: '验证口令' }).click()

    const title = page.getByLabel('标题', { exact: true })
    await expect(title).toBeVisible()
    await title.fill(newTitle)
    await page.getByRole('button', { name: '保存修正' }).click()
    await expect(page.locator('.revise__ok')).toContainText('已保存')

    // 刷新是这条用例的重点：标题还在，说明 PATCH 真的写了库，
    // 而不只是前端把 guide 对象改了一下。
    await page.reload()
    await expect(page.getByRole('heading', { level: 1 })).toContainText(newTitle)
  })
})
