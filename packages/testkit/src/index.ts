/**
 * @bellis/testkit — 确定性测试设施（仅开发/测试依赖，生产包禁止引用）。
 *
 * Gate 1 冻结导出：VirtualClock。P3 只能追加新导出，
 * 不得删除、重命名或改变既有行为（phase-1-build-guide.md §12.3）。
 */
export { VirtualClock } from "./virtual-clock.js";
