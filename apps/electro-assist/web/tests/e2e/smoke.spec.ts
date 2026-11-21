
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

  // 2026-11-17：该样例已**下架**（不再在库里展示），改用 id 直接打开。
  // 下架样例仍可按链接访问（`test_draft_guide_can_be_run_by_link` 守这条），
  // 本用例验的是阅读器与 A1 的行为，不是列表页入口。
  await page.goto('./guide/g_door_switch_formal_001')

  await expect(page.getByRole('heading', { level: 1 })).toContainText('开关门')

  // 2026-11-11：/guide/:id 默认是探索台，分页阅读器在 /read。
  // 本用例验的是阅读器里的流程，从探索台顶栏的「打印视图」进去。
  await page.getByRole('button', { name: '打印视图' }).click()
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

/**
 * 首屏那颗主按钮是"第一屏的承诺"：它写「从车门开始看」，就得真的落到一份能打开的车门指导书。
 *
 * 2026-11-21 加：按钮的目标是按**库里实际有的样例**算出来的（旗舰样例下架就退回第一条），
 * 单测守文案与目标 id，这条守"真点下去有东西"——死链在这套代码里不会 404，
 * 路由对未知 id 也回 200 再走 error 分支，只有点一次才知道。
 */
test('首屏主按钮落到一份能打开的演示样例', async ({ page }) => {
  await page.goto('./')

  // 顶栏中间那块只说「你在哪个模块」，小字那行不渲染——
  // 原来这里写「作业库 / 作业指导书」，与页面 h1「电气调试作业指导书」
  // 在同一个位置说了三句近义的话（2026-11-21 本人指出）。
  await expect(page.locator('.now strong')).toHaveText('作业库')
  await expect(page.locator('.now small')).toHaveCount(0)

  const start = page.locator('.lib__start')
  await expect(start).toHaveText('从车门开始看 →')

  await start.click()
  await expect(page).toHaveURL(/\/guide\/g_door_switch_desk$/)
  // 真渲染出探索台的工步，而不是 loading / error 空壳
  await expect(page.locator('.ex .topic').first()).toBeVisible()
})

test('B 命中：给出按顺序检查', async ({ page }) => {
  await page.goto('./diagnose')
  await page.getByPlaceholder('例如：门关到一半又自己弹开了').fill('门关到一半又自己弹开了')
  await page.getByRole('button', { name: '开始排查' }).click()

  await expect(page.getByText('按顺序检查').first()).toBeVisible()
  await expect(page.getByText('可能原因').first()).toBeVisible()
  // 计划 §2.3：原因带权重；检索侧只叫"匹配度"（相似度），"置信度"留给逐步诊断的结论
  await expect(page.locator('.results__meta')).toContainText('匹配度')
  await expect(page.locator('.results__meta')).not.toContainText('置信度')
  await expect(page.locator('.cause__weight').first()).toBeVisible()
})

test('B 未覆盖：明确说未覆盖', async ({ page }) => {
  await page.goto('./diagnose')
  // 2026-11-19 制动/雨刷已收录，未覆盖用例改用仍未收录的牵引子系统
  await page.getByPlaceholder('例如：门关到一半又自己弹开了').fill('牵引变流器报过流，主断路器跳闸')
  await page.getByRole('button', { name: '开始排查' }).click()

  await expect(page.getByText('未覆盖').first()).toBeVisible()
})

test('B 制动：新增子系统能出排查顺序', async ({ page }) => {
  await page.goto('./diagnose')
  await page.getByPlaceholder('例如：门关到一半又自己弹开了').fill('制动缸不缓解，闸瓦抱死车轮')
  await page.getByRole('button', { name: '开始排查' }).click()

  await expect(page.getByText('按顺序检查').first()).toBeVisible()
  await expect(page.getByText('制动缸不缓解').first()).toBeVisible()
})

test('B 逐步诊断：判据推进并收敛到结论', async ({ page }) => {
  await page.goto('./diagnose')
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
  // 结论必须显示置信度与依据，而不是只给一句原因
  await expect(page.locator('.conclusion__confidence')).toContainText('置信度')
  await expect(page.getByText('结论依据')).toBeVisible()
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

test('结构化预检：不调模型也能看出缺什么', async ({ page }) => {
  await page.goto('./new')
  await page.fill(
    '#process-text',
    '工序：门机螺栓复紧\n工位：3 号车门\n工具：力矩扳手、套筒\n1. 按对角顺序复紧四颗螺栓，力矩 0.7–0.9 N·m。\n2. 复查防松标记。\n安全提示：复紧前确认门机断电。',
  )
  await page.getByRole('button', { name: '结构化预检' }).click()
  await expect(page.locator('.precheck')).toBeVisible()
  await expect(page.locator('.precheck')).toContainText('识别到 2 步')
  await expect(page.locator('.precheck')).toContainText('字段齐全')
  // 工位不再只回给前端：预检解析后要能带进生成请求
  await expect(page.getByLabel('工位')).toHaveValue('3 号车门')
})
