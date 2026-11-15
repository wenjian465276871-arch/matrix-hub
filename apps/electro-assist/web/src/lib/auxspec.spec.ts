/** aux 串解析：三条用例钉住"分隔符混用"这个真实踩过的坑。
 *
 *  2026-11-14：`hvac|mode=cool;temp=24` 被 `split('|')` 切成两段之后，
 *  第二段整串被当成 `mode` 的值 —— 屏上显示"停止 / 未上电"，
 *  而界面、按钮、读数全是对的，只有那块 canvas 屏是错的。
 */
import { describe, expect, it } from 'vitest'

import { parseAux } from './auxspec'

describe('parseAux', () => {
  it('分号分隔的键值对要逐个拆开，不能整段塞进第一个键', () => {
    const parsed = parseAux('hvac|mode=cool;temp=24;fresh=closed;on=1')
    expect(parsed.scene).toBe('hvac')
    expect(parsed.kv).toEqual({ mode: 'cool', temp: '24', fresh: 'closed', on: '1' })
  })

  it('竖线与分号可以混用（车门那串本来就是 | 分隔）', () => {
    const parsed = parseAux('door|side=L;released=1|open=0|on=1|press=door_cmd')
    expect(parsed.scene).toBe('door')
    expect(parsed.kv.side).toBe('L')
    expect(parsed.kv.released).toBe('1')
    expect(parsed.kv.open).toBe('0')
    expect(parsed.kv.press).toBe('door_cmd')
  })

  it('空串与非法片段不抛错，按"没给"处理', () => {
    expect(parseAux('')).toEqual({ scene: '', kv: {} })
    expect(parseAux('panto').kv).toEqual({})
    expect(parseAux('hvac|=broken;ok=1').kv).toEqual({ ok: '1' })
  })
})
