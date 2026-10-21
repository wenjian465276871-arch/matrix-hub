import { expect, test } from '@playwright/test'

/**
 * 三条冒烟路径：
 * 1. 列表 → 正式案例 → 开始引导 → 第 1 步 → 提交 → 第 2 步 → 刷新仍保持；
 * 2. B 命中：现象能检索到条目，并给出"按顺序检查"；
 * 3. B 未覆盖：明确说"未覆盖"，不编造。
 *
 * 不依赖模型调用：用的都是启动时 seed 的已发布案例与知识库。
 */
test('列表 → 引导第 1 步 → 刷新保持进度', async ({ page }) => {
  await page.goto('./')
  await expect(page.getByRole('heading', { name: '作业指导书' })).toBeVisible()

  const formal = page.locator('.guide-card').filter({ hasText: '开关门' }).first()
  await expect(formal).toBeVisible()
  await formal.click()

  await expect(page.getByRole('heading', { level: 1 })).toContainText('开关门')
  await page.getByRole('button', { name: '开始引导作业' }).click()
  await expect(page).toHaveURL(/\/run\/s_/)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('第 1 / 8 步')

  // 第 1 步是「安全条件已确认」人工确认项
  await page.getByRole('checkbox').first().check()
  await page.getByRole('button', { name: '提交本步' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('第 2 / 8 步')

  // 刷新后会话恢复：已提交步骤保留、当前步不倒退
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('第 2 / 8 步')
})

test('B 命中：给出按顺序检查', async ({ page }) => {
  await page.goto('./diagnose')
  await page.getByPlaceholder('例如：门关到一半又自己弹开了').fill('门关到一半又自己弹开了')
  await page.getByRole('button', { name: '开始排查' }).click()

  await expect(page.getByText('按顺序检查').first()).toBeVisible()
  await expect(page.getByText('可能原因').first()).toBeVisible()
})

test('B 未覆盖：明确说未覆盖', async ({ page }) => {
  await page.goto('./diagnose')
  await page.getByPlaceholder('例如：门关到一半又自己弹开了').fill('受电弓升不起来')
  await page.getByRole('button', { name: '开始排查' }).click()

  await expect(page.getByText('未覆盖').first()).toBeVisible()
})
