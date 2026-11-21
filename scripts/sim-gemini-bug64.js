#!/usr/bin/env node
/**
 * Bug 64 契约（2026-11-21，Gemini 全量审查）：
 *   StreamingFlacPlayerModule seek 状态跨队列无锁读写：
 *   seekToStream:（桥线程）无锁写 pendingSeek 系列/seekRequested/seekInProgress，
 *   decoderQueue 的 handleFrame:/applyPendingSeekIfNeeded 同时读写同一批状态。
 *   真实错误窗口：seekTo 先置 seekInProgress=YES，seekTargetFrame 要等下一轮
 *   apply 才更新，窗口内 handleFrame 拿旧目标跳帧。
 *
 * 本脚本钉住的不变量：
 *   - seek 状态专用锁 seekStateLock 存在且在 init 初始化。
 *   - seekToStream: 只登记三元组（持锁），不再置位 seekInProgress。
 *   - applyPendingSeekIfNeeded 在同一把锁内完成快照/代际校验/清除/置位。
 *   - handleFrame 的跳帧判定与 seekInProgress 清除持锁；seekRequested 读走
 *     持锁 helper hasPendingSeek。
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

console.log('Bug 64 契约（FLAC seek 状态跨队列锁）：')

const src = read(APP_DELEGATE)

// --- 锁存在且初始化 ---
check(
  /@property \(nonatomic, strong\) NSLock \*seekStateLock;/.test(src),
  'seekStateLock 属性已声明',
)
check(
  /_seekStateLock = \[\[NSLock alloc\] init\];/.test(src),
  'seekStateLock 在 init 中初始化',
)

// --- seekToStream: 只登记三元组，不置 seekInProgress ---
const seekToStart = src.indexOf('RCT_REMAP_METHOD(seekTo, seekToStream:')
const seekToEnd = src.indexOf('RCT_REMAP_METHOD(setVolume,', seekToStart)
const seekToBody = seekToStart >= 0 && seekToEnd > seekToStart ? src.slice(seekToStart, seekToEnd) : ''
check(
  seekToBody.length > 0 &&
  seekToBody.indexOf('[self.seekStateLock lock];') >= 0 &&
  seekToBody.indexOf('self.pendingSeekPosition = requestedPosition;') > seekToBody.indexOf('[self.seekStateLock lock];') &&
  seekToBody.indexOf('self.pendingSeekGeneration = self.playbackGeneration;') > seekToBody.indexOf('[self.seekStateLock lock];') &&
  seekToBody.indexOf('self.seekRequested = YES;') > seekToBody.indexOf('[self.seekStateLock lock];') &&
  seekToBody.indexOf('[self.seekStateLock unlock];') > seekToBody.indexOf('self.seekRequested = YES;'),
  'seekToStream: 登记三元组在 seekStateLock 内（lock→三赋值→unlock 顺序）',
)
check(
  seekToBody.length > 0 && !/self\.seekInProgress\s*=/.test(seekToBody),
  'seekToStream: 不再置位 seekInProgress（只由 decoderQueue 统一置位）',
)

// --- applyPendingSeekIfNeeded：快照/校验/清除/置位同锁原子完成 ---
const applyStart = src.indexOf('- (void)applyPendingSeekIfNeeded {')
const applyEnd = src.indexOf('- (void)schedulePCMBufferWithFrame:', applyStart)
const applyBody = applyStart >= 0 && applyEnd > applyStart ? src.slice(applyStart, applyEnd) : ''
check(
  applyBody.length > 0 &&
  applyBody.indexOf('[self.seekStateLock lock];') < applyBody.indexOf('BOOL seekRequested = self.seekRequested;') &&
  applyBody.indexOf('self.seekTargetFrame = targetFrame;') > applyBody.indexOf('[self.seekStateLock lock];') &&
  applyBody.indexOf('self.seekInProgress = targetFrame > 0;') > applyBody.indexOf('self.seekTargetFrame = targetFrame;'),
  'applyPendingSeekIfNeeded：快照与 seekTargetFrame/seekInProgress 置位在同一锁内',
)
check(
  applyBody.length > 0 &&
  /if \(!seekRequested \|\| sampleRate <= 0\) \{\s*\[self\.seekStateLock unlock\];\s*return;\s*\}/.test(applyBody),
  'applyPendingSeekIfNeeded：sampleRate<=0 时解锁返回且不清除 seekRequested（下一轮重试）',
)
check(
  applyBody.length > 0 &&
  !/self\.completedFrames = self\.seekTargetFrame;/.test(applyBody) &&
  /self\.completedFrames = targetFrame;/.test(applyBody),
  'applyPendingSeekIfNeeded：renderQueue 块用锁内算好的 targetFrame 局部量，不重读属性',
)

// --- handleFrame：跳帧判定持锁；seekRequested 读走 helper ---
const frameStart = src.indexOf('- (FLAC__StreamDecoderWriteStatus)handleFrame:')
const frameEnd = src.indexOf('- (void)handleDecoderErrorStatus:', frameStart)
const frameBody = frameStart >= 0 && frameEnd > frameStart ? src.slice(frameStart, frameEnd) : ''
check(
  frameBody.length > 0 &&
  frameBody.indexOf('[self.seekStateLock lock];') < frameBody.indexOf('if (self.seekInProgress)') &&
  frameBody.indexOf('self.seekInProgress = NO;') > frameBody.indexOf('[self.seekStateLock lock];') &&
  /\[self\.seekStateLock unlock\];\s*return FLAC__STREAM_DECODER_WRITE_STATUS_CONTINUE;/.test(frameBody),
  'handleFrame：跳帧判定与 seekInProgress 清除持锁，早退分支先解锁再返回',
)
check(
  frameBody.length > 0 && /\[self hasPendingSeek\]/.test(frameBody) && !/self\.seekRequested/.test(frameBody),
  'handleFrame：seekRequested 读走持锁 helper hasPendingSeek，不直接读属性',
)
check(
  /- \(BOOL\)hasPendingSeek \{\s*\[self\.seekStateLock lock\];\s*BOOL pending = self\.seekRequested;\s*\[self\.seekStateLock unlock\];\s*return pending;\s*\}/.test(src),
  'hasPendingSeek 持锁读 seekRequested（lock→读→unlock→返回）',
)
check(
  /while \(!self\.stopRequested && !\[self hasPendingSeek\]\)/.test(src),
  'waitForBufferCapacityIfNeeded 循环条件走 hasPendingSeek',
)

// --- 反例自检 ---
const fakeSeekTo = seekToBody.replace('self.seekRequested = YES;', 'self.seekRequested = YES;\n  self.seekInProgress = YES;')
check(
  /self\.seekInProgress\s*=/.test(fakeSeekTo),
  '反例自检：seekTo 重新置位 seekInProgress 后，无置位检查能失败',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
