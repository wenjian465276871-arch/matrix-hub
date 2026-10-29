
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

// 这个 spec 以 ESM 运行，没有 __dirname；用 import.meta.url 反推。
const SHOT = fileURLToPath(new URL('./fixtures/shot.png', import.meta.url))

/**
 * 四条冒烟路径：
 * 1. 列表 → 正式案例 → 开始引导 → 第 1 步 → 提交 → 第 2 步 → 刷新仍保持；
 * 2. B 命中：现象能检索到条目，并给出"按顺序检查"；
 * 3. B 未覆盖：明确说"未覆盖"，不编造；
 * 4. 素材上传：图能进页面、能移除（不上传就不会进生成请求，不花配额）。
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
  await page.getByPlaceholder('例如：门关到一半又自己弹开了').fill('制动缸压力不足，闸瓦间隙大')
  await page.getByRole('button', { name: '开始排查' }).click()

  await expect(page.getByText('未覆盖').first()).toBeVisible()
})

test('B 逐步诊断：判据推进并收敛到结论', async ({ page }) => {  await page.goto('./diagnose')
  await page.getByRole('tab', { name: /逐步诊断/ }).click()
  await page.getByPlaceholder('例如：门关到一半又自己弹开了').fill('门到关闭位不锁闭')
  await page.getByRole('button', { name: '开始逐步诊断' }).click()

  await expect(page.getByText('排查条目')).toBeVisible()
  await expect(page.locator('.current__action')).toBeVisible()

  // 首项可能是实测值，也可能是确认项：两种都走通，证明服务端掌权
  const numberInput = page.locator('.measure input')
  if (await numberInput.count()) {
    await numberInput.fill('0.2') // 低于下限 → 服务端判超差
    await page.getByRole('button', { name: '提交实测值' }).click()
  } else {
    await page.getByRole('button', { name: '异常' }).click()
  }

  await expect(page.locator('.conclusion')).toBeVisible()
  await expect(page.getByText('已定位到异常点')).toBeVisible()
  await expect(page.locator('.dstep').first()).toBeVisible()
})

test('素材上传：图能进页面，也能移除', async ({ page }) => {
  await page.goto('./new')
  await expect(page.getByRole('heading', { name: '生成作业指导书' })).toBeVisible()

  // 只上传、不提交生成：不花配额，也不依赖模型
  await page.setInputFiles('input[type="file"]', SHOT)
  const item = page.locator('.asset-item')
  await expect(item).toHaveCount(1)
  await expect(item.locator('img')).toBeVisible()
  await expect(item.locator('input')).toBeEditable()

  await page.getByRole('button', { name: '移除' }).click()
  await expect(page.locator('.asset-item')).toHaveCount(0)
})
