"""作业记录的独立 HTML 报告。

为什么在服务端生成而不是前端拼字符串：
1. **离线可读**：导出的文件要能在没网、没前端的电脑上打开（班组电脑、甲方邮箱）；
2. **只有一份模板**：打印样式已经在前端有一份，但那依赖 SPA 的 CSS 与路由；
   报告要能单独存在，就必须自带样式；
3. **转义可控**：现场备注是用户输入，拼接时少一个 `escape` 就是持久化 XSS
   （下载后双击打开，脚本照样执行）。

刻意不引入模板引擎：结构固定、字段有限，一个 f-string 加 `escape()` 就够；
多一个依赖就多一处版本与锁文件维护。
"""
from __future__ import annotations

from html import escape
from typing import Any

VERDICT_LABEL = {
    "pass": "通过",
    "warn": "需复测",
    "fail": "异常",
    "manual": "已记录",
    "skipped": "未执行",
}
STATUS_LABEL = {"done": "已完成", "aborted": "已中止", "active": "进行中"}
DIAG_STATUS_LABEL = {"concluded": "已出结论", "active": "进行中", "aborted": "已中止"}

CSS = """
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; background: #fff; color: #12181c;
  font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; }
main { max-width: 820px; margin: 0 auto; }
h1 { margin: 0 0 4px; font-size: 22px; }
h2 { margin: 24px 0 8px; font-size: 16px; border-bottom: 1px solid #dfe5e8; padding-bottom: 6px; }
.kicker { margin: 0; color: #626f78; font-size: 12px; letter-spacing: .08em; }
.meta { margin: 8px 0 0; color: #3d4a52; font-size: 13px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.disclaimer { margin: 12px 0 0; padding: 8px 10px; background: #f6f8f9;
  border: 1px solid #dfe5e8; border-radius: 6px; color: #3d4a52; font-size: 12px; }
.summary { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0; padding: 0; list-style: none; }
.summary li { flex: 1 1 120px; padding: 10px 12px; border: 1px solid #dfe5e8; border-radius: 6px; }
.summary b { display: block; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 20px; }
.summary span { color: #626f78; font-size: 12px; }
.step { padding: 12px 0; border-top: 1px solid #eef2f4; break-inside: avoid; page-break-inside: avoid; }
.step:first-of-type { border-top: none; }
.step-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.step-seq { font-family: ui-monospace, Menlo, Consolas, monospace; color: #626f78; }
.step-head h3 { margin: 0; font-size: 15px; }
.chip { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 12px;
  border: 1px solid currentColor; }
.v-pass { color: #157f3d; }
.v-warn { color: #a85b00; }
.v-fail { color: #c0262a; }
.v-manual, .v-skipped { color: #626f78; }
.attempt { margin: 8px 0 0; padding-left: 12px; border-left: 2px solid #eef2f4; }
.attempt p { margin: 4px 0; }
.results { margin: 4px 0; padding-left: 18px; }
.results li { margin: 2px 0; }
.result-value { font-family: ui-monospace, Menlo, Consolas, monospace; }
.muted { color: #626f78; font-size: 12px; }
.empty { color: #626f78; font-size: 13px; }
.diag { padding: 10px 12px; border: 1px solid #dfe5e8; border-radius: 6px; margin: 8px 0; break-inside: avoid; }
.diag p { margin: 4px 0; }
footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid #dfe5e8; color: #626f78; font-size: 12px; }
@media print {
  body { padding: 0; }
  @page { size: A4; margin: 14mm; }
}
"""


def _text(value: Any) -> str:
    return escape("" if value is None else str(value), quote=True)


def _time(value: str | None) -> str:
    if not value:
        return "—"
    return _text(value.replace("T", " ")[:19])


def _duration(seconds: int | float | None) -> str:
    if not seconds:
        return "—"
    seconds = int(seconds)
    minutes, rest = divmod(seconds, 60)
    return f"{minutes} 分 {rest} 秒" if minutes else f"{rest} 秒"


def _verdict(value: str | None) -> str:
    label = VERDICT_LABEL.get(value or "", value or "—")
    return f'<span class="chip v-{_text(value or "skipped")}">{_text(label)}</span>'


def _value_text(result: dict) -> str:
    value = result.get("value")
    if isinstance(value, bool):
        return "已确认" if value else "未确认"
    unit = result.get("unit") or ""
    return f"{value}{(' ' + unit) if unit else ''}"


def _step_html(step: dict) -> str:
    attempts = step.get("attempts") or []
    parts = [
        '<article class="step">',
        '<div class="step-head">',
        f'<span class="step-seq">{int(step.get("seq", 0)):02d}</span>',
        f'<h3>{_text(step.get("title"))}</h3>',
        _verdict(step.get("final_verdict")),
        f'<span class="muted">耗时 {_text(_duration(step.get("duration_s")))}</span>',
        "</div>",
    ]
    if not attempts:
        parts.append('<p class="empty">未执行</p>')
    for attempt in attempts:
        payload = attempt.get("payload") or {}
        parts.append('<div class="attempt">')
        parts.append(
            '<p class="muted">第 '
            f'{_text(attempt.get("attempt"))} 次 · {_time(attempt.get("created_at"))} '
            f'{_verdict(attempt.get("verdict"))}</p>'
        )
        results = payload.get("results") or []
        if results:
            parts.append('<ul class="results">')
            for item in results:
                parts.append(
                    "<li>"
                    f'{_text(item.get("label"))}：'
                    f'<span class="result-value">{_text(_value_text(item))}</span> '
                    f'{_verdict(item.get("verdict"))} '
                    f'<span class="muted">{_text(item.get("message"))}</span>'
                    "</li>"
                )
            parts.append("</ul>")
        note = payload.get("note")
        if note:
            parts.append(f'<p class="muted">备注：{_text(note)}</p>')
        parts.append("</div>")
    parts.append("</article>")
    return "".join(parts)


def _exception_html(item: dict) -> str:
    messages = "".join(f"<li>{_text(message)}</li>" for message in item.get("messages") or [])
    note = item.get("note")
    return (
        '<div class="step">'
        f'<p class="muted">第 {_text(item.get("seq"))} 步 · 第 {_text(item.get("attempt"))} 次 '
        f'{_verdict(item.get("verdict"))} · {_time(item.get("created_at"))}</p>'
        f"<ul class='results'>{messages}</ul>"
        + (f'<p class="muted">备注：{_text(note)}</p>' if note else "")
        + "</div>"
    )


def _diagnosis_html(run: dict) -> str:
    conclusion = run.get("conclusion") or {}
    cause = conclusion.get("cause")
    action = conclusion.get("action")
    safety = conclusion.get("safety") or []
    status = DIAG_STATUS_LABEL.get(run.get("status"), run.get("status"))
    rows = [
        '<div class="diag">',
        f'<p><b>{_text(run.get("symptom"))}</b> '
        f'<span class="chip">{_text(status)}</span> '
        f'<span class="muted">{_text(run.get("checks"))} 项检查 · '
        f'{_time(run.get("created_at"))}</span></p>',
    ]
    if cause:
        rows.append(f"<p>定位：{_text(cause)}</p>")
    if action:
        rows.append(f"<p>处置：{_text(action)}</p>")
    if safety:
        rows.append("<p>安全：" + "；".join(_text(item) for item in safety) + "</p>")
    rows.append("</div>")
    return "".join(rows)


def render(report: dict) -> str:
    """把 `services.sessions.report()` 的返回值渲染成自包含 HTML。"""
    session = report.get("session") or {}
    guide = report.get("guide") or {}
    summary = report.get("summary") or {}
    steps = report.get("steps") or []
    exceptions = report.get("exceptions") or []
    diagnoses = report.get("diagnoses") or []

    title = guide.get("title") or "作业记录"
    disclaimers = " · ".join(_text(item) for item in guide.get("disclaimers") or [])
    status = STATUS_LABEL.get(summary.get("status"), summary.get("status"))

    body = [
        "<main>",
        '<p class="kicker">作业记录</p>',
        f"<h1>{_text(title)}</h1>",
        '<p class="meta">'
        f'{_text(status)} · <span class="mono">{_text(session.get("id"))}</span>'
        + (f' · 设备 {_text(session.get("device"))}' if session.get("device") else "")
        + (f' · 位置 {_text(session.get("location"))}' if session.get("location") else "")
        + f' · {_time(session.get("created_at"))} 开始 · 用时 {_text(_duration(summary.get("duration_s")))}'
        "</p>",
        f'<p class="disclaimer">{disclaimers or "演示数据 · 非实际作业依据"}</p>',
        '<ul class="summary">',
        f'<li><b>{_text(summary.get("recorded_steps"))}/{_text(summary.get("total_steps"))}</b><span>已执行步骤</span></li>',
        f'<li><b>{_text(summary.get("pass"))}</b><span>通过</span></li>',
        f'<li><b>{_text(summary.get("manual"))}</b><span>已记录</span></li>',
        f'<li><b>{_text(len(exceptions))}</b><span>异常尝试</span></li>',
        "</ul>",
        "<h2>逐步记录</h2>",
    ]
    body.extend(_step_html(step) for step in steps)

    body.append("<h2>异常链</h2>")
    if exceptions:
        body.extend(_exception_html(item) for item in exceptions)
    else:
        body.append('<p class="empty">本次作业没有异常记录。</p>')

    if diagnoses:
        body.append("<h2>关联排查结论</h2>")
        body.extend(_diagnosis_html(run) for run in diagnoses)

    body.append(
        '<footer>本报告由「电气调试 AI 作业助手」生成，内容需专业人员复核。'
        f' 记录编号 {_text(session.get("id"))}。</footer>'
    )
    body.append("</main>")

    return (
        "<!DOCTYPE html>\n"
        '<html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{_text(title)} · 作业记录</title><style>{CSS}</style></head>"
        f"<body>{''.join(body)}</body></html>"
    )
