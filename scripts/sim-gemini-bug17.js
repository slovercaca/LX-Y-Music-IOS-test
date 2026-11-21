/**
 * sim-gemini-bug17.js
 *
 * Bug 17（Gemini 全量审查 2026-11-21，核实：真实）：
 * src/plugins/player/soundEffect/constants.ts 的 normalizeConvolutionGain
 * 缺少 isFinite 校验。
 *
 * 机制：相邻的 normalizeEqualizerGain 已有 `if (!Number.isFinite(gain)) return 0`，
 * 混响版 `Math.min(50, Math.max(0, Math.round(gain)))` 漏了。调用链 controller.ts
 * 把持久化设置值直接传入，经 adapter 直通原生；UI 层对同一设置值已有 isFinite
 * 防御，控制器是未设防的通路。
 * 核实报告修正：NaN/undefined → Math.round 得 NaN → 泄漏，属实；但 ±Infinity
 * 已被钳位处理（+Inf→50，-Inf→0），"Infinity 返回 NaN"不成立。
 *
 * 修法：入口加 `if (!Number.isFinite(gain)) return 0`，与 EQ 版对齐。一行。
 *
 * 本脚本复刻修复后的归一化函数，验证 7 项检查；另用内容锚点钉住真实源码。
 *
 * 运行：node scripts/sim-gemini-bug17.js
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'src/plugins/player/soundEffect/constants.ts'), 'utf8')

// ---------------------------------------------------------------------------
// 模型：复刻修复后的 normalizeConvolutionGain（与 constants.ts 逐行对应）
// ---------------------------------------------------------------------------

const normalizeConvolutionGain = (gain) => {
  if (!Number.isFinite(gain)) return 0
  return Math.min(50, Math.max(0, Math.round(gain)))
}

// 修复前（反例对照）
const normalizeConvolutionGainBeforeFix = (gain) => Math.min(50, Math.max(0, Math.round(gain)))

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

let pass = 0; let fail = 0
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`)
  ok ? pass++ : fail++
}

console.log('sim-gemini-bug17：normalizeConvolutionGain 有限性校验\n')

// 断言1（反例）：修复前 NaN 泄漏为 NaN
{
  const out = normalizeConvolutionGainBeforeFix(NaN)
  check('修复前·NaN 输入：输出 NaN 泄漏给原生（缺陷存在，反例）',
    Number.isNaN(out), `输出=${out}`)
}

// 断言2（修复验证）：NaN / undefined / null 一律归零
{
  const results = [NaN, undefined, null].map(v => normalizeConvolutionGain(v))
  check('修复后·NaN/undefined/null 输入：输出均为 0',
    results.every(v => v === 0),
    `输出=${results.join('/')}`)
}

// 断言3（核实报告修正）：修复前 ±Infinity 已被钳位处理（+Inf→50，-Inf→0），
// "Infinity 返回 NaN"不成立；修复后 isFinite 守卫与 EQ 版对齐，±Infinity 均归 0。
{
  check('修复前·±Infinity 已被钳位（+Inf→50，-Inf→0），从未产生 NaN（报告修正点）',
    normalizeConvolutionGainBeforeFix(Infinity) === 50 && normalizeConvolutionGainBeforeFix(-Infinity) === 0,
    `旧版 +Inf→${normalizeConvolutionGainBeforeFix(Infinity)}，-Inf→${normalizeConvolutionGainBeforeFix(-Infinity)}`)
  check('修复后·±Infinity 经 isFinite 守卫归 0（与 EQ 版对齐）',
    normalizeConvolutionGain(Infinity) === 0 && normalizeConvolutionGain(-Infinity) === 0,
    `新版 +Inf→${normalizeConvolutionGain(Infinity)}，-Inf→${normalizeConvolutionGain(-Infinity)}`)
}

// 断言4（正常值回归）：常规增益四舍五入 + 钳位不变
{
  const cases = [[12.6, 13], [12.4, 12], [0, 0], [25, 25], [60, 50], [-3, 0], [49.5, 50]]
  const ok = cases.every(([input, expected]) => normalizeConvolutionGain(input) === expected)
  check('修复后·正常值：四舍五入 + [0, 50] 钳位不变',
    ok,
    cases.map(([i, e]) => `${i}→${normalizeConvolutionGain(i)}（期望 ${e}）`).join('，'))
}

// 断言5（与 EQ 版对齐）：两函数对非有限输入行为一致
{
  const normalizeEqualizerGain = (gain) => {
    if (!Number.isFinite(gain)) return 0
    return Math.min(15, Math.max(-15, Math.round(gain * 10) / 10))
  }
  const badInputs = [NaN, undefined, null, Infinity, -Infinity]
  const ok = badInputs.every(v => normalizeConvolutionGain(v) === 0 && normalizeEqualizerGain(v) === 0)
  check('修复后·混响版与 EQ 版对非有限输入均返回 0（口径对齐）',
    ok, `输入=${badInputs.join('/')}`)
}

// 断言6（内容锚点）：真实源码里混响版已有 isFinite 守卫
{
  const fnBody = SRC.slice(
    SRC.indexOf('export const normalizeConvolutionGain'),
    SRC.indexOf('export const hasEnabledEqualizerGains'),
  )
  const hasGuard = fnBody.includes('if (!Number.isFinite(gain)) return 0')
  const guardCount = (SRC.match(/if \(!Number\.isFinite\(gain\)\) return 0/g) || []).length
  check('源码锚点：normalizeConvolutionGain 内有 isFinite 守卫（全文件共 2 处，与 EQ 版对齐）',
    hasGuard && guardCount === 2,
    `混响版守卫=${hasGuard}，全文件守卫数=${guardCount}`)
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
