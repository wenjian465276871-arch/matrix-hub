"""判据单位：归一化 + 符号表校验（计划 §12.8）。

**为什么需要它**：模型从中文工艺卡里抄出来的往往是「毫米」「摄氏度」「MM」这类写法，
而契约只约束了长度（≤3 字符）。不归一化的话，同一份指导书里会出现 `mm` / `毫米` / `MM`
三种写法，现场读数时没法对照；而长度校验对它们全部放行，所以问题不会暴露，只会积累。

两条边界：

1. **只做等价改写，不做换算**：`2 cm` 不会变成 `20 mm`。换算是事实变更，必须由人做，
   模型和服务端都不许替用户改数值。
2. **表外的符号不猜**：抛 `UnitError` 并附上符号表。猜一个近似单位（把 `kgf` 当成 `N`）
   比报错危险得多——现场照着错的单位读数，比生成失败严重。

NFKC 会做两件有用的事：全角 `ｍｍ` → `mm`，`℃` → `°C`（所以表里存的是 `°C`）。
"""
from __future__ import annotations

import unicodedata

# 规范符号表：全部 ≤3 字符（与 `Criterion.unit` 的 max_length 同一口径）。
# 分组只为报错时好读，校验时是一个集合。
CANONICAL: dict[str, tuple[str, ...]] = {
    "长度": ("mm", "cm", "m", "km", "μm"),
    "时间": ("s", "ms", "min", "h"),
    "温度": ("°C", "K"),
    "电压": ("V", "mV", "kV"),
    "电流": ("A", "mA", "kA"),
    "电阻": ("Ω", "kΩ", "MΩ"),
    "压力": ("Pa", "kPa", "MPa", "bar"),
    "力": ("N", "kN"),
    "扭矩": ("N·m",),
    "容积": ("L", "mL"),
    "速度": ("m/s", "rpm"),
    "频率": ("Hz", "kHz"),
    "角度": ("°",),
    # `dBA` 而不是 `dB(A)`：`Criterion.unit` 的 max_length 是 3，
    # 五个字符的写法进不了契约。别名负责吸收 `dB(A)` / `dB（A）`（NFKC 后同形）。
    "其它": ("%", "dB", "dBA"),
    "计数": ("次", "个", "处", "根", "只", "台", "套", "张", "片", "组", "道"),
}

ALLOWED: frozenset[str] = frozenset(symbol for group in CANONICAL.values() for symbol in group)

# 常见写法 → 规范符号。键是 NFKC + 去空白之后的形式。
# 只收"意思唯一"的写法：`度` 在工艺卡上几乎都指角度，收；`斤`、`公斤` 这类
# 既可能是力也可能是质量，不收——歧义映射比不映射更危险。
_ALIASES: dict[str, str] = {
    # 长度
    "毫米": "mm",
    "厘米": "cm",
    "米": "m",
    "千米": "km",
    "公里": "km",
    "微米": "μm",
    # 时间
    "秒": "s",
    "毫秒": "ms",
    "分钟": "min",
    "分": "min",
    "小时": "h",
    # 温度
    "摄氏度": "°C",
    "开尔文": "K",
    # 电
    "伏": "V",
    "伏特": "V",
    "毫伏": "mV",
    "千伏": "kV",
    "安": "A",
    "安培": "A",
    "毫安": "mA",
    "千安": "kA",
    "欧": "Ω",
    "欧姆": "Ω",
    "千欧": "kΩ",
    "兆欧": "MΩ",
    # 压力 / 力 / 扭矩
    "帕": "Pa",
    "帕斯卡": "Pa",
    "千帕": "kPa",
    "兆帕": "MPa",
    "巴": "bar",
    "牛": "N",
    "牛顿": "N",
    "千牛": "kN",
    "牛米": "N·m",
    "牛·米": "N·m",
    "牛顿米": "N·m",
    # 扭矩的写法差异（2026-11-08 补）：工艺卡上 `N.m` / `Nm` / `N m` 都表示同一个量。
    # `N m` 去空白后与 `Nm` 同形，所以只需一条。**不予收录**：`nm`（小写）——
    # 那是纳米，与扭矩同形不同量纲，歧义映射比拒绝危险。
    "N.m": "N·m",
    "Nm": "N·m",
    "N*m": "N·m",
    "N．m": "N·m",  # 全角点，NFKC 不折它
    # 容积（2026-11-08 新增组）：加注量在工艺卡上写 `L` / `l` / `升` 的都很常见
    "l": "L",
    "升": "L",
    "公升": "L",
    "ml": "mL",
    "毫升": "mL",
    # A 计权声压级：规范符号压到 3 字符以内（见 CANONICAL 的说明）
    "dB(A)": "dBA",
    "dB（A）": "dBA",
    "db(a)": "dBA",
    # 速度 / 频率
    "米每秒": "m/s",
    "米/秒": "m/s",
    "转/分": "rpm",
    "转每分": "rpm",
    "赫兹": "Hz",
    "赫": "Hz",
    "千赫": "kHz",
    "千赫兹": "kHz",
    # 角度 / 其它
    "度": "°",
    "百分比": "%",
    "分贝": "dB",
    # 常见大小写误写（只收在本领域语义唯一的）
    "MM": "mm",
    "CM": "cm",
    "v": "V",
    "a": "A",
    "n": "N",
}


class UnitError(ValueError):
    """单位不在符号表内。`str(exc)` 已经包含可用符号表，可直接回给用户/模型。"""


def normalize(raw: str) -> str:
    """把一个单位写法尽量折成规范符号；折不成就原样返回（由 `check` 决定要不要拒）。"""
    text = unicodedata.normalize("NFKC", raw).strip()
    # 工艺卡上常见 "N m"、"m / s" 这种带空格的写法：先去空白再查表。
    text = text.replace(" ", "").replace("\u3000", "")
    return _ALIASES.get(text, text)


def table_text() -> str:
    """符号表的人类可读形式，进错误信息用。"""
    return "；".join(f"{name}: {' / '.join(symbols)}" for name, symbols in CANONICAL.items())


def check(raw: str) -> str:
    """归一化并校验，返回规范符号；表外抛 `UnitError`。

    空串按"没填"处理，交给 `Criterion` 自己的必填校验——这里不替它报错。
    """
    text = normalize(raw)
    if not text:
        return text
    if text not in ALLOWED:
        raise UnitError(f"单位「{raw}」不在符号表内。可用符号：{table_text()}")
    return text


def normalize_guide(guide) -> dict[str, int]:
    """把整份 Guide 的判据单位折成规范符号，返回 `{"changed": n, "checked": m}`。

    只改写法不改数值。遇到表外符号直接抛——生成就此失败，总比落一份单位可疑的
    指导书强（现场照错的单位读数，后果比"生成失败请重试"严重得多）。
    """
    changed = 0
    checked = 0
    for step in guide.steps:
        for criterion in step.criteria:
            if criterion.unit is None:
                continue
            checked += 1
            before = criterion.unit
            after = check(before)
            if after != before:
                criterion.unit = after
                changed += 1
    return {"changed": changed, "checked": checked}
