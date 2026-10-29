<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import GuideFigure from '../figures/GuideFigure.vue'
import { ApiError, getJson, postJson, putJson } from '../lib/http'
import type {
  AssetRef,
  AttachResult,
  Criterion,
  Guide,
  GuideDetail,
  GuideStatus,
  SessionSnapshot,
} from '../types'

const props = defineProps<{ id: string }>()
const router = useRouter()

const SYSTEM_LABEL: Record<string, string> = {
  door: '车门',
  hvac: '空调',
  pantograph: '受电弓',
}

const guide = ref<Guide | null>(null)
const guideStatus = ref<GuideStatus>('published')
const phase = ref<'loading' | 'ready' | 'notfound' | 'error'>('loading')
const errorText = ref('')
let ctrl: AbortController | null = null

/** 素材按"步骤顺序 + 文末素材区"编号，打印出来和正文对得上。 */
const flatAssets = computed<{ asset: AssetRef; stepId: string | null }[]>(() => {
  if (!guide.value) return []
  const rows: { asset: AssetRef; stepId: string | null }[] = []
  for (const step of guide.value.steps) {
    for (const asset of step.assets ?? []) rows.push({ asset, stepId: step.id })
  }
  for (const asset of guide.value.assets ?? []) rows.push({ asset, stepId: null })
  return rows
})

const assetNumbers = computed<Record<string, number>>(() => {
  const map: Record<string, number> = {}
  flatAssets.value.forEach((row, index) => {
    map[row.asset.asset_id] = index + 1
  })
  return map
})

function assetUrl(asset: AssetRef): string {
  return `/api/electro/uploads/${asset.asset_id}/${asset.asset_id}.png`
}

/* ---------- 草稿素材归位 ----------
 * 只改"图放哪"，不改步骤文字与判据：判据能被改一个字，超差就能变合格。 */
const placement = ref<Record<string, string>>({})
const captions = ref<Record<string, string>>({})
const attachBusy = ref(false)
const attachMsg = ref('')
const attachError = ref('')

async function savePlacement(): Promise<void> {
  if (!guide.value || attachBusy.value) return
  attachBusy.value = true
  attachMsg.value = ''
  attachError.value = ''
  try {
    const assets = flatAssets.value.map(({ asset }) => ({
      asset_id: asset.asset_id,
      caption: (captions.value[asset.asset_id] ?? asset.caption).trim() || asset.caption,
      step_id: placement.value[asset.asset_id] || null,
    }))
    const res = await putJson<AttachResult>(`/api/electro/guides/${props.id}/assets`, { assets })
    attachMsg.value = `已保存：${res.attached} 张挂到步骤，${res.loose} 张留在素材区`
    await load()
  } catch (err) {
    attachError.value =
      err instanceof ApiError
        ? err.code === 'published_locked'
          ? '已发布的指导书不能调整素材。'
          : err.message || '保存失败，请稍后重试'
        : '保存失败，请稍后重试'
  } finally {
    attachBusy.value = false
  }
}

function criterionValue(c: Criterion): string {
  if (c.type === 'range') return `${c.min ?? '—'} ~ ${c.max ?? '—'}`
  if (c.type === 'enum') return (c.options ?? []).join(' / ')
  if (c.type === 'manual') return '人工确认'
  return '记录'
}

// 模板里拿不到 window（Vue 只白名单了 Math/Date/JSON 等），必须在这里包一层。
function printGuide(): void {
  window.print()
}

const starting = ref(false)
const startError = ref('')

async function startRun(): Promise<void> {
  if (starting.value) return
  starting.value = true
  startError.value = ''
  try {
    const data = await postJson<SessionSnapshot>('/api/electro/sessions', {
      guide_id: props.id,
    })
    await router.push({ name: 'run', params: { sid: data.session.id } })
  } catch (err) {
    startError.value =
      err instanceof ApiError
        ? err.message || '无法创建引导会话'
        : '无法创建引导会话，请稍后重试'
  } finally {
    starting.value = false
  }
}

async function load(): Promise<void> {
  ctrl?.abort()
  ctrl = new AbortController()
  phase.value = 'loading'
  errorText.value = ''
  try {
    const detail = await getJson<GuideDetail>(`/api/electro/guides/${props.id}`, ctrl.signal)
    guide.value = detail.guide
    guideStatus.value = detail.status
    // 归位面板的初值来自服务端：本地只保存"用户改了什么"，不猜默认位置。
    const place: Record<string, string> = {}
    const labels: Record<string, string> = {}
    for (const step of detail.guide.steps) {
      for (const asset of step.assets ?? []) {
        place[asset.asset_id] = step.id
        labels[asset.asset_id] = asset.caption
      }
    }
    for (const asset of detail.guide.assets ?? []) {
      place[asset.asset_id] = ''
      labels[asset.asset_id] = asset.caption
    }
    placement.value = place
    captions.value = labels
    phase.value = 'ready'
  } catch (err) {
    if (ctrl.signal.aborted) return
    if (err instanceof ApiError && err.kind === 'notfound') {
      phase.value = 'notfound'
      return
    }
    errorText.value =
      err instanceof ApiError
        ? err.kind === 'timeout'
          ? '请求超时，请检查网络后重试'
          : `服务暂不可用（${err.status ?? err.kind}）`
        : '页面初始化失败：请升级浏览器，或改用 Chrome / Safari 打开'
    if (!(err instanceof ApiError)) console.error('load guide failed', err)
    phase.value = 'error'
  }
}

onMounted(load)
watch(() => props.id, load)
onBeforeUnmount(() => ctrl?.abort())
</script>

<template>
  <div v-if="phase === 'loading'" class="card state" aria-busy="true">正在加载指导书…</div>

  <div v-else-if="phase === 'notfound'" class="card state state--error">
    <p>这份指导书不存在。</p>
    <p class="state__hint">GET /api/electro/guides/{{ id }}</p>
    <RouterLink class="btn" to="/">返回列表</RouterLink>
  </div>

  <div v-else-if="phase === 'error'" class="card state state--error">
    <p>{{ errorText }}</p>
    <p class="state__hint">GET /api/electro/guides/{{ id }}</p>
    <button class="btn" type="button" @click="load">重试</button>
  </div>

  <article v-else-if="guide" class="card">
    <div v-if="guideStatus === 'draft'" class="draft-banner no-print">
      <strong>草稿</strong> · 未发布，仅通过此链接可见
    </div>
    <header class="guide-head">
      <h1 class="guide-title">{{ guide.title }}</h1>
      <p class="guide-summary">{{ guide.summary }}</p>
      <div class="meta-row">
        <span class="tag">{{ SYSTEM_LABEL[guide.meta.system] ?? guide.meta.system }}</span>
        <span class="tag tag--plain">{{ guide.steps.length }} 步</span>
        <span class="tag tag--plain">{{ guide.meta.model }}</span>
        <span>{{ new Date(guide.meta.generated_at).toLocaleString('zh-CN') }}</span>
      </div>
      <p class="disclaimer">
        {{ guide.disclaimers.join(' · ') }}
      </p>
      <div class="meta-row no-print">
        <button class="btn btn--primary" type="button" :disabled="starting" @click="startRun">
          {{ starting ? '正在创建会话…' : '开始引导作业' }}
        </button>
        <button class="btn" type="button" @click="printGuide">打印 / 导出 PDF</button>
      </div>
      <p v-if="startError" class="start-error no-print">{{ startError }}</p>
    </header>

    <section v-if="guideStatus === 'draft' && flatAssets.length" class="attach no-print">
      <h2 class="attach__title">素材归位</h2>
      <p class="attach__hint">
        系统不会识别图片内容，所以位置由你决定：选好步骤后保存。已发布的指导书不能再改。
      </p>
      <ul class="attach__list">
        <li v-for="row in flatAssets" :key="row.asset.asset_id" class="attach__row">
          <img
            class="attach__thumb"
            :src="assetUrl(row.asset)"
            :alt="`图 ${assetNumbers[row.asset.asset_id]} 预览`"
            loading="lazy"
            decoding="async"
          />
          <div class="attach__fields">
            <label class="attach__label" :for="`cap-${row.asset.asset_id}`">
              图 {{ assetNumbers[row.asset.asset_id] }} 说明
            </label>
            <input
              :id="`cap-${row.asset.asset_id}`"
              v-model="captions[row.asset.asset_id]"
              class="attach__input"
              type="text"
              maxlength="60"
              :disabled="attachBusy"
            />
            <label class="attach__label" :for="`pos-${row.asset.asset_id}`">放在</label>
            <select
              :id="`pos-${row.asset.asset_id}`"
              v-model="placement[row.asset.asset_id]"
              class="attach__select"
              :disabled="attachBusy"
            >
              <option value="">素材区（文末）</option>
              <option v-for="step in guide.steps" :key="step.id" :value="step.id">
                第 {{ step.seq }} 步 · {{ step.title }}
              </option>
            </select>
          </div>
        </li>
      </ul>
      <div class="attach__actions">
        <button class="btn" type="button" :disabled="attachBusy" @click="savePlacement">
          {{ attachBusy ? '保存中…' : '保存归位' }}
        </button>
        <span v-if="attachMsg" class="attach__ok">{{ attachMsg }}</span>
        <span v-if="attachError" class="attach__error">{{ attachError }}</span>
      </div>
    </section>

    <section v-for="step in guide.steps" :key="step.id" class="step">
      <div class="step__head">
        <span class="step__seq">{{ String(step.seq).padStart(2, '0') }}</span>
        <h2 class="step__title">{{ step.title }}</h2>
      </div>
      <p class="step__action">{{ step.action }}</p>

      <div v-if="step.safety.length" class="step__block">
        <p class="block-label">安全</p>
        <ul class="safety">
          <li v-for="s in step.safety" :key="s">{{ s }}</li>
        </ul>
      </div>

      <div v-if="step.tools.length" class="step__block">
        <p class="block-label">工具</p>
        <div class="tool-list">
          <span v-for="t in step.tools" :key="t" class="tag tag--plain">{{ t }}</span>
        </div>
      </div>

      <div v-if="step.criteria.length" class="step__block">
        <p class="block-label">验收判据</p>
        <div class="criteria">
          <div v-for="c in step.criteria" :key="c.id" class="criterion">
            <span class="criterion__label">{{ c.label }}</span>
            <span class="criterion__value">
              {{ criterionValue(c) }}<span v-if="c.unit" class="criterion__unit">{{ c.unit }}</span>
            </span>
          </div>
        </div>
      </div>

      <div v-if="step.figures.length" class="step__block">
        <p class="block-label">图示</p>
        <GuideFigure v-for="(fig, i) in step.figures" :key="`${step.id}-fig-${i}`" :spec="fig" />
      </div>

      <div v-if="step.assets?.length" class="step__block">
        <p class="block-label">现场素材</p>
        <div class="asset-row">
          <figure v-for="asset in step.assets" :key="asset.asset_id" class="asset">
            <img
              class="asset__img"
              :src="assetUrl(asset)"
              :alt="asset.caption"
              loading="lazy"
              decoding="async"
            />
            <figcaption class="asset__cap">
              图 {{ assetNumbers[asset.asset_id] }} · {{ asset.caption }}
            </figcaption>
          </figure>
        </div>
      </div>

      <div v-if="step.duration_s" class="step__block">
        <p class="block-label">预计耗时</p>
        <p class="step__duration">{{ Math.max(1, Math.round(step.duration_s / 60)) }} 分钟</p>
      </div>
    </section>

    <section v-if="guide.assets?.length" class="guide-assets">
      <h2 class="guide-assets__title">现场素材</h2>
      <p class="guide-assets__hint">未归入具体步骤的照片，编号与正文一致。</p>
      <div class="asset-row">
        <figure v-for="asset in guide.assets" :key="asset.asset_id" class="asset">
          <img
            class="asset__img"
            :src="assetUrl(asset)"
            :alt="asset.caption"
            loading="lazy"
            decoding="async"
          />
          <figcaption class="asset__cap">
            图 {{ assetNumbers[asset.asset_id] }} · {{ asset.caption }}
          </figcaption>
        </figure>
      </div>
    </section>
  </article>
</template>

<style scoped>
.draft-banner {
  margin-bottom: 16px;
  padding: 10px 14px;
  border: 1px solid #e8c98a;
  border-radius: 6px;
  background: #fff4e0;
  color: #8a5a00;
  font-size: 13px;
}

.start-error {
  margin: 10px 0 0;
  color: var(--c-danger);
  font-size: 13px;
}

/* ---------- 素材归位（仅草稿、仅屏显） ---------- */

.attach {
  margin: 0 0 20px;
  padding: 14px;
  border: 1px solid var(--c-primary-line);
  border-radius: 8px;
  background: var(--c-primary-soft);
}

.attach__title {
  margin: 0 0 6px;
  font-size: 15px;
}

.attach__hint {
  margin: 0 0 10px;
  color: var(--c-ink-2);
  font-size: 13px;
}

.attach__list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.attach__row {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 12px;
  align-items: start;
  padding: 10px;
  border-radius: 6px;
  background: var(--c-surface);
}

.attach__thumb {
  width: 64px;
  height: 64px;
  border-radius: 4px;
  background: var(--c-line-soft);
  object-fit: cover;
}

.attach__fields {
  display: grid;
  gap: 6px;
}

.attach__label {
  color: var(--c-ink-3);
  font-size: 12px;
}

.attach__input,
.attach__select {
  width: 100%;
  min-height: 44px;
  padding: 0 10px;
  border: 1px solid var(--c-line);
  border-radius: 6px;
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
  font-size: 14px;
}

.attach__input:focus,
.attach__select:focus {
  outline: 2px solid var(--c-primary);
  outline-offset: 1px;
}

.attach__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.attach__ok {
  color: var(--c-success);
  font-size: 13px;
}

.attach__error {
  color: var(--c-danger);
  font-size: 13px;
}

/* ---------- 素材渲染 ---------- */

.asset-row {
  display: grid;
  gap: 12px;
}

.asset {
  margin: 0;
}

.asset__img {
  display: block;
  width: 100%;
  max-height: 360px;
  border: 1px solid var(--c-line);
  border-radius: 6px;
  background: var(--c-surface);
  object-fit: contain;
}

.asset__cap {
  margin-top: 6px;
  color: var(--c-ink-2);
  font-size: 13px;
}

.guide-assets {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--c-line);
}

.guide-assets__title {
  margin: 0 0 4px;
  font-size: 16px;
}

.guide-assets__hint {
  margin: 0 0 12px;
  color: var(--c-ink-3);
  font-size: 13px;
}

@media (min-width: 640px) {
  .asset-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
