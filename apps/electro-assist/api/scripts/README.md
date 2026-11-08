# 脚本清单

> 11 个脚本，**四类用途、三种风险**。放在一个目录里是因为都以 `python -m scripts.<name>` 或
> `python scripts/<name>.py` 从 `api/` 执行；分类靠本表，不靠子目录——运维入口
> （`publish` / `cleanup`）已被服务器 cron 与运行手册引用，移动目录会**静默打断周任务**。

| 脚本 | 用途 | 读/写 | 会碰生产数据吗 | 入口 |
|---|---|---|---|---|
| `publish.py` | 把草稿改为已发布；缺验收判据拒绝（退出码 2） | 写库 | **会**（status 变更） | `python -m scripts.publish --list / --publish <id>` |
| `cleanup.py` | 按保留期清会话/记录/诊断/任务/草稿/上传 | 删库删盘 | **会，且不可逆** | `python -m scripts.cleanup [--apply]`（默认 dry-run） |
| `refresh_sample.py` | 用 `data/samples/*.json` 原地刷新已发布样例（保留 id/时间戳） | 写库 | **会**（只换内容） | `python -m scripts.refresh_sample [--yes]`（默认 dry-run） |
| `export_openapi.py` | 由 `app.openapi()` 生成 `docs/API.md`；`--check` 只比对 | 只写文档 | 否 | `python scripts/export_openapi.py [--check]` |
| `check_metrics.py` | 校验 README/DEVELOPMENT 里的测试数与端点数是否与代码一致 | 只读 | 否 | `python scripts/check_metrics.py` |
| `bench_criteria.py` | 判据校验链路延迟（P50/P95），计划 §1.4 的 ≤500ms 用 | 写库（临时会话） | 否（用临时库/临时会话） | `python scripts/bench_criteria.py --base http://127.0.0.1:8011` |
| `eval_diagnose.py` | B 检索命中率与 P50/P95；`--quick --json` 供部署闸门（不调模型，约 50ms）；`--provider hybrid\|keyword\|full` 做实现对比 | 只读 | 否 | `python scripts/eval_diagnose.py [--quick --json] [--provider full]` |
| `eval_generate.py` | 8 份语料的批量生成评测（真实调模型，约 ¥0.1） | 只写本地文件 | 否 | `python scripts/eval_generate.py [--dry-run]` |
| `demo_flow.py` | 全流程自检：建会话 → 提交 → 记录 → 排查 | 写库 | 否（用临时会话） | `python scripts/demo_flow.py --base http://127.0.0.1:8001` |
| `smoke_llm.py` | 单次生成冒烟，打印耗时与费用 | 只写本地文件 | 否 | `python scripts/smoke_llm.py --text "…"` |
| `backfill_provenance.py` | 给**历史草稿**补判据来源（`provenance`），顺带输出定位命中率 | 写库 | **会**（只改 draft 的 `json` 字段，不动 status / updated_at） | `python scripts/backfill_provenance.py [--apply]`（默认 dry-run；`--apply` 先整库备份） |

## 约定

1. **默认 dry-run**：`cleanup`、`refresh_sample` 不带 `--apply`/`--yes` 只打印计划。
2. **`.env` 只在本仓找**：`api/.env` → 仓库根 `.env`，由 `_bootstrap.py` 统一解析；
   不覆盖已存在的环境变量（CI / shell 注入优先）。禁止在公开仓写同级私有仓库的路径。
3. **退出码有意义**：`0` 成功、`1` 失败、`2` 配置或输入问题。cron 与 CI 只认退出码。
4. **新增脚本**：先在本表登记"会不会碰生产数据"，再写代码；只跑一次的分析不进本目录。

`_bootstrap.py` 是共用模块（不是可执行脚本），只提供 `default_env_files()` /
`find_env_file()` / `load_env_file()` 三个函数，契约测试在 `tests/test_scripts_bootstrap.py`。
