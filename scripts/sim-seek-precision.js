#!/usr/bin/env node
/**
 * seek 精确落点契约（2026-11-21）：
 *   本地播放快进后「歌词/进度条超前、音频滞后，条跑完音乐还在播」：
 *   - 默认容差 seek 可落在请求目标之前（FLAC seek 表稀疏时差距可达数秒），
 *     而 seek/seeked 事件与歌词时钟都按请求目标重锚。
 *   - seeked 事件回传的是请求目标（SwiftAudioEx 回调原样回传请求参数，还截成
 *     整数），不是真实落点；AppDelegate.mm 的注释曾写反。
 *
 * 本脚本钉住的不变量：
 *   - Podfile 的 lx_patch_swift_audio_precise_seek 把 SwiftAudioEx 的
 *     avPlayer.seek 改为零容差（toleranceBefore/toleranceAfter 均为 .zero），
 *     且在 post_install 里调用；幂等（已打补丁直接返回），锚点未命中即 raise。
 *   - dependencies-patch.js 的 handleAudioPlayerSeekCompleted 用完成时刻的
 *     引擎位置（player.currentTime）上报 seeked，不用请求目标 data.seconds。
 *   - AppDelegate.mm 的 seek/seeked 注释区分「发起带请求目标 / 完成带真实落点」。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const PODFILE = path.join(ROOT, 'ios/Podfile')
const DEP_PATCH = path.join(ROOT, 'dependencies-patch.js')
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

console.log('seek 精确落点契约：')

const podfile = read(PODFILE)
const depPatch = read(DEP_PATCH)
const appDelegate = read(APP_DELEGATE)

// --- Podfile 精确 seek 补丁 ---
check(
  /def lx_patch_swift_audio_precise_seek\(installer\)/.test(podfile),
  'Podfile 定义 lx_patch_swift_audio_precise_seek(installer)',
)
check(
  /post_install do \|installer\|[\s\S]*?lx_patch_swift_audio_precise_seek\(installer\)/.test(podfile),
  'post_install 里调用 lx_patch_swift_audio_precise_seek(installer)',
)
check(
  /avPlayer\.seek\(to: CMTimeMakeWithSeconds\(seconds, preferredTimescale: 1000\)\)/.test(podfile) &&
  /toleranceBefore: \.zero, toleranceAfter: \.zero/.test(podfile),
  '补丁锚点是上游 seek 调用，替换体加零容差（toleranceBefore/toleranceAfter 均为 .zero）',
)
check(
  /return if source\.include\?\('toleranceBefore: \.zero'\)/.test(podfile),
  '补丁幂等：已打过补丁直接返回',
)
check(
  /raise "SwiftAudio precise seek patch: anchor not found/.test(podfile),
  '锚点未命中即 raise（loud failure，不静默丢功能）',
)

// --- seeked 事件带真实落点 ---
const handlerStart = depPatch.indexOf('private func handleAudioPlayerSeekCompleted')
const handlerBody = handlerStart >= 0 ? depPatch.slice(handlerStart, handlerStart + 1200) : ''
check(
  handlerStart >= 0 && /let landedPosition = player\.currentTime/.test(handlerBody),
  'handleAudioPlayerSeekCompleted 用完成时刻引擎位置（player.currentTime）作落点',
)
check(
  handlerStart >= 0 &&
  /postLifecycleEvent\("seeked", position: landedPosition\)/.test(handlerBody) &&
  /\["position": landedPosition, "finished": data\.didFinish\]/.test(handlerBody),
  'lifecycle 与 JS 两个 seeked 事件都上报 landedPosition',
)
check(
  !/Double\(data\.seconds\)/.test(depPatch),
  'dependencies-patch.js 不再用请求目标 Double(data.seconds) 上报 seeked',
)

// --- AppDelegate.mm 注释纠正 ---
check(
  /"seek"（发起，带请求目标）\/"seeked"（完成，带完成时刻引擎位置即真实落点/.test(appDelegate),
  'AppDelegate.mm 注释区分 seek（请求目标）与 seeked（真实落点）',
)

// --- 反例自检：检查本身能抓到回归 ---
const fakePodfile = podfile.replace('    lx_patch_swift_audio_precise_seek(installer)\n', '')
check(
  !/post_install do \|installer\|[\s\S]*?lx_patch_swift_audio_precise_seek\(installer\)/.test(fakePodfile),
  '反例自检：删掉 post_install 调用后，调用检查能失败',
)
const fakeHandler = handlerBody.replace('let landedPosition = player.currentTime', 'let landedPosition = Double(data.seconds)')
check(
  !/let landedPosition = player\.currentTime/.test(fakeHandler),
  '反例自检：落点改回请求目标后，落点检查能失败',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
