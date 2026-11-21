#!/usr/bin/env node
/**
 * Bug 67 契约（2026-11-21，Gemini 全量审查）：
 *   LXSetNowPlayingPlaybackState 在写缓存的 @synchronized 块之前有一处
 *   冗余提前返回（existingTitle 为空即 return），导致「元数据到达前先缓存
 *   进度/速率、等标题到了统一发布」的设计意图完全 unreachable：切歌时
 *   播放/seek 事件早于元数据到达，elapsedTime/playbackRate 直接丢失。
 *
 * 本脚本钉住的不变量：
 *   - 函数内只剩一处 existingTitle 空守卫，且位于写缓存的 @synchronized
 *     块内（先写缓存、再按标题守卫决定是否发布）。
 *   - 该守卫的 return 在块内，会跳过块后的 LXScheduleDeferredNowPlayingCardRepaint()。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
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

console.log('Bug 67 契约（NowPlaying 进度/速率缓存提前返回）：')

const src = read(APP_DELEGATE)
const fnStart = src.indexOf('static void LXSetNowPlayingPlaybackState(')
const fnEnd = src.indexOf('static void LXClearNowPlayingInfo(void)', fnStart)
const fnBody = fnStart >= 0 && fnEnd > fnStart ? src.slice(fnStart, fnEnd) : ''

check(fnBody.length > 0, '定位到 LXSetNowPlayingPlaybackState 函数体')
if (fnBody.length > 0) {
  const guards = fnBody.match(/if \(existingTitle\.length == 0\) return;/g) || []
  check(
    guards.length === 1,
    `函数内只剩 1 处 existingTitle 空守卫（实际 ${guards.length} 处，冗余提前返回已删）`,
  )
  const guardAt = fnBody.indexOf('if (existingTitle.length == 0) return;')
  const cacheWriteAt = fnBody.indexOf('info[MPNowPlayingInfoPropertyElapsedPlaybackTime]')
  const applyAt = fnBody.indexOf('LXApplyNowPlayingInfo();')
  const repaintAt = fnBody.indexOf('LXScheduleDeferredNowPlayingCardRepaint();')
  check(
    guardAt > cacheWriteAt && guardAt > 0,
    '唯一守卫在写缓存之后（先写缓存、再按标题决定是否发布）',
  )
  check(
    applyAt > guardAt && repaintAt > applyAt,
    '守卫在 LXApplyNowPlayingInfo() 之前、块后的卡片重绘在守卫之后（守卫 return 时不误发）',
  )
  // 守卫位于第二个 @synchronized(LXLyricLock()) 块内：块的左括号在守卫前，
  // 块的右括号在 LXApplyNowPlayingInfo() 之后
  const secondSync = fnBody.indexOf('@synchronized (LXLyricLock()) {', fnBody.indexOf('@synchronized (LXLyricLock()) {') + 1)
  check(
    secondSync >= 0 && secondSync < guardAt,
    '唯一守卫位于写缓存的 @synchronized 块内',
  )
}

// --- 反例自检 ---
const fakeFn = fnBody.replace(
  '  @synchronized (LXLyricLock()) {\n    NSMutableDictionary *info = LXNowPlayingMutableInfo();',
  '  if (existingTitle.length == 0) return;\n  @synchronized (LXLyricLock()) {\n    NSMutableDictionary *info = LXNowPlayingMutableInfo();',
)
check(
  (fakeFn.match(/if \(existingTitle\.length == 0\) return;/g) || []).length === 2,
  '反例自检：恢复提前返回后，守卫计数检查能失败',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
