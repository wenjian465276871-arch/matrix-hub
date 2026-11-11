import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, onErrorCaptured } from 'vue'
import BakedFigure from './BakedFigure.vue'

/**
 * baked_figure：指导书主图（离线烘焙的静态图）。
 *
 * 要锁三件事：
 * 1. **BASE_URL 必须拼上**。站点挂在 `/apps/electro-assist/` 下，写死 `/figures/...`
 *    在开发服务器上是 404、在线上也是 404，而页面看起来只是"图没加载出来"。
 * 2. **alt 必须原样传下去**。图是内容不是装饰，读屏用户靠它。
 * 3. **坏路径必须抛错**，交给 GuideFigure 的 onErrorCaptured 降级成文字，
 *    不能静默渲染一张空白图。
 */
afterEach(() => {
  vi.unstubAllEnvs()
})

function mountWith(params: Record<string, string>) {
  return mount(BakedFigure, { props: { params } })
}

describe('baked_figure', () => {
  it('把 BASE_URL 拼在站内路径前面', () => {
    vi.stubEnv('BASE_URL', '/apps/electro-assist/')
    const w = mountWith({ src: '/figures/pantograph/step1.webp', alt: '受电弓落弓状态' })
    const img = w.get('img')
    expect(img.attributes('src')).toBe('/apps/electro-assist/figures/pantograph/step1.webp')
  })

  it('根路径部署时不重复斜杠', () => {
    vi.stubEnv('BASE_URL', '/')
    const w = mountWith({ src: '/figures/pantograph/step1.webp', alt: 'x' })
    expect(w.get('img').attributes('src')).toBe('/figures/pantograph/step1.webp')
  })

  it('alt 原样输出，并且是懒加载', () => {
    const w = mountWith({ src: '/figures/a.webp', alt: '弓头碳滑板磨耗到限标记' })
    const img = w.get('img')
    expect(img.attributes('alt')).toBe('弓头碳滑板磨耗到限标记')
    expect(img.attributes('loading')).toBe('lazy')
    expect(img.attributes('decoding')).toBe('async')
  })

  it('相对路径直接抛错（不是静默 404）', () => {
    expect(() => mountWith({ src: 'figures/a.webp', alt: 'x' })).toThrow()
  })

  it('图片加载失败时抛错，图片被移除并交给上层降级', async () => {
    /* 用一层和 GuideFigure 一样的 onErrorCaptured 包住：
       生产里图片加载失败不能炸掉整页，而是让上层显示 fallback_text。
       这里断言两件事——错误确实抛出、图片节点确实消失。 */
    const caught: unknown[] = []
    const Host = defineComponent({
      setup() {
        onErrorCaptured((err) => {
          caught.push(err)
          return false
        })
        return () => h(BakedFigure, { params: { src: '/figures/a.webp', alt: 'x' } })
      },
    })
    const w = mount(Host)
    await w.get('img').trigger('error')
    expect(caught).toHaveLength(1)
    expect(w.find('img').exists()).toBe(false)
  })
})
