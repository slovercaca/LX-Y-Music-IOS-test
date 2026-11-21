#!/usr/bin/env node
/**
 * Bug 59 契约（Gemini 审查 2026-11-21）：
 *   SettingPlaybackRate 与 SettingVolume 用 Math.trunc 导致滑杆精度回跳——
 *   1.15 * 100 === 114.99999999999999 → trunc 得 114；0.29 * 100 ===
 *   28.999999999999996 → trunc 得 28。滑到 1.15x 松手后显示跳回 1.14x，
 *   音量 29 跳回 28；且 handleSlidingComplete 的相等比较恒不等，每次松手
 *   都重复写一次设置。
 *
 * 钉住的不变量：
 *   - 两处初始值用 Math.round（浮点数值已用 node 实测验证）。
 *   - handleValueChange / handleSlidingComplete 里对滑杆值的
 *     Math.trunc(value) 不动（step=1，值已是整数）。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const RATE = path.join(ROOT, 'src/screens/PlayDetail/components/SettingPopup/settings/SettingPlaybackRate.tsx')
const VOLUME = path.join(ROOT, 'src/screens/PlayDetail/components/SettingPopup/settings/SettingVolume.tsx')

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

console.log('Bug 59 滑杆精度 Math.round 契约：')

// --- 浮点实测：trunc 确实会丢 1，round 不会 ---
check(1.15 * 100 !== 115, '实测：1.15 * 100 不等于 115（浮点误差存在）')
check(Math.trunc(1.15 * 100) === 114, '实测：Math.trunc(1.15 * 100) === 114（旧代码丢 1）')
check(Math.round(1.15 * 100) === 115, '实测：Math.round(1.15 * 100) === 115')
check(Math.trunc(0.29 * 100) === 28, '实测：Math.trunc(0.29 * 100) === 28（旧代码丢 1）')
check(Math.round(0.29 * 100) === 29, '实测：Math.round(0.29 * 100) === 29')

// --- 源码检查 ---
const rate = read(RATE)
const volume = read(VOLUME)
check(
  /const playbackRate = Math\.round\(useSettingValue\('player\.playbackRate'\) \* 100\)/.test(rate),
  'SettingPlaybackRate 初始值用 Math.round',
)
check(
  /const volume = Math\.round\(useSettingValue\('player\.volume'\) \* 100\)/.test(volume),
  'SettingVolume 初始值用 Math.round',
)
check(
  !/Math\.trunc\(useSettingValue/.test(rate) && !/Math\.trunc\(useSettingValue/.test(volume),
  '两文件初始值不再用 Math.trunc',
)
// 滑杆 handler 的 Math.trunc(value) 应保留（step=1，值已是整数）
const rateTruncs = (rate.match(/value = Math\.trunc\(value\)/g) || []).length
const volumeTruncs = (volume.match(/value = Math\.trunc\(value\)/g) || []).length
check(
  rateTruncs === 2 && volumeTruncs === 2,
  `handler 里的 Math.trunc(value) 保留（倍率 ${rateTruncs} 处，音量 ${volumeTruncs} 处）`,
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
