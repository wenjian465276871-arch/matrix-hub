/** 三维首帧计时的单测（R24-8）。只管两件事：取整、只留最近 30 条。 */
import { beforeEach, describe, expect, it } from 'vitest'

import { readSceneFrames, recordSceneFrame, resetSceneFrames } from './sceneperf'

beforeEach(() => resetSceneFrames())

describe('场景首帧计时', () => {
  it('毫秒取整，subject 原样保留', () => {
    recordSceneFrame('door', 123.6)
    expect(readSceneFrames()).toEqual([{ subject: 'door', ms: 124 }])
  })

  it('超过 30 条只留最近的（老的丢掉，顺序不变）', () => {
    for (let i = 1; i <= 32; i += 1) recordSceneFrame(`d${i}`, i)
    const frames = readSceneFrames()
    expect(frames).toHaveLength(30)
    expect(frames[0]).toEqual({ subject: 'd3', ms: 3 })
    expect(frames[29]).toEqual({ subject: 'd32', ms: 32 })
  })

  it('读出来的是副本，改它不影响内部记录', () => {
    recordSceneFrame('hvac', 88)
    const frames = readSceneFrames()
    frames.push({ subject: 'x', ms: 1 })
    expect(readSceneFrames()).toHaveLength(1)
  })
})
