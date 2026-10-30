<script setup lang="ts">
/** 隐私与数据说明（计划 §11.3.3 删除权 / §11.3.6 页面明示）。
 *
 *  这页存在的理由：站上有三件需要说清楚的事——**访客文本会被存**、**存多久**、
 *  **怎么让它消失**。把这三条塞进页脚一句话，等于没说。
 *
 *  写法纪律：只写代码真的做到的事。清理脚本改了什么，这里就要跟着改；
 *  读这页的人拿它当承诺，不是当宣传。
 */
</script>

<template>
  <div class="page-head">
    <h1 class="page-title">隐私与数据</h1>
    <p class="page-sub">
      这是一个演示站，没有账号体系，也不做用户画像。下面写清楚：你输入的东西存在哪、留多久、怎么删。
    </p>
  </div>

  <section class="card prose">
    <h2>请勿输入真实企业敏感信息</h2>
    <p>
      包括但不限于：客户与供应商名称、工号与姓名、未公开的工艺参数、图纸编号、内部系统地址。
      本站用于演示「工艺文本 → 结构化指导书」的能力，不需要真实数据也能跑通；示例按钮里有现成的虚构文本。
    </p>

    <h2>存了什么</h2>
    <ul>
      <li><strong>工艺文本</strong>：提交生成时原样入库，用于异步任务与失败排查。</li>
      <li><strong>生成的草稿</strong>：结构化步骤、判据与图示 JSON；草稿不进公开列表。</li>
      <li><strong>现场素材</strong>：你上传的图片（服务端会重编码去掉 EXIF），以及切图产生的副本。</li>
      <li><strong>作业会话与记录</strong>：做了哪几步、判据实测值、设备型号/位置/备注（这两项选填，空着不影响使用）。</li>
      <li><strong>用量</strong>：token 数与费用，用于全站预算熔断；不含正文。</li>
      <li><strong>IP</strong>：只用于限流与配额判定，不对外展示。</li>
    </ul>

    <h2>留多久</h2>
    <table class="prose__table">
      <thead>
        <tr><th>数据</th><th>保留期</th><th>说明</th></tr>
      </thead>
      <tbody>
        <tr><td>生成的草稿</td><td>30 天</td><td>到期自动清理；已发布案例不在此列</td></tr>
        <tr><td>上传图片</td><td>30 天</td><td>被指导书引用的图片保留，否则页面会裂图</td></tr>
        <tr><td>作业会话与记录</td><td>180 天</td><td>作业留痕需要可回溯</td></tr>
        <tr><td>已完成任务</td><td>90 天</td><td>排障用；进行中的任务不删</td></tr>
        <tr><td>用量明细</td><td>90 天</td><td>只影响历史统计，不影响当天预算</td></tr>
        <tr><td>公开案例</td><td>永久</td><td>随版本发布，不含访客数据</td></tr>
      </tbody>
    </table>

    <h2>谁能看到</h2>
    <p>
      草稿不出现在列表页，但<strong>知道草稿编号的人可以直接打开详情页</strong>——本站没有登录，编号即凭证。
      不要把草稿链接发给不需要的人。作业记录同理。
    </p>

    <h2>想让它提前消失</h2>
    <p>
      草稿会在 30 天后自动清理。要立刻删除，把草稿编号（形如 <code>g_xxxxxxxxxxxxxxxx</code>，
      在详情页地址栏里）提交到
      <a href="https://github.com/wenjian465276871-arch/matrix-hub/issues" rel="noopener noreferrer" target="_blank">
        项目 Issue
      </a>，我会在 48 小时内删除并回复。公开 Issue 里只贴编号，不要贴正文。
    </p>

    <h2>数据出境与模型</h2>
    <p>
      生成与识别调用的是境内服务商（DeepSeek），数据不出境。模型只做结构化改写，不做检索、不联网。
      AI 生成内容必须由专业人员复核后才可用于任何真实作业——本站所有案例均为虚构演示数据。
    </p>
  </section>
</template>

<style scoped>
.prose {
  font-size: 15px;
  line-height: 26px;
  color: var(--c-ink-2);
}

.prose h2 {
  margin: 20px 0 8px;
  font-size: 16px;
  color: var(--c-ink);
}

.prose h2:first-child {
  margin-top: 0;
}

.prose p {
  margin: 0 0 10px;
}

.prose ul {
  margin: 0 0 10px;
  padding-left: 20px;
}

.prose li {
  margin: 4px 0;
}

.prose code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--c-line-soft);
  font-family: var(--font-mono);
  font-size: 13px;
}

.prose__table {
  width: 100%;
  margin: 4px 0 10px;
  border-collapse: collapse;
  font-size: 14px;
}

.prose__table th,
.prose__table td {
  padding: 8px;
  border-bottom: 1px solid var(--c-line-soft);
  text-align: left;
  vertical-align: top;
}

.prose__table th {
  color: var(--c-ink);
  font-weight: 600;
  white-space: nowrap;
}
</style>
