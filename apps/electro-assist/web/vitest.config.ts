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
        // 2026-11-06 实测：13.8 行 / 11.52 分支 / 9.74 函数 / 12.99 语句。
        // 之所以这么低，是因为只有 NewGuideView（49.6%）和两个 lib 模块有单测；
        // 其余视图与 13 个视觉原语靠 26 条 E2E 覆盖，而 E2E 不计入这份统计
        // （Playwright 跑的是构建产物，不插桩）。别拿这个数字当"没测过"的证据，
        // 也别为了拉高它去写只走一遍代码的凑数测试。
        thresholds: {
          lines: 13,
          statements: 12,
          branches: 11,
          functions: 9,
        },
      },
    },
  }),
)
