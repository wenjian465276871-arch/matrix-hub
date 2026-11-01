import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './styles/base.css'
import './styles/print.css'
// 皮肤必须在挂载前上色：等抽屉打开才加载主题模块，刷新后暗色会掉回亮色。
import './lib/theme'
import { reportError } from './lib/report'

const app = createApp(App)

/** 三条错误钩子，缺一条就有一类白屏查不到：
 *
 *  - `errorHandler`：Vue 组件渲染/生命周期里的异常（模板报错不会冒泡到 window）；
 *  - `error`：模块加载失败、事件处理器里的同步异常；
 *  - `unhandledrejection`：漏掉 `catch` 的 Promise——接口层几乎全是 async，
 *    这一类最多，而且不打日志时控制台里也只是黄字提示。
 *
 *  本地仍保留 `console.error`：上报是给线上的，开发时看栈还是控制台快。
 */
app.config.errorHandler = (err, _instance, info) => {
  const error = err instanceof Error ? err : new Error(String(err))
  reportError(error.message, { kind: 'vue', source: info, stack: error.stack })
  console.error(err)
}

window.addEventListener('error', (event) => {
  // 资源加载失败（img/script）也走这里，但 `event.error` 为空、只有 target；
  // 这类问题在 network 面板里已经可见，不上报以免噪音淹没真正的异常。
  if (!event.error) return
  reportError(event.message, {
    kind: 'window',
    source: `${event.filename ?? ''}:${event.lineno ?? 0}`,
    stack: event.error instanceof Error ? event.error.stack : '',
  })
})

window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : '未处理的 Promise 拒绝'
  reportError(message, {
    kind: 'promise',
    stack: reason instanceof Error ? reason.stack : '',
  })
})

app.use(router).mount('#app')
