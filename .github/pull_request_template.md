## 改了什么

<!-- 一两句话说清行为变化。不要贴 diff。 -->

## 影响面

- [ ] 运行时行为（合并后会触发部署）
- [ ] 仅文档 / CI / 模板（不应触发部署，但仍要确认线上镜像 tag）
- [ ] 数据库迁移（**必须先跑** `python -m scripts.check_migration_copy --source <生产库副本>`）
- [ ] 三维 / 前端视觉（附 isolate 截图或量化数字，见 R4）

**同类还有几处？**（R1：附扫描命令 + 命中清单 + 每处处置；写"仅此一处"也要给命令）

```bash
# 例：grep -rn "旧写法" apps/electro-assist
```

## 怎么验证

- [ ] 本地门禁：`pytest` / `npm run test:cov` / `npm run build` / `npm run check:bundle`
- [ ] E2E（全新库）：`npm run test:e2e`
- [ ] 迁移：生产库副本预演通过（附 `MIGRATION_CHECK` 行）
- [ ] 部署后三层验收：镜像 tag / 页面数据 / 用户路径

## 怎么回滚

- 上一个镜像 tag：
- 数据是否可逆（迁移只增不改？有没有删列/改语义）：
- 需要人工介入的步骤：

## 关联

待办编号 / 决策编号 / 复盘报告：
