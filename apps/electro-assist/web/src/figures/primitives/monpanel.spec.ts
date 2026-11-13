/** mon_panel：可点确认的 MON 屏。
 *
 *  锁四件事：
 *  1. 三页都能切，页内行数与截图一致；
 *  2. 点一行就记一行，页脚计数跟着走（这是"核对过"的证据）；
 *  3. `status` 模式只读——第 6 步不该让人再点一遍；
 *  4. 远程页读的是会话状态（选了 2U 就显示 2U），不是写死的文案；
 *  5. MON 没上电时不能"确认"（屏都没亮，确认是假动作），且"上电"是钥匙右旋 **加** 手柄快速位；
 *  6. VCB 合上后屏上必须显示"闭合"——不能写死"断开"。
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
    session.keyTurned = true
    session.brakeFast = true
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

  it('只右旋钥匙还不够：手柄不在快速位时屏仍是暗的', () => {
    // 2026-11-13 本人指出：钥匙右旋只建立司机室占用，MON 要等 MCR 励磁才亮。
    session.keyTurned = true
    const w = mountPanel()
    expect(w.get('.mon').classes()).toContain('mon--off')
    expect(w.get('.mon__stat').text()).toBe('待 MCR')
    expect(w.get('.mon__foot-text').text()).toContain('快速')
    return w.findAll('.mon__hit')[0].trigger('click').then(() => {
      expect(session.mon.voltage).toBe(false)
    })
  })

  it('MON 未上电时点击无效，页脚说明原因', () => {
    // 真实顺序：插钥匙→右旋→司机室占用、MON 点亮→再确认。
    // 屏没亮就点确认是假动作，必须被拒并说明去哪儿上电。
    const w = mountPanel()
    expect(w.get('.mon__foot-text').text()).toContain('MON 未上电')
    return w.findAll('.mon__hit')[0].trigger('click').then(() => {
      expect(session.mon.voltage).toBe(false)
      expect(w.get('.mon__foot-text').text()).toContain('MON 未上电')
    })
  })

  it('VCB 合上后屏上显示"闭合"，要求列改成"视需要"', () => {
    // 2026-11-13 本人实测：第 5 步合了 VCB，第 6 步屏上仍写"断开"。
    session.keyTurned = true
    session.brakeFast = true
    session.raised = true
    session.vcbClosed = true
    const w = mountPanel('remote', 'status')
    const rows = w.findAll('.mon__row').map((r) => r.text())
    const vcb = rows.find((t) => t.includes('VCB'))!
    expect(vcb).toContain('闭合')
    expect(vcb).not.toContain('断开')
    expect(vcb).toContain('视需要')
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

  it('选 3U 时表头车号与右侧状态牌都跟着换（不能写死 2U / 04 车）', () => {
    session.unit = '3U'
    session.raised = true
    const w = mountPanel('remote', 'status')
    expect(w.get('.mon__ribbon').text()).toContain('06 车')
    expect(w.get('.mon__side').text()).toContain('受电弓 3U')
    expect(w.get('.mon__side').text()).not.toContain('受电弓 2U')
    expect(w.findAll('.mon__row')[0].text()).toContain('3U')
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

  /* ---- 页签角标（R20-4）：回答"还差几项、在哪一页" ---- */

  it('上电后页签标出未确认项数：电源 2 / 车辆 3 / 远程页没有确认项', () => {
    session.keyTurned = true
    session.brakeFast = true
    const w = mountPanel()
    const badges = w.findAll('.mon__tab-badge').map((b) => b.text())
    expect(badges).toEqual(['2', '3'])
    // 可访问名要把数字说出来，不能只画个小圆点
    expect(w.findAll('.mon__tab')[0].attributes('aria-label')).toContain('还有 2 项未确认')
  })

  it('确认完一页，该页角标消失', async () => {
    session.keyTurned = true
    session.brakeFast = true
    const w = mountPanel()
    const hits = w.findAll('.mon__hit')
    await hits[0].trigger('click')
    await hits[1].trigger('click')
    const badges = w.findAll('.mon__tab-badge').map((b) => b.text())
    expect(badges).toEqual(['3'])
    expect(w.findAll('.mon__tab')[0].attributes('aria-label')).toBe('电源电压')
  })

  it('屏没上电 / status 模式时都不出角标（不催人做不该做的事）', () => {
    // 未上电：屏是暗的，标"还有 2 项"等于催人去点一块暗屏
    expect(mountPanel().findAll('.mon__tab-badge')).toHaveLength(0)
    // status：第 6 步只读，没有"确认"这回事
    session.keyTurned = true
    session.brakeFast = true
    expect(mountPanel('power', 'status').findAll('.mon__tab-badge')).toHaveLength(0)
  })

  /* ---- 结果示意提示（R20-3）---- */

  it('status 模式但本次会话没升弓：必须写明"本屏为结果示意"', () => {
    const w = mountPanel('remote', 'status')
    const note = w.get('.mon__provisional')
    expect(note.text()).toContain('结果示意')
    expect(note.text()).toContain('尚未真正升弓')
    // 屏上仍然画"升起"（印刷语义），只是多一行说明
    expect(w.get('.mon__side').text()).toContain('升起')
  })

  it('真的升弓之后不再提示，check 模式也不提示', () => {
    session.raised = true
    expect(mountPanel('remote', 'status').findAll('.mon__provisional')).toHaveLength(0)
    session.raised = false
    expect(mountPanel('power', 'check').findAll('.mon__provisional')).toHaveLength(0)
  })
})
