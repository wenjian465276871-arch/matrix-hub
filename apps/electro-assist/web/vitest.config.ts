import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

// 组件单测的配置：复用 vite 的解析规则（base / 插件 / 别名），只覆盖 test 段。
// 用 happy-dom 而不是 jsdom：快，且 sessionStorage / Teleport / 焦点这些够用。
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'happy-dom',
      include: ['src/**/*.spec.ts'],
      restoreMocks: true,
      // 不设 globals：显式 import { describe, it, expect } 更清晰，
      // 也避免 tsconfig 里再堆一份全局类型。
      coverage: {
        provider: 'v8',
        reporter: ['text', 'html'],
        // 只统计运行时代码：类型文件、纯声明、测试自身不计
        include: ['src/**/*.{ts,vue}'],
        exclude: ['src/**/*.spec.ts', 'src/types.ts', 'src/env.d.ts', 'src/main.ts'],
        // 阈值是**防退化线**，不是质量目标。
        // 2026-11-10（整页阅读器）实测：70.14 语句 / 56.17 分支 / 58.99 函数 / 71.67 行。
        // 涨上来的路径：① 2026-11-06 四个千行文件补行为测试并抽纯逻辑
        // （guidepatch / runeval / recordfmt 三个 lib 分别 86% / 100% / 100%）、
        // 三个页面壳补测试、13 个视觉原语补参数校验测试；② 2026-11-09 三台设备的
        // 三维构建契约测试（devices/builders.spec.ts，19 条）把两千多行几何拉进统计，
        // 顺带抓到 `pantograph` 漏登记 `parts.lamp`；③ 2026-11-10 评审 P3-3——
        // 把演示页的读数抽成 `lib/demoreads.ts`（纯函数，18 条用例，100% 覆盖），
        // 并用 stub 掉 WebGL 子组件的方式给 `DeviceDemoView.vue` 补了 10 条交互用例。
        //
        // 为什么抽而不是"多写点断言"：那些读数与 `figures/devices/*.ts` 共享同一套
        // 时序常量（代码里写着"改一处要改两处"），副本必须有测试才敢改。
        //
        // 本轮新增的覆盖来自三块纯逻辑与两处组件：`lib/paging.ts`（页数/边界/位置记忆，
        // 13 条）、`StepPager.vue`（11 条，含键盘翻页、按需挂载、打印铺开）、
        // `figures/devices/builders.spec.ts` 自动把四台新工具（34 个部件键）纳入契约，
        // 以及 `demoreads` 新增的四组读数。
        //
        // 阈值抬到 68/54/57/69（各留 2–2.7 点余量）。上一次抬到 66/54/55/67 后
        // 只剩 2.3 点余量，这次同样按"实测 − 2"定，不再凭感觉往高里写。
        //
        // 仍然统计不到的部分：`DeviceScene.vue`（要 WebGLRenderer，0%）靠 E2E 覆盖，
        // 而 E2E 跑构建产物、不插桩。别拿这个数字当"没测过"的证据，也别为了拉高它
        // 写凑数测试。
        thresholds: {
          lines: 69,
          statements: 68,
          branches: 54,
          functions: 57,
        },
      },
    },
  }),
)
