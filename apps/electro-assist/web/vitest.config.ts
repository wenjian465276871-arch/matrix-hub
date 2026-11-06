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
        // 2026-11-06 实测：25.69 语句 / 20.92 分支 / 18.86 函数 / 27.18 行。
        // 比首版（13/12/11/9）翻倍，靠三件事：GuideView 的 7 条行为测试、
        // 素材归位抽成 AttachPanel 后测到 97%、以及把修正逻辑抽成 guidepatch 纯函数
        // （86.56%，纯函数最好测也最该测——它漏一个字段就是静默丢数据）。
        // 仍然偏低的原因：DiagnoseView / RunView / LibraryView / RecordView 与
        // 13 个视觉原语没有单测，靠 26 条 E2E 覆盖，而 E2E 跑构建产物、不插桩，
        // 不计入这份统计。别拿这个数字当"没测过"的证据，也别为了拉高它写凑数测试。
        thresholds: {
          lines: 25,
          statements: 23,
          branches: 18,
          functions: 16,
        },
      },
    },
  }),
)
