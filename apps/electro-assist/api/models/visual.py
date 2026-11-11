"""视觉 DSL：LLM 只输出"用哪个原语 + 什么参数"，具体 SVG 由前端渲染。

设计约束（见开发计划 §12.4 与 ADR 中"不做运行时代码生成"）：
- 原语是构建期固定的枚举，不在运行时新增；
- 参数只允许标量或「字符串列表」，禁止嵌套对象、URL、HTML；
- 每个图示必须带 fallback_text，渲染失败时降级为文字，保证现场可读。

为什么参数允许字符串列表（2026-10-18 放宽，决策 #15）：
批量评测 5 份语料，3 份被拒，错误全是 `params.items` 传了数组。
清单类参数（items / terminals / pins）的本质就是列表，只允许标量等于
逼模型把列表编码成 `a|b|c` 这种带分隔符的字符串——它靠 JSON Schema 看不出这个约定，
只能靠散文提示，稳定性差。这不是模型的错，是契约不自然。
列表仍是强校验的：条数 ≤10、每项 ≤40 字、禁止标记内容。安全性没有放松。
"""
from __future__ import annotations

import re
from enum import Enum
from typing import Union

from pydantic import BaseModel, ConfigDict, Field, field_validator

Scalar = Union[str, int, float, bool]
# 列表只允许「字符串列表」，不允许对象/嵌套，避免参数变成任意结构。
ParamValue = Union[Scalar, list[str]]

MAX_LIST_ITEMS = 10
MAX_LIST_ITEM_CHARS = 40

# 动效上限：一张图最多 3 条轨道。再多就不是"强调"，是交通信号灯。
MAX_MOTION_TRACKS = 3

# 烘焙图只允许站内静态路径。外链一律拒绝：CSP 是 default-src 'self'，
# 放进去也加载不出来，不如在写入时就拦掉。
BAKED_SRC_RE = re.compile(r"^/figures/[A-Za-z0-9._/-]+\.(webp|jpg|jpeg|png)$")


class Primitive(str, Enum):
    """P0/P1a 的原语集合。新增原语必须走"构建期扩展"流程，不在运行时放开。"""

    step_card = "step_card"          # 步骤卡：序号 + 动作 + 要点
    meter = "meter"                  # 仪表读数：数值 + 单位 + 量程
    status_light = "status_light"    # 状态灯：通过/注意/危险
    wiring = "wiring"                # 接线示意：端子编号 + 线色
    connector = "connector"          # 接插件：针脚编号 + 定义
    torque_gauge = "torque_gauge"    # 力矩扳手：目标值 + 公差
    checklist = "checklist"          # 检查清单：多条勾选项
    motion_timeline = "motion_timeline"  # 运动时序：分段动作 + 时间
    flow_arrow = "flow_arrow"            # 流程箭头：前后依赖的操作序列
    callout = "callout"                  # 气泡标注：单点强调
    gate_state = "gate_state"            # 开关/闸门状态：开/半开/关
    table = "table"                      # 表格：表头 + 行（竖线分隔单元格）
    annotation = "annotation"            # 标注示意图：编号点 + 图例
    device_scene = "device_scene"        # 设备三维场景：受控设备 + 动作进度 + 部件高亮
    baked_figure = "baked_figure"        # 离线烘焙的静态图：指导书主图（画质优先，不可交互）


# 每个原语允许的参数键。未列出的键一律拒绝，防止 LLM 塞任意内容。
_ALLOWED_PARAMS: dict[Primitive, set[str]] = {
    Primitive.step_card: {"index", "action", "hint", "icon"},
    Primitive.meter: {"value", "unit", "min", "max", "label"},
    Primitive.status_light: {"state", "label"},
    Primitive.wiring: {"terminals", "wire_color", "note"},
    Primitive.connector: {"pins", "note"},
    Primitive.torque_gauge: {"target", "tolerance", "unit"},
    Primitive.checklist: {"items"},
    Primitive.motion_timeline: {"steps", "total", "label"},
    Primitive.flow_arrow: {"steps", "label"},
    Primitive.callout: {"target", "note", "position"},
    Primitive.gate_state: {"state", "label", "note"},
    Primitive.table: {"headers", "rows", "label"},
    Primitive.annotation: {"title", "points", "note"},
    # device_scene 的参数刻意只有三个：设备、进度、高亮部件。
    # 相机、颜色、几何一律**不给模型**——那些是构建期决定的，模型碰一次就错一次。
    Primitive.device_scene: {"subject", "t", "part"},
    # 只给路径与替代文字。尺寸/滤镜/背景一律不给——那是构建期决定的。
    Primitive.baked_figure: {"src", "alt"},
}

# 必填参数：缺了就不是"降级成文字"，而是渲染出一张没有信息量的空图。
# 校验放在服务端，模型才会收到明确的拒绝理由去补。
_REQUIRED_PARAMS: dict[Primitive, set[str]] = {
    Primitive.motion_timeline: {"steps"},
    Primitive.flow_arrow: {"steps"},
    Primitive.callout: {"target", "note"},
    Primitive.gate_state: {"state"},
    Primitive.table: {"headers", "rows"},
    Primitive.annotation: {"points"},
    # t 必填。省略 t 由前端挑一帧，和让模型编一个 t 是同一件事：图上停在哪个工步
    # 没人知道。三维图唯一的价值就是"这一步设备长什么样"，这一项不能有默认值。
    Primitive.device_scene: {"subject", "t"},
    Primitive.baked_figure: {"src", "alt"},
}

# 设备白名单：subject → 可高亮的部件键。
# 这张表必须与前端 `figures/devices/*.ts` 里 `parts` 的键一一对应；
# 模型只能在这张表里选，选错即拒绝——它没有几何信息，放任自由填就等于让它编结构。
DEVICE_SUBJECTS: dict[str, tuple[str, ...]] = {
    "door": ("leaf_l", "leaf_r", "frame", "lamp"),
    "pantograph": ("arms", "head", "frame", "drive", "drive2", "lamp"),
    "cabinet": ("breakers", "contactor", "relays", "lamps", "terminals", "board"),
    # 以下四台是「工具 + 作业动作」：指导书里出现频率最高的四件手动作业，
    # 此前只有 2D 原语（meter / torque_gauge / checklist），看不出"手怎么动"。
    "multimeter": ("body", "dial", "screen", "probes", "terminals"),
    "warning_sign": ("plate", "cord", "handle", "door"),
    "feeler_gauge": ("blades", "case", "gap", "seal"),
    "torque_wrench": ("wrench", "socket", "bolt", "bracket", "window"),
}

# 部件的中文说明：键是英文的（`drive` / `drive2` 这类），说明是给人看的。
#
# 为什么要单独一张表：只给键不给释义，模型只能从名字猜——`drive` 猜成"门机驱动"
# 还是"气路控制箱"都说得通，猜错就高亮到别的件上，而页面上高亮本身就"看着合理"，
# 没有人能从结果反推它理解错了。写一句说明，模型选键时才是在做语义选择。
DEVICE_PART_LABELS: dict[str, dict[str, str]] = {
    "door": {
        "leaf_l": "左门扇（含门锁与携门架）",
        "leaf_r": "右门扇（含门锁与携门架）",
        "frame": "门框与门楣设备舱（门槛压条、密封面）",
        "lamp": "门状态指示灯（门机罩前脸）",
    },
    "pantograph": {
        "arms": "桁架臂（双下臂 + 上臂 + 平衡杆）",
        "head": "弓头（碳滑板、弓角、悬挂弹簧）",
        "frame": "底架与绝缘子、车顶板",
        "drive": "气路控制箱（压力表、总风管、软管）",
        "drive2": "升弓气囊与降弓阻尼器（出力与限速两支不同的缸）",
        "lamp": "到位指示灯",
    },
    "cabinet": {
        "breakers": "断路器（三极主断 + 两个单极，含灭弧室与脱扣机构）",
        "contactor": "接触器（衔铁与主触点）",
        "relays": "继电器组（三只，带状态灯）",
        "lamps": "指示灯（电源、运行、告警）",
        "terminals": "端子排（10 位）",
        "board": "柜内安装背板",
    },
    "multimeter": {
        "body": "表体与黄色护套（手持式数字万用表）",
        "dial": "档位旋钮（本图停在直流电压档）",
        "screen": "液晶读数（含单位与小数点）",
        "probes": "红黑表笔（表笔线、笔身、探针）",
        "terminals": "被测端子排（正极、负极、编号）",
    },
    "warning_sign": {
        "plate": "牌面（禁止合闸 有人工作，白底红字）",
        "cord": "挂绳与挂环",
        "handle": "隔离点操作把手（挂牌处）",
        "door": "门体与门边（被隔离的设备）",
    },
    "feeler_gauge": {
        "blades": "塞尺片（0.50 mm 单片，含厚度刻字）",
        "case": "尺壳与铆轴（其余叠片）",
        "gap": "门缝（被测间隙）",
        "seal": "门框密封面（橡胶条与压紧面）",
    },
    "torque_wrench": {
        "wrench": "力矩扳手本体与手柄（预置式，到值咔嗒）",
        "socket": "套筒（方孔与六角口）",
        "bolt": "门机安装螺栓（六角头）",
        "bracket": "安装座与螺纹孔",
        "window": "刻度窗与指针（设定值 25 N·m）",
    },
}

# 每台设备在时间轴上的「可指名瞬间」：(t, key, 屏幕上的样子)。
#
# t 是连续值，但工艺文本里的动作是有名字的——「升弓到位」「过载脱扣」「退出密封面」。
# 让模型在表里挑一个已知瞬间，比让它猜一个 0–1 的小数可靠得多：猜错时图上的设备
# 停在别的工步，而这在页面上完全看不出来（图好看、读数也对，只是不是这一步）。
# 取值必须与 `web/src/figures/devices/*.ts` 里各设备的 setT 阈值一致。
DEVICE_MOMENTS: dict[str, tuple[tuple[float, str, str], ...]] = {
    "door": (
        (0.0, "closed", "关闭锁定"),
        (0.05, "unlocking", "门锁解锁、锁舌缩回"),
        (0.14, "popping", "退出密封面"),
        (0.55, "opening", "门扇滑移中段"),
        (0.95, "open", "完全开启"),
    ),
    "pantograph": (
        (0.0, "lowered", "落弓锁定"),
        (0.08, "pressurising", "气路建压"),
        (0.33, "raising", "升弓中段"),
        (0.61, "contacting", "接触压力建立"),
        (0.72, "raised", "升弓到位、保压"),
        (0.88, "lowering", "降弓中（阻尼限速）"),
    ),
    "cabinet": (
        (0.0, "off", "未上电"),
        (0.07, "closing", "主断路器合闸"),
        (0.5, "pulled", "接触器吸合"),
        (0.75, "ready", "系统就绪"),
        (0.82, "tripped", "过载脱扣（手柄停在中间位）"),
        (1.0, "restored", "复位后重新合闸"),
    ),
    "multimeter": (
        (0.0, "dialed", "档位置于直流电压档"),
        (0.3, "probe_plus", "红表笔搭上正极端子"),
        (0.55, "probe_minus", "黑表笔搭上负极端子"),
        (0.78, "reading", "读数稳定（24.1 V）"),
        (1.0, "withdrawn", "撤笔、读数保持"),
    ),
    "warning_sign": (
        (0.0, "crooked", "牌已挂在把手上、尚未摆正"),
        (0.35, "seated", "挂绳滑入把手内侧"),
        (0.6, "released", "牌面离手、下垂"),
        (0.82, "settled", "摆动收住、牌面摆正"),
        (1.0, "checked", "挂牌到位、牌面朝向作业面"),
    ),
    "feeler_gauge": (
        (0.0, "fanned", "展开选片（0.50 mm）"),
        (0.35, "aligned", "片端对准门缝"),
        (0.62, "inserted", "塞尺插入门缝"),
        (0.82, "sliding", "沿缝滑动检查"),
        (1.0, "withdrawn", "抽出并判定"),
    ),
    "torque_wrench": (
        (0.0, "seated", "套筒套入螺栓"),
        (0.42, "snug", "预紧、扳手贴平"),
        (0.7, "loaded", "施力、刻度接近设定值"),
        (0.86, "clicked", "到扭矩咔嗒脱扣"),
        (1.0, "marked", "复检并做防松标记"),
    ),
}

# t 的容差。模型照表抄也可能写出 0.549、0.551 这种数（它习惯把连续量"算一下"），
# 差 0.01 在图上肉眼看不出，所以容差内直接吸附到表里的值；超容差就是选错了瞬间，
# 拒掉比画出来好——画出来没人能发现，那才是真正的失败。
DEVICE_T_TOLERANCE = 0.02

# subject 只能出现在哪类工位。
# 三维场景跨系统一定是模型理解错了工位——让它渲染出来比拒掉更糟：
# 一份车门指导书里出现受电弓，看的人第一反应是「这系统不可信」。
DEVICE_SYSTEMS: dict[str, frozenset[str]] = {
    "door": frozenset({"door"}),
    "pantograph": frozenset({"pantograph"}),
    # 配电柜（门控器供电、上电自检）属于车门系统，不是独立工位
    "cabinet": frozenset({"door"}),
    # 工具类跟着人走：万用表、警示牌三个系统都用；塞尺只量门缝（空调/受电弓没有这道工序）；
    # 力矩扳手在车门门机与受电弓底架螺栓上都用。
    "multimeter": frozenset({"door", "hvac", "pantograph"}),
    "warning_sign": frozenset({"door", "hvac", "pantograph"}),
    "feeler_gauge": frozenset({"door"}),
    "torque_wrench": frozenset({"door", "pantograph"}),
}

# 每份指导书最多几张三维图。与 prompt 里的约束同一处定义，避免"提示词说 2、代码放 5"。
#
# 2026-11-10 由 2 提到 3：新增的四台都是"手怎么动"的工具场景，一份 8 步指导书里
# 「挂牌 → 测量 → 复紧」正好三处，卡在 2 会让模型被迫丢掉其中一处最该看动作的步骤。
# 代价可控：三维组件是动态 import + 按页挂载（翻页阅读器只挂当前页与左右各一页），
# 不在首屏，也不在 DOM 里堆一叠 canvas。
MAX_DEVICE_SCENES = 3

# 公开给 prompt 使用：枚举值只在这里定义一次，避免"文档写一套、校验另一套"。
STATE_VALUES = ("pass", "warn", "danger", "idle")
GATE_STATES = ("open", "closed", "half")
CALLOUT_POSITIONS = ("left", "right", "top", "bottom")


class MotionAnim(str, Enum):
    """动效类型。每一种都对应一条**有语义**的现场动作，不是装饰。

    - pulse：呼吸，表示"注意这里"（可反复，不误导时序）
    - blink：闪烁，表示"异常/禁止"（比 pulse 更急）
    - flow：沿线流动，表示方向（只对描边有效）
    - draw：描边生长，表示"从此处开始"（只对描边有效，只播一次）
    - shake：抖动，表示"超差/告警"
    """

    pulse = "pulse"
    blink = "blink"
    flow = "flow"
    draw = "draw"
    shake = "shake"


# 槽位：原语内部"可动的那一小块"。整图动起来只会让现场找不到重点，
# 所以只给图上确实存在、动起来也不会改变语义的部位开口子。
_MOTION_SLOTS: dict[Primitive, set[str]] = {
    Primitive.status_light: {"lamp"},
    Primitive.meter: {"needle", "readout"},
    Primitive.gate_state: {"leaf"},
    Primitive.flow_arrow: {"arrow"},
    Primitive.motion_timeline: {"segment"},
}

# 描边类动效只能落在描边元素上：给填充色块加 draw，会得到一片空白。
_STROKE_SLOTS: set[tuple[Primitive, str]] = {
    (Primitive.meter, "needle"),
    (Primitive.flow_arrow, "arrow"),
}
_STROKE_ONLY_ANIMS = {MotionAnim.flow, MotionAnim.draw}


def motion_slots() -> dict[str, list[str]]:
    """给 prompt 与 `/schema/visual` 共用：哪些原语、哪些槽位能动。"""
    return {p.value: sorted(slots) for p, slots in _MOTION_SLOTS.items()}


def stroke_slots() -> dict[str, list[str]]:
    """描边槽位：`flow` / `draw` 只对这些槽位有效。

    单独导出是因为这条规则**只在代码里存在过**：prompt 只列了「每个原语能取哪些
    target」，没说 anim 与 target 的组合限制。2026-11-02 线上实测，模型给非描边
    槽位挂了 `draw`，两次调用全部作废（62s / ¥0.10）。
    """
    grouped: dict[str, list[str]] = {}
    for primitive, slot in _STROKE_SLOTS:
        grouped.setdefault(primitive.value, []).append(slot)
    return {name: sorted(slots) for name, slots in grouped.items()}


def stroke_only_anims() -> list[str]:
    return sorted(anim.value for anim in _STROKE_ONLY_ANIMS)


class MotionTrack(BaseModel):
    """一条动效轨道，对应计划 §2.1 的 `tracks[{target, anim, duration}]`。

    `duration` 收在 400–2400ms：短于 400ms 现场看不成"动作"，长于 2.4s
    一次循环还没走完人已经看下一步了。前端按 ≤600 / ≤1200 / >1200 分三档，
    因为 CSP 禁内联样式，不能把毫秒数写进 style 属性。
    """

    model_config = ConfigDict(extra="forbid")

    target: str = Field(min_length=1, max_length=16)
    anim: MotionAnim
    duration: int = Field(default=900, ge=400, le=2400)


def device_subjects() -> dict[str, list[str]]:
    """给 prompt 与 `/schema/visual` 共用：可用设备与可高亮部件。

    和 `allowed_params` 同一个理由——枚举只在代码里定义一次，
    否则 prompt 里写的和校验认的迟早对不上。
    """
    return {name: list(parts) for name, parts in DEVICE_SUBJECTS.items()}


def device_catalog() -> dict[str, dict[str, object]]:
    """给 prompt 与 `/schema/visual` 共用：每台设备的部件、可指名瞬间、所属工位。

    四个字段一起发，是因为它们**缺一不可**：只给 subject 列表，模型会自己编 t；
    只给 t，模型会把受电弓放进车门指导书；只给部件键不给释义（`part_labels`），
    `drive` 与 `drive2` 在模型眼里是两个没有语义的缩写。分开发就等于让调用方去拼。
    """
    return {
        name: {
            "parts": list(parts),
            "part_labels": dict(DEVICE_PART_LABELS[name]),
            "moments": [
                {"t": t, "key": key, "label": label}
                for t, key, label in DEVICE_MOMENTS[name]
            ],
            "systems": sorted(DEVICE_SYSTEMS[name]),
        }
        for name, parts in DEVICE_SUBJECTS.items()
    }


def allowed_params() -> dict[str, list[str]]:
    """给 prompt 与 `/schema/visual` 共用，避免"文档说允许、代码拒绝"的漂移。"""
    return {p.value: sorted(keys) for p, keys in _ALLOWED_PARAMS.items()}


class VisualSpec(BaseModel):
    """一条图示声明。渲染器按 primitive 分发，参数做二次校验。"""

    model_config = ConfigDict(extra="forbid")

    primitive: Primitive
    params: dict[str, ParamValue] = Field(default_factory=dict)
    caption: str | None = Field(default=None, max_length=60)
    fallback_text: str = Field(min_length=2, max_length=200)
    # 动效是可选的强调手段：不写就是静态图，写了必须过槽位与动效的兼容校验。
    motion: list[MotionTrack] = Field(default_factory=list, max_length=MAX_MOTION_TRACKS)

    @field_validator("params")
    @classmethod
    def _check_params(cls, v: dict[str, ParamValue]) -> dict[str, ParamValue]:
        for key, val in v.items():
            if isinstance(val, list):
                if len(val) > MAX_LIST_ITEMS:
                    raise ValueError(f"参数 {key} 列表过长（>{MAX_LIST_ITEMS} 项）")
                for item in val:
                    if not isinstance(item, str):
                        raise ValueError(f"参数 {key} 的列表只能包含字符串")
                    if len(item) > MAX_LIST_ITEM_CHARS:
                        raise ValueError(f"参数 {key} 的列表项过长（>{MAX_LIST_ITEM_CHARS} 字）")
                    if "<" in item or "javascript:" in item.lower():
                        raise ValueError(f"参数 {key} 的列表项含疑似标记内容")
                continue
            if isinstance(val, str) and len(val) > 120:
                raise ValueError(f"参数 {key} 过长（>120 字符）")
            if isinstance(val, str) and ("<" in val or "javascript:" in val.lower()):
                raise ValueError(f"参数 {key} 含疑似标记内容，禁止进入渲染层")
        return v

    def validate_against_primitive(self) -> None:
        """按原语校验参数键、必填项与枚举值。schema 层只做结构，语义在这里。"""
        allowed = _ALLOWED_PARAMS[self.primitive]
        unknown = set(self.params) - allowed
        if unknown:
            raise ValueError(f"{self.primitive.value} 不支持参数: {sorted(unknown)}")

        missing = _REQUIRED_PARAMS.get(self.primitive, set()) - set(self.params)
        if missing:
            raise ValueError(f"{self.primitive.value} 缺少必填参数: {sorted(missing)}")

        if self.primitive is Primitive.baked_figure:
            src = self.params.get("src")
            alt = self.params.get("alt")
            if not isinstance(src, str) or not BAKED_SRC_RE.match(src):
                raise ValueError(
                    "baked_figure.src 必须是 /figures/ 下的静态路径（.webp/.jpg/.png）"
                )
            if ".." in src:
                raise ValueError("baked_figure.src 不能包含 ..")
            if not isinstance(alt, str) or not alt.strip():
                raise ValueError("baked_figure.alt 不能为空：图片必须有替代文字")

        if self.primitive is Primitive.status_light:
            state = self.params.get("state")
            if state not in STATE_VALUES:
                raise ValueError(f"status_light.state 必须是 {sorted(STATE_VALUES)}")

        if self.primitive is Primitive.gate_state:
            state = self.params.get("state")
            if state not in GATE_STATES:
                raise ValueError(f"gate_state.state 必须是 {sorted(GATE_STATES)}")

        if self.primitive is Primitive.callout:
            position = self.params.get("position", "right")
            if position not in CALLOUT_POSITIONS:
                raise ValueError(f"callout.position 必须是 {sorted(CALLOUT_POSITIONS)}")

        if self.primitive is Primitive.motion_timeline:
            steps = self.params.get("steps")
            if not isinstance(steps, list) or not 2 <= len(steps) <= 6:
                raise ValueError("motion_timeline.steps 必须是 2–6 项的字符串数组")

        if self.primitive is Primitive.flow_arrow:
            steps = self.params.get("steps")
            if not isinstance(steps, list) or not 2 <= len(steps) <= 5:
                raise ValueError("flow_arrow.steps 必须是 2–5 项的字符串数组")

        if self.primitive is Primitive.annotation:
            points = self.params.get("points")
            if not isinstance(points, list) or not 1 <= len(points) <= 6:
                raise ValueError("annotation.points 必须是 1–6 项的字符串数组")

        if self.primitive is Primitive.table:
            headers = self.params.get("headers")
            rows = self.params.get("rows")
            if not isinstance(headers, list) or not 2 <= len(headers) <= 4:
                raise ValueError("table.headers 必须是 2–4 项的字符串数组")
            if not isinstance(rows, list) or not 1 <= len(rows) <= 10:
                raise ValueError("table.rows 必须是 1–10 项的字符串数组")
            for row in rows:
                # 行列不齐是表格最典型的模型错误：多给一列会被画到边界外，
                # 少给一列会让后面的值整体左移，现场读到的就是错的标准。
                if not isinstance(row, str) or len(row.split("|")) != len(headers):
                    raise ValueError(
                        f"table.rows 每行必须用 | 分成 {len(headers)} 格，与 headers 对齐"
                    )

        if self.primitive is Primitive.device_scene:
            subject = self.params.get("subject")
            if subject not in DEVICE_SUBJECTS:
                raise ValueError(
                    f"device_scene.subject 必须是 {sorted(DEVICE_SUBJECTS)}"
                )
            part = self.params.get("part")
            if part is not None and part not in DEVICE_SUBJECTS[subject]:
                options = "、".join(
                    f"{key}={label}"
                    for key, label in DEVICE_PART_LABELS[subject].items()
                )
                raise ValueError(
                    f"device_scene.part 在 {subject} 下只能是：{options}；收到 {part}"
                )
            raw = self.params.get("t")
            if raw is None:
                # 正常走不到：`_REQUIRED_PARAMS` 已在上面拦掉。留着是为了
                # `validate_against_primitive()` 被单独调用时也有明确报错。
                raise ValueError("device_scene.t 必填：必须指明这张图停在哪个瞬间")
            try:
                progress = float(raw)  # 模型可能给 "0.6" 这种字符串
            except (TypeError, ValueError):
                raise ValueError("device_scene.t 必须是 0–1 的数值") from None
            if not 0.0 <= progress <= 1.0:
                raise ValueError("device_scene.t 必须在 0–1 之间")
            # 只认表里的瞬间。这是这一段唯一真正要紧的约束：0.6 就落在 0–1 之间，
            # 也画得出一张好看的图，但它对应的是别的工步——图、读数、判据全对，
            # 只有"这是哪一步"错了，而页面上没有任何东西能暴露这一点。
            moments = DEVICE_MOMENTS[subject]
            nearest_t = min(moments, key=lambda m: abs(m[0] - progress))[0]
            if abs(nearest_t - progress) > DEVICE_T_TOLERANCE:
                allowed = "、".join(f"{t:.2f}={label}" for t, _, label in moments)
                raise ValueError(
                    f"device_scene.t 在 {subject} 下只能取设备表里的瞬间"
                    f"（容差 ±{DEVICE_T_TOLERANCE}）：{allowed}；收到 {progress}"
                )
            # 容差内吸附到表内值：同一瞬间差 1–2% 看不出来，但会让同一份指导书里的
            # 两个 t 落在不同帧，打印出的静态帧和滑块读数对不上。
            self.params["t"] = nearest_t

        self._check_motion()

    def _check_motion(self) -> None:
        """动效校验：槽位存在、不重复、描边动效不落到填充元素上。

        三条都只在服务端判：前端 `motionClass()` 找不到槽位会静默不画，
        静默正是最坏的结果——模型以为加了强调，现场什么都没发生。
        """
        if not self.motion:
            return
        slots = _MOTION_SLOTS.get(self.primitive) or set()
        if not slots:
            raise ValueError(
                f"{self.primitive.value} 不支持 motion；可动原语：{sorted(motion_slots())}"
            )
        seen: set[str] = set()
        for track in self.motion:
            if track.target not in slots:
                raise ValueError(
                    f"{self.primitive.value}.motion.target 必须是 {sorted(slots)} 之一"
                )
            if track.target in seen:
                # 同一槽位两条轨道会互相覆盖，谁赢取决于 CSS 顺序——不可预测即不可用。
                raise ValueError(f"motion.target {track.target} 重复")
            seen.add(track.target)
            if track.anim in _STROKE_ONLY_ANIMS and (
                self.primitive,
                track.target,
            ) not in _STROKE_SLOTS:
                names = sorted(f"{p.value}.{s}" for p, s in _STROKE_SLOTS)
                raise ValueError(f"{track.anim.value} 只能用于描边槽位：{names}")

        # meter 的两个槽位都是「有读数才画」的元素：没有 value 时 Meter 只画量程条，
        # 指针和读数根本不存在。允许这种轨道等于允许一条静默失效的强调——
        # 生产实测就是这样：hvac 那份样例给"要求 1.4-1.8 MPa"（无 value）挂了 needle，
        # 页面上一帧动画都没有，而校验、发布、刷新三道关全放行。
        if self.primitive is Primitive.meter and self.params.get("value") is None:
            raise ValueError(
                "meter 没有 value 时不渲染指针与读数，无法承载 motion；"
                "请给 params.value 或在有读数的仪表上加动效"
            )
