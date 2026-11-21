#!/usr/bin/env node
/**
 * Bug 74 契约（2026-11-21，Gemini 全量审查）：
 *   LXEqualizerAudioMixController.updateConfig(enabled:gains:) 无锁读
 *   self.config（LXSoundEffectConfiguration 含 CoW [Float] gains 与 String
 *   成员），与另一线程的持锁写竞争引用计数。NSLock 不可重入——修法必须
 *   是「锁内拷贝、解锁后再调 updateConfig(_:)」，持锁调会死锁。
 *
 * 本脚本钉住的不变量（顺序是关键）：
 *   - lock.lock() → var config = self.config → lock.unlock()
 *     → updateConfig(config)，updateConfig 调用在 unlock 之后。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SWIFT_EQ = path.join(ROOT, 'patches/ios/LXEqualizerAudioMix.swift')

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

console.log('Bug 74 契约（均衡器配置锁内拷贝、解锁后再调）：')

const src = read(SWIFT_EQ)
const fnStart = src.indexOf('func updateConfig(enabled: Bool, gains: [Float]) {')
const fnEnd = src.indexOf('func updateConfig(_ config: LXSoundEffectConfiguration) {', fnStart)
const fnBody = fnStart >= 0 && fnEnd > fnStart ? src.slice(fnStart, fnEnd) : ''

check(fnBody.length > 0, '定位到 updateConfig(enabled:gains:) 函数体')
if (fnBody.length > 0) {
  const lockAt = fnBody.indexOf('lock.lock()')
  const copyAt = fnBody.indexOf('var config = self.config')
  const unlockAt = fnBody.indexOf('lock.unlock()')
  const callAt = fnBody.indexOf('updateConfig(config)')
  check(
    lockAt >= 0 && copyAt > lockAt && unlockAt > copyAt,
    '锁内拷贝 self.config（lock → 拷贝 → unlock 顺序）',
  )
  check(
    callAt > unlockAt && callAt > 0,
    'updateConfig(config) 在 unlock 之后调用（NSLock 不可重入，持锁调会死锁）',
  )
  check(
    !/lock\.lock\(\)[\s\S]*?updateConfig\(config\)[\s\S]*?lock\.unlock\(\)/.test(fnBody),
    'updateConfig(config) 不在 lock/unlock 之间（无持锁重入）',
  )
  check(
    fnBody.indexOf('config.equalizerEnabled = enabled') > unlockAt &&
    fnBody.indexOf('config.gains = Self.normalizeGains(gains)') > unlockAt,
    '拷贝后的字段修改也在锁外（锁只包拷贝，临界区最小）',
  )
}

// --- 反例自检：持锁调用（死锁写法）必须被抓到 ---
const fakeFn = fnBody.replace('lock.unlock()\n        config.equalizerEnabled = enabled', 'config.equalizerEnabled = enabled')
const fakeWithDeadlock = fakeFn.replace('updateConfig(config)', 'updateConfig(config)\n        lock.unlock()')
check(
  /lock\.lock\(\)[\s\S]*?updateConfig\(config\)[\s\S]*?lock\.unlock\(\)/.test(fakeWithDeadlock),
  '反例自检：updateConfig 移进锁内后，持锁重入检查能失败',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
