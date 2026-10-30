import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './styles/base.css'
import './styles/print.css'
// 皮肤必须在挂载前上色：等抽屉打开才加载主题模块，刷新后暗色会掉回亮色。
import './lib/theme'

createApp(App).use(router).mount('#app')
