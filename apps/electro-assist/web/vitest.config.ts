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
        // 2026-11-06 实测：32.77 语句 / 27.81 分支 / 25.66 函数 / 34.23 行。
        // 从首版 13/12/11/9 涨上来靠四件事：GuideView 与 RunView 的行为测试、
        // 把修正逻辑（guidepatch）与判据求值（runeval）抽成纯函数各测到 86%/100%、
        // 素材归位抽成 AttachPanel 后测到 97%。
        // 仍然偏低的原因：DiagnoseView / LibraryView / RecordView 与 13 个视觉原语
        // 没有单测，靠 26 条 E2E 覆盖，而 E2E 跑构建产物、不插桩，不计入这份统计。
        // 别拿这个数字当"没测过"的证据，也别为了拉高它写凑数测试。
        thresholds: {
          lines: 32,
          statements: 30,
          branches: 26,
          functions: 24,
        },
      },
    },
  }),
)
