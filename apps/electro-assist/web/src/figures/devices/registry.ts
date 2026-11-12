/** 设备构建表的**唯一**登记处：subject → 懒加载的构建函数。
 *
 *  ## 为什么单独抽出来
 *  这张表原来写在 `DeviceScene.vue` 里，而测试有自己的一份 `BUILDERS`。
 *  两处登记的结果是：给后端加了一台设备、测试也补了 builder，**运行时仍然查不到**，
 *  页面显示"未注册的设备场景：driver_desk · 已降级为文字说明"，
 *  而全套单测是绿的（2026-11-13 实际踩到，司机操纵台第一次打开就是这句）。
 *
 *  抽成模块后，`builders.spec.ts` 直接断言"契约里的每台设备这里都有登记"，
 *  两处漂移不可能再发生。
 *
 *  ## 为什么是函数而不是组件
 *  每个条目返回一个 `import()` 的 thunk：翻到没有这台设备的页就不下载它。
 *  Three.js 与设备几何都在这条懒加载链上，首屏一个字节都不该为它们付。
 */
import type { DeviceRig } from './rig'

export const DEVICE_BUILDERS: Record<string, () => Promise<() => DeviceRig>> = {
  door: async () => (await import('./door')).buildDoor,
  pantograph: async () => (await import('./pantograph')).buildPantograph,
  cabinet: async () => (await import('./cabinet')).buildCabinet,
  hvac: async () => (await import('./hvac')).buildHvac,
  // 工具类四台：静态资源同样按需加载，翻到没有它们的那一页就不下载
  multimeter: async () => (await import('./multimeter')).buildMultimeter,
  warning_sign: async () => (await import('./warning_sign')).buildWarningSign,
  feeler_gauge: async () => (await import('./feeler_gauge')).buildFeelerGauge,
  torque_wrench: async () => (await import('./torque_wrench')).buildTorqueWrench,
  // 司机操纵台：升弓试验的交互台面
  driver_desk: async () => (await import('./driver_desk')).buildDriverDesk,
}
