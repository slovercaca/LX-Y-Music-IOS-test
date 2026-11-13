/**
 * sim-settingdetail-registry.js
 *
 * 设置页注册表一致性契约（2026-11-13）。
 *
 * 背景（真实 bug）：
 *   失败策略（failure_strategy）只注册了 SETTING_SCREENS 列表与
 *   Setting/Main.tsx 的映射 + switch，漏了 SettingDetail/index.tsx
 *   自己那份 SETTING_COMPONENTS 映射。竖屏点「失败策略」时
 *   `SETTING_COMPONENTS[settingId] ?? Basic` 兜底成基础设置，
 *   标题仍是「失败策略」、内容却是基础设置，选项找不到。
 *   TS 的 Record 类型本应报错，但项目只做转译语法检查，不跑全量
 *   类型检查，所以漏网。
 *
 * 本脚本钉住的不变量：
 *   - SETTING_SCREENS（列表）= Main.tsx 的 SETTING_COMPONENTS 键
 *     = Main.tsx switch 的 case = SettingDetail 的 SETTING_COMPONENTS 键，
 *     四处必须完全一致，缺一不可。
 *   - SettingDetail 映射到的每个组件都必须在同文件里有 import。
 *
 * 运行：node scripts/sim-settingdetail-registry.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MAIN = path.join(ROOT, 'src/screens/Home/Views/Setting/Main.tsx')
const DETAIL = path.join(ROOT, 'src/screens/SettingDetail/index.tsx')

let failures = 0
const check = (ok, msg) => {
  if (ok) {
    console.log(`  ✓ ${msg}`)
  } else {
    failures++
    console.log(`  ✗ ${msg}`)
  }
}

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

// 提取 SETTING_SCREENS 数组里的 id
const extractScreens = (src) => {
  const m = src.match(/SETTING_SCREENS = \[([\s\S]*?)\] as const/)
  if (!m) return null
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
}

// 提取 SETTING_COMPONENTS 映射的键与值（组件名）
const extractMap = (src) => {
  const m = src.match(/SETTING_COMPONENTS[^=]*= \{([\s\S]*?)\n\}/)
  if (!m) return null
  const entries = [...m[1].matchAll(/^\s*([a-z_]+):\s*([A-Za-z]+),?\s*$/gm)]
  return new Map(entries.map(([, k, v]) => [k, v]))
}

// 提取 switch 里的 case id
const extractSwitchCases = (src) => {
  return [...src.matchAll(/case '([a-z_]+)':/g)].map((x) => x[1])
}

const setEq = (a, b) => {
  const sa = new Set(a)
  const sb = new Set(b)
  return sa.size === sb.size && [...sa].every((x) => sb.has(x))
}

console.log('设置页注册表一致性契约：')

const mainSrc = read(MAIN)
const detailSrc = read(DETAIL)

const screens = extractScreens(mainSrc)
check(Array.isArray(screens) && screens.length > 0, `SETTING_SCREENS 可解析（${screens ? screens.length : 0} 个）`)

const mainMap = extractMap(mainSrc)
check(mainMap !== null, 'Main.tsx 的 SETTING_COMPONENTS 可解析')
if (screens && mainMap) {
  check(setEq(screens, [...mainMap.keys()]), 'Main.tsx 映射键 = SETTING_SCREENS')
}

const switchCases = extractSwitchCases(mainSrc)
if (screens) {
  check(setEq(screens, switchCases), 'Main.tsx switch case = SETTING_SCREENS')
}

const detailMap = extractMap(detailSrc)
check(detailMap !== null, 'SettingDetail 的 SETTING_COMPONENTS 可解析')
if (screens && detailMap) {
  check(setEq(screens, [...detailMap.keys()]), 'SettingDetail 映射键 = SETTING_SCREENS')
}

// SettingDetail 映射到的组件都必须有 import
if (detailMap) {
  const imports = new Set([...detailSrc.matchAll(/^import ([A-Za-z]+) from /gm)].map((x) => x[1]))
  const missing = [...detailMap.values()].filter((c) => !imports.has(c))
  check(missing.length === 0, `SettingDetail 映射组件全部有 import${missing.length ? `（缺：${missing.join(', ')}）` : ''}`)
}

// 反例自检：故意漏掉一个 id 时，比较必须能发现不一致
if (screens && screens.length > 1) {
  const dropped = screens.slice(0, -1)
  check(!setEq(screens, dropped), '反例自检：漏一个 id 时比较能发现不一致')
}

if (failures > 0) {
  console.log(`共 ${failures} 项失败`)
  process.exit(1)
}
console.log('全部通过')
