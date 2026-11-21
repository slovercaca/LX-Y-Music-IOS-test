#!/usr/bin/env node
/**
 * Bug 65 契约（2026-11-21，Gemini 全量审查）：
 *   schedulePCMBufferWithFrame 以 STREAMINFO 的 self.channels 为循环上界，
 *   直接 decodedBuffer[channel][...]，从未与帧头声道数比较、未判空。
 *   变声道/损坏流（帧声道数 < STREAMINFO 声道数）时 libFLAC 只为帧头
 *   声道数分配 output[]，其余项为 NULL → 空指针解引用崩溃。
 *
 * 本脚本钉住的不变量：
 *   - 拷贝上界取 MIN(self.channels, frame->header.channels)。
 *   - 判空 decodedBuffer[channel]，缺失声道跳过（预填 0 即补零）。
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

console.log('Bug 65 契约（FLAC 帧声道数越界）：')

const src = read(APP_DELEGATE)
const fnStart = src.indexOf('- (void)schedulePCMBufferWithFrame:')
const fnEnd = src.indexOf('- (void)startDecoderLoop', fnStart)
const fnBody = fnStart >= 0 && fnEnd > fnStart ? src.slice(fnStart, fnEnd) : ''

check(
  fnBody.length > 0 &&
  /const NSUInteger copyChannels = MIN\(self\.channels, \(NSUInteger\)frame->header\.channels\);/.test(fnBody),
  '拷贝上界取 MIN(self.channels, frame->header.channels)',
)
check(
  fnBody.length > 0 &&
  /for \(NSUInteger channel = 0; channel < copyChannels; channel\+\+\)/.test(fnBody),
  '拷贝循环以上界 copyChannels 为限',
)
check(
  fnBody.length > 0 &&
  /const FLAC__int32 \*channelBuffer = decodedBuffer\[channel\];\s*if \(channelBuffer == NULL\) continue;/.test(fnBody),
  '判空 decodedBuffer[channel]，NULL 声道跳过（预填 0 即补零）',
)
check(
  fnBody.length > 0 && !/decodedBuffer\[channel\]\[sample \+ startOffset\]/.test(fnBody),
  '不再直接下标 decodedBuffer[channel][...]（旧越界读已消除）',
)
check(
  fnBody.length > 0 &&
  /std::vector<std::vector<float>> pcmChannels\(self\.channels, std::vector<float>\(playableFrames, 0\)\);/.test(fnBody),
  'pcmChannels 仍预填 0（缺失声道补零的前提）',
)

// --- 反例自检 ---
const fakeFn = fnBody.replace('const NSUInteger copyChannels = MIN(self.channels, (NSUInteger)frame->header.channels);', 'const NSUInteger copyChannels = self.channels;')
check(
  !/MIN\(self\.channels, \(NSUInteger\)frame->header\.channels\)/.test(fakeFn),
  '反例自检：上界改回 self.channels 后，上界检查能失败',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
