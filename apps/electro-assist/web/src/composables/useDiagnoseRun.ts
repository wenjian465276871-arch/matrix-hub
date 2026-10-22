/** 逐步诊断的状态与动作。
 *
 * 从视图里抽出来的理由：一次诊断有 5 个状态（空、起始中、进行中、已结论、已中止）
 * 和 4 个动作（开始、提交、中止、重置），混在模板里会让"服务端掌权"这条规则看不清。
 * 这里只负责调接口与保存最新快照，判定仍然全在服务端。
 */
import { ref } from 'vue'

import { errorText as describeError } from '../lib/errors'
import { postJson } from '../lib/http'
import type { DiagnoseRunResponse } from '../types'

export interface CheckPayload {
  verdict: 'pass' | 'fail'
  value: number | null
  note: string
}

export function useDiagnoseRun() {
  const runData = ref<DiagnoseRunResponse | null>(null)
  const busy = ref(false)
  const error = ref('')

  async function start(
    symptom: string,
    system: string,
    entryId?: string,
  ): Promise<boolean> {
    busy.value = true
    error.value = ''
    try {
      runData.value = await postJson<DiagnoseRunResponse>('/api/electro/diagnose/runs', {
        symptom,
        system: system || null,
        entry_id: entryId ?? null,
        session_id: null,
      })
      return true
    } catch (err) {
      error.value = describeError(err, '网络异常，无法开始逐步诊断')
      return false
    } finally {
      busy.value = false
    }
  }

  async function submit(order: number, payload: CheckPayload): Promise<void> {
    const data = runData.value
    if (!data || busy.value) return

    busy.value = true
    error.value = ''
    try {
      const body =
        payload.value === null
          ? { result: payload.verdict, note: payload.note }
          : { value: payload.value, note: payload.note }
      runData.value = await postJson<DiagnoseRunResponse>(
        `/api/electro/diagnose/runs/${data.run.id}/checks/${order}`,
        body,
      )
    } catch (err) {
      error.value = describeError(err, '提交失败，请重试')
    } finally {
      busy.value = false
    }
  }

  async function abort(): Promise<void> {
    const data = runData.value
    if (!data || busy.value) return

    busy.value = true
    error.value = ''
    try {
      runData.value = await postJson<DiagnoseRunResponse>(
        `/api/electro/diagnose/runs/${data.run.id}/abort`,
        {},
      )
    } catch (err) {
      error.value = describeError(err, '中止失败，请重试')
    } finally {
      busy.value = false
    }
  }

  function reset(): void {
    runData.value = null
    error.value = ''
  }

  return { runData, busy, error, start, submit, abort, reset }
}
