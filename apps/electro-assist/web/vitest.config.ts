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
    },
  }),
)
