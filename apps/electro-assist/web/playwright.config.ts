import { defineConfig } from '@playwright/test'

/**
 * E2E 冒烟：只覆盖"用户真会走的三条路"，不追求覆盖率。
 *
 * 前提（CI 与本地一致）：
 *   API   http://127.0.0.1:8001（临时 DB，启动时自动 seed 4 份已发布案例）
 *   Web   http://127.0.0.1:4173/apps/electro-assist/（vite preview，/api 反代到 8001）
 *
 * 本地用系统 Edge 可免下载浏览器：
 *   E2E_CHANNEL=msedge npm run test:e2e
 */
const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:4173/apps/electro-assist/'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    ...(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {}),
  },
})
