<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
</script>

<template>
  <header class="site-nav">
    <div class="nav-inner">
      <RouterLink class="brand" to="/">电气调试 AI 作业助手</RouterLink>
      <span class="nav-spacer" />
      <a class="nav-link" href="/">返回门户</a>
    </div>
  </header>

  <main class="container">
    <RouterView />
  </main>

  <footer class="site-foot">
    演示数据 · 非实际作业依据 · AI 生成内容需专业人员复核
  </footer>
</template>
