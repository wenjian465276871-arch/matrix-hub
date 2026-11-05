import { beforeEach, describe, expect, it } from 'vitest'
import { JOB_KEY, clearStoredJob, readStoredJob, writeStoredJob } from './jobhandoff'

const VALID_ID = 'j_0123456789abcdef'

beforeEach(() => {
  sessionStorage.clear()
})

describe('jobhandoff（生成任务的跨页交接）', () => {
  it('写入后能原样读回', () => {
    writeStoredJob(VALID_ID, 1_700_000_000_000)
    expect(readStoredJob()).toEqual({ jobId: VALID_ID, startedAt: 1_700_000_000_000 })
  })

  it('没写过时返回 null', () => {
    expect(readStoredJob()).toBeNull()
  })

  it('jobId 格式不对就当没有', () => {
    sessionStorage.setItem(JOB_KEY, JSON.stringify({ jobId: 'j_short', startedAt: 1 }))
    expect(readStoredJob()).toBeNull()
  })

  it('startedAt 不是数字就当没有', () => {
    sessionStorage.setItem(JOB_KEY, JSON.stringify({ jobId: VALID_ID, startedAt: '123' }))
    expect(readStoredJob()).toBeNull()
  })

  it('存了坏 JSON 不抛异常，按没有处理', () => {
    sessionStorage.setItem(JOB_KEY, '{not json')
    expect(() => readStoredJob()).not.toThrow()
    expect(readStoredJob()).toBeNull()
  })

  it('clearStoredJob 之后读不到', () => {
    writeStoredJob(VALID_ID, 1)
    clearStoredJob()
    expect(readStoredJob()).toBeNull()
  })

  // 这条是 jobhandoff 存在的理由：开始时刻是硬超时的唯一基准，
  // 任何一次读取都不能把它刷新成"现在"。
  it('读取不会改变 startedAt', () => {
    writeStoredJob(VALID_ID, 12345)
    readStoredJob()
    readStoredJob()
    expect(readStoredJob()?.startedAt).toBe(12345)
  })
})
