"""横切能力层：与业务流程无关、被多个入口复用的基础设施。

放这里而不是仓库根目录，是为了让根目录只剩一个入口 `main.py`：
- `assets`    上传资产的落盘约定与存在性校验
- `imaging`   图片准入（格式/尺寸/重编码）
- `slicing`   版面切分（表格线/密集文字）
- `ratelimit` 进程内滑窗限流
- `passcode`  口令令牌（HMAC）

依赖方向：routers → services/llm/store → core；core 不反向依赖任何业务模块。
"""
