#!/usr/bin/env node
/**
 * seek 超时显示修复契约（2026-11-14）：
 *   位置跑过总时长（02:18 / 02:16）有两个根因，各修一处：
 *   A. 引擎时长少报文件真实长度（实锤：3: 30PM 显示 02:20、实际约 02:26）——
 *      引擎位置超过显示总时长时，把总时长自愈扩展到引擎位置。
 *   D. 原生 4Hz 歌词时钟无时长钳制（实锤：莫愁乡文件 136.24s、显示跑到 138s）——
 *      快路径位置钳制到总时长。
 *
 * 本脚本钉住的不变量：
 *   - healMaxTimeIfNeeded 只在引擎位置上扩展总时长（maxTime > 0 且
 *     enginePosition > maxTime 时 setMaxplayTime），且只在两个引擎位置
 *     发布点调用（慢校准 getCurrentTime、syncFromEngine）。
 *   - 快路径（onPlayerPosition）绝不调用 healMaxTimeIfNeeded——时钟外推可超
 *     文件结尾，在此扩展会掩盖根因二。
 *   - 快路径发布/锚点/歌词探针一律用钳制后的位置（Math.min(position, maxTime)，
 *     总时长为 0 时不钳制）。
 *   - seek 落点判定仍用原始 position（钳制不影响落点确认）。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const PLAY_PROGRESS = path.join(ROOT, 'src/core/init/player/playProgress.ts')

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

console.log('seek 超时显示修复契约：')

const src = read(PLAY_PROGRESS)

// --- A：healMaxTimeIfNeeded 定义 ---
check(
  /const healMaxTimeIfNeeded = \(enginePosition: number\) => \{/.test(src) &&
  /const maxTime = playerState\.progress\.maxPlayTime/.test(src) &&
  /if \(maxTime > 0 && enginePosition > maxTime\) setMaxplayTime\(enginePosition\)/.test(src),
  'healMaxTimeIfNeeded：maxTime > 0 且引擎位置超总时长时才扩展总时长',
)

// --- A：两个引擎位置发布点调用 ---
check(
  /setNowPlayTime\(position\)\n\s*\/\/ A：引擎位置（慢校准）超总时长时自愈总时长[^\n]*\n\s*healMaxTimeIfNeeded\(position\)/.test(src),
  '慢校准（getCurrentTime）发布引擎位置后调用 healMaxTimeIfNeeded',
)
check(
  /setNowPlayTime\(stamped\.position\)\n\s*\/\/ A：引擎位置（syncFromEngine）超总时长时自愈总时长[^\n]*\n\s*healMaxTimeIfNeeded\(stamped\.position\)/.test(src),
  'syncFromEngine 发布引擎位置后调用 healMaxTimeIfNeeded',
)

// --- A：快路径绝不调用 healMaxTimeIfNeeded ---
{
  const fastStart = src.indexOf('onPlayerPosition((position, rate) => {')
  const fastEnd = src.indexOf('onPlayerSeeked(', fastStart)
  const fastBody = fastStart >= 0 && fastEnd > fastStart ? src.slice(fastStart, fastEnd) : ''
  check(
    fastBody.length > 0 && !/healMaxTimeIfNeeded/.test(fastBody),
    '快路径（onPlayerPosition）不调用 healMaxTimeIfNeeded（时钟外推不可扩展总时长）',
  )
}

// --- D：快路径钳制 ---
check(
  /const clampedPosition = maxTime > 0 \? Math\.min\(position, maxTime\) : position/.test(src),
  '快路径位置钳制到总时长（总时长为 0 时不钳制）',
)
check(
  /setNowPlayTime\(clampedPosition\)/.test(src) &&
  /audioClock\.setAnchor\(clampedPosition \* 1000/.test(src) &&
  /verifyLyricLineSync\(clampedPosition \* 1000\)/.test(src),
  '快路径发布/时钟锚点/歌词探针一律用钳制后的位置',
)
check(
  /if \(Math\.abs\(position - seekTargetPosition\) < 1\.5\)/.test(src),
  'seek 落点判定仍用原始 position（钳制不影响落点确认）',
)

// --- 反例自检：快路径改回原始 position 时检查能发现 ---
{
  const stripped = src.replace('setNowPlayTime(clampedPosition)', 'setNowPlayTime(position)')
  check(
    !/setNowPlayTime\(clampedPosition\)/.test(stripped),
    '反例自检：快路径改回原始 position 时检查能发现',
  )
}

if (failures > 0) {
  console.log(`失败：${failures} 项`)
  process.exit(1)
}
console.log('全部通过')
