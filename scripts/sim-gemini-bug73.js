#!/usr/bin/env node
/**
 * Bug 73 契约（2026-11-21，Gemini 全量审查，部分真实）：
 *   10 段均衡器两处 makeCoefficients（Swift 侧 LXEqualizerAudioMix.swift
 *   与 C++ 侧 AppDelegate.mm 的 LXRealtimeEqualizerProcessor）都没有
 *   Nyquist 频率上限校验：采样率 < 32000 Hz 且 16kHz 频段增益 ≥0.01 时，
 *   omega > π → sin(omega) < 0 → alpha < 0，IIR 极点落到单位圆外，
 *   状态指数发散至 ±Inf/NaN（满幅噪声）。
 *   （核实报告已证实"Int 强转 NaN 致命崩溃"不成立——两处输出路径都有
 *   箝位兜底，故只修 Nyquist bypass，不做 isFinite 归零。）
 *
 * 本脚本钉住的不变量（两处同改，缺一不可）：
 *   - frequency >= sampleRate * 0.49 的频段直接 bypass。
 *   - bypass 位于 |gain| < 0.01 bypass 之后、系数计算之前。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SWIFT_EQ = path.join(ROOT, 'patches/ios/LXEqualizerAudioMix.swift')
const APP_DELEGATE = path.join(ROOT, 'ios/LxMusicMobile/AppDelegate.mm')

let failures = 0
const check = (ok, msg) => {
  console.log(ok ? `  ✓ ${msg}` : `  ✗ ${msg}`)
  if (!ok) failures++
}

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    check(false, `读取失败：${p}`)
    return ''
  }
}

console.log('Bug 73 契约（均衡器 Nyquist 上限，两处同改）：')

// --- Swift 侧 ---
const swift = read(SWIFT_EQ)
const swiftStart = swift.indexOf('private static func makeCoefficients(sampleRate: Double, gains: [Float])')
const swiftEnd = swift.indexOf('private final class LXConvolutionEngine', swiftStart)
const swiftBody = swiftStart >= 0 && swiftEnd > swiftStart ? swift.slice(swiftStart, swiftEnd) : ''
check(swiftBody.length > 0, '定位到 Swift 侧 makeCoefficients')
if (swiftBody.length > 0) {
  check(
    /if frequency >= Float\(sampleRate \* 0\.49\) \{ return \.bypass \}/.test(swiftBody),
    'Swift 侧：frequency >= sampleRate * 0.49 的频段直接 bypass',
  )
  check(
    swiftBody.indexOf('if abs(gain) < 0.01 { return .bypass }') < swiftBody.indexOf('if frequency >= Float(sampleRate * 0.49)') &&
    swiftBody.indexOf('if frequency >= Float(sampleRate * 0.49)') < swiftBody.indexOf('let amplitude = pow(10, gain / 40)'),
    'Swift 侧：Nyquist bypass 在增益 bypass 之后、系数计算之前',
  )
}

// --- C++ 侧 ---
const cpp = read(APP_DELEGATE)
const cppStart = cpp.indexOf('static std::vector<LXBiquadCoefficients> makeCoefficients(')
const cppEnd = cpp.indexOf('static float makeHeadroomGain(', cppStart)
const cppBody = cppStart >= 0 && cppEnd > cppStart ? cpp.slice(cppStart, cppEnd) : ''
check(cppBody.length > 0, '定位到 C++ 侧 makeCoefficients')
if (cppBody.length > 0) {
  check(
    /if \(frequencies\[index\] >= \(float\)sampleRate \* 0\.49f\) continue;/.test(cppBody),
    'C++ 侧：frequency >= sampleRate * 0.49 的频段直接 bypass（continue 留默认系数）',
  )
  check(
    cppBody.indexOf('if (fabsf(gain) < 0.01f) continue;') < cppBody.indexOf('if (frequencies[index] >= (float)sampleRate * 0.49f)') &&
    cppBody.indexOf('if (frequencies[index] >= (float)sampleRate * 0.49f)') < cppBody.indexOf('float amplitude = powf(10.0f, gain / 40.0f);'),
    'C++ 侧：Nyquist bypass 在增益 bypass 之后、系数计算之前',
  )
}

// --- 反例自检 ---
const fakeSwift = swiftBody.replace('if frequency >= Float(sampleRate * 0.49) { return .bypass }', '')
check(
  !/Float\(sampleRate \* 0\.49\)/.test(fakeSwift),
  '反例自检：Swift 侧删掉 Nyquist bypass 后，检查能失败',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
