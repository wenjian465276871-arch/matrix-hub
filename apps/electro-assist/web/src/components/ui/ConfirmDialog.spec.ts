import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import ConfirmDialog from './ConfirmDialog.vue'

/**
 * ConfirmDialog 的契约（写在组件注释里，这里是它的可执行版本）：
 * 1. 打开时焦点落在**取消**——破坏性操作不能默认停在确认上；
 * 2. Esc 关闭 = 取消，不是确认；
 * 3. busy 时两个按钮都禁用、Esc 不生效；
 * 4. 点遮罩空白处 = 取消，点面板内部不算。
 *
 * 用 attachTo: document.body 而不是默认挂载：Teleport 到 body，且焦点相关断言
 * 必须有真实节点。
 */

let wrapper: ReturnType<typeof mount> | null = null

function open(props: Record<string, unknown> = {}) {
  wrapper = mount(ConfirmDialog, {
    props: { title: '删除这份草稿？', hint: '删除后不可恢复', ...props },
    attachTo: document.body,
  })
  return wrapper
}

function panel(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!el) throw new Error('dialog 没渲染出来')
  return el
}

function buttons(): HTMLButtonElement[] {
  return Array.from(panel().querySelectorAll('button'))
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('ConfirmDialog', () => {
  it('渲染标题与提示，并带 modal 语义', () => {
    open()
    expect(panel().getAttribute('aria-modal')).toBe('true')
    expect(panel().textContent).toContain('删除这份草稿？')
    expect(panel().textContent).toContain('删除后不可恢复')
  })

  it('打开后焦点落在取消按钮，不是确认', async () => {
    open()
    await nextTick()
    await nextTick()
    const [cancel] = buttons()
    expect(document.activeElement).toBe(cancel)
  })

  it('点取消与点确认各自 emit 对应事件', async () => {
    open()
    const [cancel, confirm] = buttons()
    cancel.click()
    confirm.click()
    expect(wrapper?.emitted('cancel')).toHaveLength(1)
    expect(wrapper?.emitted('confirm')).toHaveLength(1)
  })

  it('busy 时两个按钮都禁用，确认文案换成「处理中…」', () => {
    open({ busy: true })
    const [cancel, confirm] = buttons()
    expect(cancel.disabled).toBe(true)
    expect(confirm.disabled).toBe(true)
    expect(confirm.textContent).toContain('处理中…')
  })

  it('Esc 关闭 = 取消', async () => {
    open()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(wrapper?.emitted('cancel')).toHaveLength(1)
    expect(wrapper?.emitted('confirm')).toBeUndefined()
  })

  it('busy 时 Esc 不生效，避免重复提交', async () => {
    open({ busy: true })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(wrapper?.emitted('cancel')).toBeUndefined()
  })

  it('点遮罩空白处 = 取消，点面板内部不算', async () => {
    open()
    const overlay = document.querySelector<HTMLElement>('.dialog-overlay')
    if (!overlay) throw new Error('overlay 没渲染出来')
    panel().click()
    expect(wrapper?.emitted('cancel')).toBeUndefined()
    overlay.click()
    expect(wrapper?.emitted('cancel')).toHaveLength(1)
  })

  it('卸载后不残留 keydown 监听（不会误吞后续页面的 Esc）', () => {
    const w = open()
    w.unmount()
    wrapper = null
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w.emitted('cancel')).toBeUndefined()
  })
})
