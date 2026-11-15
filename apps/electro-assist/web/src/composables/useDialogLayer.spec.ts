/** 弹层焦点纪律的单测（R24-3）。
 *
 *  钉三件事，都是 `axe` 抓不到的：① 打开后焦点进得来；② Tab / Shift+Tab 出不去；
 *  ③ 关闭后焦点回得去、滚动锁解得掉。第四条是"事件被吞掉"——层里的 Esc 必须
 *  `stopPropagation`，否则页面上别的 Esc 监听（作业台那套）会把另一层也关掉。
 */
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick, ref } from 'vue'

import { useDialogLayer } from './useDialogLayer'

const Host = defineComponent({
  setup() {
    const open = ref(false)
    const panel = ref<HTMLElement | null>(null)
    const escapes = ref(0)
    useDialogLayer(open, panel, {
      onEscape: () => {
        escapes.value += 1
        open.value = false
      },
    })
    return { open, panel, escapes }
  },
  template: `
    <div>
      <button id="trigger" @click="open = true">打开</button>
      <div v-if="open" id="layer" ref="panel" role="dialog" aria-modal="true" tabindex="-1">
        <button id="a">A</button>
        <button id="b">B</button>
      </div>
    </div>
  `,
})

let wrapper: ReturnType<typeof mount> | null = null

function key(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
}

async function openLayer(): Promise<void> {
  const trigger = wrapper!.get('#trigger').element as HTMLElement
  trigger.focus()
  await wrapper!.get('#trigger').trigger('click')
  await nextTick()
  await nextTick()
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.style.overflow = ''
})

describe('useDialogLayer', () => {
  it('打开后焦点落到层内第一个可聚焦元素', async () => {
    wrapper = mount(Host, { attachTo: document.body })
    await openLayer()
    expect(document.activeElement?.id).toBe('a')
  })

  it('最后一个元素上按 Tab 回到第一个（不逃逸到页面）', async () => {
    wrapper = mount(Host, { attachTo: document.body })
    await openLayer()
    ;(document.getElementById('b') as HTMLElement).focus()
    document.dispatchEvent(key('Tab'))
    expect(document.activeElement?.id).toBe('a')
  })

  it('第一个元素上按 Shift+Tab 到最后一个', async () => {
    wrapper = mount(Host, { attachTo: document.body })
    await openLayer()
    ;(document.getElementById('a') as HTMLElement).focus()
    document.dispatchEvent(key('Tab', { shiftKey: true }))
    expect(document.activeElement?.id).toBe('b')
  })

  it('焦点被点到层外时，下一次 Tab 被拽回层内', async () => {
    wrapper = mount(Host, { attachTo: document.body })
    await openLayer()
    ;(document.getElementById('trigger') as HTMLElement).focus()
    document.dispatchEvent(key('Tab'))
    expect(document.activeElement?.id).toBe('a')
  })

  it('Esc 关闭并吞掉事件（不冒泡到页面上别的 Esc 监听）', async () => {
    wrapper = mount(Host, { attachTo: document.body })
    await openLayer()

    const outer = vi.fn()
    window.addEventListener('keydown', outer)
    document.dispatchEvent(key('Escape'))
    window.removeEventListener('keydown', outer)

    expect((wrapper.vm as unknown as { escapes: number }).escapes).toBe(1)
    expect(outer).not.toHaveBeenCalled()
    await nextTick()
    expect(wrapper.find('#layer').exists()).toBe(false)
  })

  it('关闭后焦点回到触发元素，滚动锁解除', async () => {
    wrapper = mount(Host, { attachTo: document.body })
    await openLayer()
    expect(document.body.style.overflow).toBe('hidden')

    document.dispatchEvent(key('Escape'))
    await nextTick()
    await nextTick()

    expect(document.body.style.overflow).toBe('')
    expect(document.activeElement?.id).toBe('trigger')
  })

  it('卸载时清理：层的 Esc 不再响应，滚动锁也不留', async () => {
    wrapper = mount(Host, { attachTo: document.body })
    await openLayer()
    wrapper.unmount()
    wrapper = null
    expect(document.body.style.overflow).toBe('')

    const outer = vi.fn()
    window.addEventListener('keydown', outer)
    document.dispatchEvent(key('Escape'))
    window.removeEventListener('keydown', outer)
    expect(outer).toHaveBeenCalledTimes(1)
  })
})
