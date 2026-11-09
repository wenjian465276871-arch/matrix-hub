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
        // 2026-11-09 实测：64.49 语句 / 49.37 分支 / 52.55 函数 / 66.26 行。
        // 涨上来的路径：① 2026-11-06 四个千行文件补行为测试并抽纯逻辑
        // （guidepatch / runeval / recordfmt 三个 lib 分别 86% / 100% / 100%）、
        // 三个页面壳补测试（72% / 90% / 96%）、13 个视觉原语补参数校验测试；
        // ② 2026-11-09 三台设备的三维构建契约测试（devices/builders.spec.ts，19 条）
        // 把两千多行几何代码拉进统计——那些函数是直筒子代码，构建一次就跑满，
        // 顺带抓到 `pantograph` 漏登记 `parts.lamp` 的静默失效。
        // 阈值跟着实测上抬到 62/47/50/64（各留 2 点余量）：留在 54 那一档，
        // 这批新代码掉 10 个点也不会红，门禁等于没长眼睛。
        // 仍然统计不到的部分：DeviceScene.vue（要 WebGL 渲染器）与 DeviceDemoView.vue，
        // 靠 26 条 E2E 覆盖，而 E2E 跑构建产物、不插桩。
        // 别拿这个数字当"没测过"的证据，也别为了拉高它写凑数测试。
        thresholds: {
          lines: 64,
          statements: 62,
          branches: 47,
          functions: 50,
        },
      },
    },
  }),
)
