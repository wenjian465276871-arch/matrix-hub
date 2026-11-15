# 脚本清单

> 15 个脚本，**四类用途、三种风险**。放在一个目录里是因为都以 `python -m scripts.<name>` 或
> `python scripts/<name>.py` 从 `api/` 执行；分类靠本表，不靠子目录——运维入口
> （`publish` / `cleanup`）已被服务器 cron 与运行手册引用，移动目录会**静默打断周任务**。

| 脚本 | 用途 | 读/写 | 会碰生产数据吗 | 入口 |
|---|---|---|---|---|
| `publish.py` | 把草稿改为已发布；缺验收判据拒绝（退出码 2） | 写库 | **会**（status 变更） | `python -m scripts.publish --list / --publish <id>` |
| `cleanup.py` | 按保留期清会话/记录/诊断/任务/草稿/上传 | 删库删盘 | **会，且不可逆** | `python -m scripts.cleanup [--apply]`（默认 dry-run） |
| `refresh_sample.py` | 用 `data/samples/*.json` 原地刷新已发布样例（保留 id/时间戳） | 写库 | **会**（只换内容） | `python -m scripts.refresh_sample [--yes]`（默认 dry-run） |
| `export_openapi.py` | 由 `app.openapi()` 生成 `docs/API.md`；`--check` 只比对 | 只写文档 | 否 | `python scripts/export_openapi.py [--check]` |
| `export_contract.py` | 由 `models/visual.py` 生成 `web/src/contract/devices.json`；`--check` 只比对 | 只写前端契约 | 否 | `python scripts/export_contract.py [--check]`（CI 阻断） |
| `content_fingerprint.py` | `data/samples` + `data/knowledge` 的内容指纹；`--check` 不一致即红（H13 确认失效） | 只读；`--write` 只改基线文件 | 否 | `python scripts/content_fingerprint.py --check`（CI 阻断）／`--write --note "<依据>"` |
| `check_metrics.py` | 校验 README/DEVELOPMENT 里的测试数与端点数是否与代码一致 | 只读 | 否 | `python scripts/check_metrics.py` |
| `bench_criteria.py` | 判据校验链路延迟（P50/P95），计划 §1.4 的 ≤500ms 用 | 写库（临时会话） | 否（用临时库/临时会话） | `python scripts/bench_criteria.py --base http://127.0.0.1:8011` |
| `eval_diagnose.py` | B 检索命中率与 P50/P95；`--quick --json` 供部署闸门（不调模型，约 50ms）；`--provider hybrid\|keyword\|full` 做实现对比 | 只读 | 否 | `python scripts/eval_diagnose.py [--quick --json] [--provider full]` |
| `eval_generate.py` | 8 份语料的批量生成评测（真实调模型，约 ¥0.1）；**支持提示词 A/B**：`--save-prompt` 冻结旧提示词、`--variant` 贴标签、`--repeat` 降方差、`--compare A B` 出 pp 对照表（不调模型） | 只写本地文件 | 否 | `python scripts/eval_generate.py [--dry-run]`；对照流程见下 |
| `demo_flow.py` | 全流程自检：建会话 → 提交 → 记录 → 排查 | 写库 | 否（用临时会话） | `python scripts/demo_flow.py --base http://127.0.0.1:8001` |
| `smoke_llm.py` | 单次生成冒烟，打印耗时与费用 | 只写本地文件 | 否 | `python scripts/smoke_llm.py --text "…"` |
| `capture_generation.py` | 把一次生成输出冻成快照夹具（`tests/fixtures/generations/`）；`--from-sample` 不调模型 | 只写测试夹具 | 否 | `python scripts/capture_generation.py --case <语料> ／ --from-sample <样例>` |
| `replay_samples.py` | 把 `tests/fixtures/legacy/` 的历史形状逐份过一遍 `Guide.model_validate`，并验"读旧写新" | 只读 | 否 | `python scripts/replay_samples.py`（CI 阻断） |
| `backfill_provenance.py` | 给**历史草稿**补判据来源（`provenance`），顺带输出定位命中率 | 写库 | **会**（只改 draft 的 `json` 字段，不动 status / updated_at） | `python scripts/backfill_provenance.py [--apply]`（默认 dry-run；`--apply` 先整库备份） |

## 提示词 A/B 怎么跑（R24-5）

改提示词之前先冻结旧版本，否则改完就找不回来了：

```bash
# 1) 冻结当前提示词（不调模型）
python scripts/eval_generate.py --save-prompt tests/fixtures/prompts/2026-11-15-system.txt

# 2) 旧提示词跑对照（8 份 × 2 遍 = n=16，约 ¥0.2）
python scripts/eval_generate.py --variant baseline \
  --prompt-file tests/fixtures/prompts/2026-11-15-system.txt --repeat 2

# 3) 改完 llm/prompts.py 再跑处理组
python scripts/eval_generate.py --variant treat --repeat 2

# 4) 出对照表（不调模型、不花钱）
python scripts/eval_generate.py --compare \
  eval-results/2026-11-15-baseline.json eval-results/2026-11-15-treat.json
```

口径（抄上游 `modern-web-guidance` 仪表盘的做法，比自己的直觉靠谱）：

- **报 pp + n**，不报孤立百分比——n=8 时一份语料就是 12.5 pp；
- 差异 **< 一份语料** → 「无法分辨」；**≈ 一份** → 「证据很弱」；**≥ 两份** 才给「更好/更差」；
- 结果 JSON 里带 `prompt_sha`，两份放一起也能说清哪个是旧版；
- 成本与 token 单独列，因为「成本翻倍 + 通过率涨 6 pp」和「成本持平 + 涨 12 pp」是两回事。

`tests/fixtures/prompts/` 里放的是**冻结的历史提示词**，不是当前版本——当前版本永远以
`llm/prompts.py` 为准。`scripts/_evalcompare.py` 是共用模块（纯函数，不调模型），
口径测试在 `tests/test_eval_compare.py`。

## 一处容易误解的红

`content_fingerprint.py --check` 红了**不是代码问题**：它表示 `data/samples/` 或
`data/knowledge/` 的内容变了，H13 的人工确认因此失效。正确处置是补失效记录 +
取得本人确认，再用 `--write --note` 更新基线；**不要**为了让 CI 绿而直接 `--write`。

## 约定

1. **默认 dry-run**：`cleanup`、`refresh_sample` 不带 `--apply`/`--yes` 只打印计划。
2. **`.env` 只在本仓找**：`api/.env` → 仓库根 `.env`，由 `_bootstrap.py` 统一解析；
   不覆盖已存在的环境变量（CI / shell 注入优先）。禁止在公开仓写同级私有仓库的路径。
3. **退出码有意义**：`0` 成功、`1` 失败、`2` 配置或输入问题。cron 与 CI 只认退出码。
4. **新增脚本**：先在本表登记"会不会碰生产数据"，再写代码；只跑一次的分析不进本目录。

`_bootstrap.py` 是共用模块（不是可执行脚本），只提供 `default_env_files()` /
`find_env_file()` / `load_env_file()` 三个函数，契约测试在 `tests/test_scripts_bootstrap.py`。
