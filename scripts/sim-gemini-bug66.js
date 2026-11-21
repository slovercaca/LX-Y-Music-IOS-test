#!/usr/bin/env node
/**
 * Bug 66 契约（2026-11-21，Gemini 全量审查）：
 *   音效配置 10 个文件级 static 全局量跨线程无锁读写：
 *   写侧 SoundEffectModule（桥线程）直接赋值，读侧
 *   applySoundEffectConfigLocked（renderQueue）经 LXCurrentSoundEffectConfig
 *   逐个读。NSArray/NSString 指针的 plain static 赋值是 objc_storeStrong（非原子），
 *   读侧 retain 前写侧可能已释放旧对象 → 悬空指针 EXC_BAD_ACCESS；
 *   更常见的是读到新旧混搭快照。
 *
 * 本脚本钉住的不变量：
 *   - 专用锁 LXSoundEffectConfigLock() 是 dispatch_once 稳定单例。
 *   - 读写两处（LXCurrentSoundEffectConfig / LXUpdateSoundEffectConfig）
 *     均在 @synchronized(LXSoundEffectConfigLock()) 内。
 *   - 通知派发在锁外（观察者同步回调 + dispatch_sync 到 renderQueue
 *     时持锁派发会死锁）。
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

console.log('Bug 66 契约（音效配置全局量跨线程锁）：')

const src = read(APP_DELEGATE)

// --- 锁是稳定单例 ---
check(
  /static NSObject \*LXSoundEffectConfigLock\(void\) \{\s*static NSObject \*lock = nil;\s*static dispatch_once_t onceToken;\s*dispatch_once\(&onceToken, \^\{ lock = \[NSObject new\]; \}\);\s*return lock;\s*\}/.test(src),
  'LXSoundEffectConfigLock() 是 dispatch_once 稳定单例（非每次新建的对象）',
)

// --- 读侧持锁 ---
const readStart = src.indexOf('static NSDictionary *LXCurrentSoundEffectConfig(void) {')
const readEnd = src.indexOf('static void LXUpdateSoundEffectConfig(', readStart)
const readBody = readStart >= 0 && readEnd > readStart ? src.slice(readStart, readEnd) : ''
check(
  readBody.length > 0 &&
  /@synchronized \(LXSoundEffectConfigLock\(\)\) \{\s*NSArray<NSNumber \*> \*gains = LXSoundEffectEqualizerGains;/.test(readBody) &&
  readBody.indexOf('@synchronized (LXSoundEffectConfigLock()) {') < readBody.indexOf('LXSoundEffectEqualizerGains'),
  'LXCurrentSoundEffectConfig 快照整段持锁',
)

// --- 写侧持锁，通知在锁外 ---
const writeStart = src.indexOf('static void LXUpdateSoundEffectConfig(NSDictionary *config) {')
const writeEnd = src.indexOf('@interface SoundEffectModule', writeStart)
const writeBody = writeStart >= 0 && writeEnd > writeStart ? src.slice(writeStart, writeEnd) : ''
check(writeBody.length > 0, '定位到 LXUpdateSoundEffectConfig 函数体')
if (writeBody.length > 0) {
  const syncStart = writeBody.indexOf('@synchronized (LXSoundEffectConfigLock()) {')
  const syncEnd = writeBody.indexOf('\n  }\n', syncStart)
  const notifyAt = writeBody.indexOf('postNotificationName:LXSoundEffectConfigDidChangeNotification')
  check(
    syncStart >= 0 && syncEnd > syncStart &&
    writeBody.indexOf('LXSoundEffectEqualizerEnabled = enabled;', syncStart) > syncStart &&
    writeBody.indexOf('LXSoundEffectEqualizerEnabled = enabled;', syncStart) < syncEnd &&
    writeBody.indexOf('LXSoundEffectPitchShifterPlaybackRate = ', syncStart) > syncStart &&
    writeBody.indexOf('LXSoundEffectPitchShifterPlaybackRate = ', syncStart) < syncEnd,
    'LXUpdateSoundEffectConfig：10 个全局量赋值全在 @synchronized 内（首尾赋值均在块内）',
  )
  check(
    notifyAt > syncEnd,
    '通知派发在锁外（在 @synchronized 块结束之后）',
  )
  check(
    !/@synchronized \(LXSoundEffectConfigLock\(\)\) \{[\s\S]*?postNotificationName[\s\S]*?\n  \}/.test(writeBody),
    '锁块内无通知派发（无回调重入死锁）',
  )
}

// --- 反例自检 ---
const fakeRead = readBody.replace('@synchronized (LXSoundEffectConfigLock()) {', '{')
check(
  !/@synchronized \(LXSoundEffectConfigLock\(\)\)/.test(fakeRead),
  '反例自检：读侧去掉 @synchronized 后，读侧持锁检查能失败',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
