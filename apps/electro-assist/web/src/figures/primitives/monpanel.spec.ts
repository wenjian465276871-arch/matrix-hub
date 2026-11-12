/** mon_panel：可点确认的 MON 屏。
 *
 *  锁四件事：
 *  1. 三页都能切，页内行数与截图一致；
 *  2. 点一行就记一行，页脚计数跟着走（这是"核对过"的证据）；
 *  3. `status` 模式只读——第 6 步不该让人再点一遍；
 *  4. 远程页读的是会话状态（选了 2U 就显示 2U），不是写死的文案。
 */
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'

import MonPanel from './MonPanel.vue'
import { reset, session } from '../../lib/panto-session'

function mountPanel(tab = 'power', mode = 'check') {
  return mount(MonPanel, {
    props: { params: { scene: 'pantograph_raise', tab, mode }, label: 'MON' },
  })
}

describe('mon_panel', () => {
  beforeEach(() => reset())

  it('默认停在电源电压页，三行（控制电压 / MR / 蓄电池）', () => {
    const w = mountPanel()
    const rows = w.findAll('.mon__row')
    expect(rows).toHaveLength(3)
    expect(rows[0].text()).toContain('蓄电池/控制电压')
    expect(rows[0].text()).toContain('≥87 V')
    expect(rows[1].text()).toContain('总风缸 MR')
    expect(rows[1].text()).toContain('≥640 kPa')
  })

  it('点一行确认一行，页脚 0/5 → 1/5', () => {
    const w = mountPanel()
    expect(w.get('.mon__foot-text').text()).toContain('0/5')
    return w.findAll('.mon__hit')[0].trigger('click').then(() => {
      expect(session.mon.voltage).toBe(true)
      expect(w.get('.mon__foot-text').text()).toContain('1/5')
      expect(w.findAll('.mon__row')[0].classes()).toContain('is-done')
    })
  })

  it('车辆信息页三行：EGS / VCB / 受电弓切除', () => {
    const w = mountPanel('vehicle')
    const text = w.findAll('.mon__row').map((r) => r.text())
    expect(text[0]).toContain('EGS')
    expect(text[0]).toContain('断开')
    expect(text[1]).toContain('VCB')
    expect(text[2]).toContain('受电弓远程切除')
  })

  it('status 模式只读：没有可点的确认按钮', () => {
    const w = mountPanel('vehicle', 'status')
    expect(w.findAll('button.mon__hit')).toHaveLength(0)
    expect(w.findAll('.mon__hit--static').length).toBeGreaterThan(0)
  })

  it('远程页读会话状态：选 3U 后第一行就是 3U', () => {
    session.unit = '3U'
    const w = mountPanel('remote')
    expect(w.findAll('.mon__row')[0].text()).toContain('3U')
    expect(w.findAll('.mon__row')[0].text()).toContain('未切除')
  })

  it('升弓到位后远程页显示"升起"', () => {
    session.unit = '2U'
    session.raised = true
    const w = mountPanel('remote', 'status')
    // 远程页现在是四行：2U 切除 / 3U 切除 / 受电弓状态 / VCB
    expect(w.findAll('.mon__row')).toHaveLength(4)
    expect(w.text()).toContain('受电弓状态')
    expect(w.text()).toContain('升起')
    expect(w.get('.mon__foot-text').text()).toContain('网压 25.1 kV')
  })

  it('页签可切换', () => {
    const w = mountPanel()
    return w
      .findAll('.mon__tab')[1]
      .trigger('click')
      .then(() => {
        expect(w.findAll('.mon__row')[0].text()).toContain('EGS')
      })
  })
})
