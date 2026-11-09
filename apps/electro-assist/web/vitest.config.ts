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
        // 2026-11-10 实测：68.41 语句 / 56.31 分支 / 57.43 函数 / 70.08 行。
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
        // 阈值抬到 66/54/55/67（各留 2.3–3 点余量）。上一次抬到 62/47/50/64 后只过
        // 一天就只剩 2 点余量，说明"留 2 点"本身不够——所以这次同时补了覆盖，
        // 而不是只把数字往上挪。
        //
        // 仍然统计不到的部分：`DeviceScene.vue`（要 WebGLRenderer，0%）靠 E2E 覆盖，
        // 而 E2E 跑构建产物、不插桩。别拿这个数字当"没测过"的证据，也别为了拉高它
        // 写凑数测试。
        thresholds: {
          lines: 67,
          statements: 66,
          branches: 54,
          functions: 55,
        },
      },
    },
  }),
)
