#!/usr/bin/env node
/**
 * Bug 68 契约（2026-11-21，Gemini 全量审查，部分真实·防御性校验）：
 *   LXBlurredBackgroundImage 的 memcpy 长度完全由 rowBytes×height 推导，
 *   从未与 CFDataGetLength 比较；CFDataGetBytePtr 也未判空（长度为 0 时
 *   返回 NULL）。异常 provider（截断数据/自定义 provider）短于推导长度
 *   即越界读；NULL 且 bytes>0 即空指针解引用。
 *
 * 本脚本钉住的不变量：
 *   - 拷贝长度取 MIN(bytes, CFDataGetLength(dataSource))。
 *   - CFDataGetBytePtr 判空；不足部分先零填（buffer1 是 malloc 未初始化内存）。
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

console.log('Bug 68 契约（模糊图拷贝长度校验）：')

const src = read(APP_DELEGATE)
const fnStart = src.indexOf('LXBlurredBackgroundImage(')
const fnEnd = src.indexOf('static NSString *LXBlurredBackgroundCachePath(', fnStart)
const fnBody = fnStart >= 0 && fnEnd > fnStart ? src.slice(fnStart, fnEnd) : ''

check(fnBody.length > 0, '定位到 LXBlurredBackgroundImage 函数体')
if (fnBody.length > 0) {
  check(
    /size_t availableBytes = \(size_t\)CFDataGetLength\(dataSource\);/.test(fnBody),
    '取 CFDataGetLength(dataSource) 得 provider 实际长度',
  )
  check(
    /size_t copyBytes = MIN\(bytes, availableBytes\);/.test(fnBody),
    '拷贝长度取 MIN(bytes, 实际长度)',
  )
  check(
    /if \(sourceBytes != NULL && copyBytes > 0\) \{\s*memcpy\(buffer1\.data, sourceBytes, copyBytes\);\s*\}/.test(fnBody),
    'CFDataGetBytePtr 判空后才 memcpy（长度为 0 时返回 NULL）',
  )
  check(
    /if \(copyBytes < bytes\) \{\s*memset\(\(uint8_t \*\)buffer1\.data \+ copyBytes, 0, bytes - copyBytes\);\s*\}/.test(fnBody),
    '不足部分先零填（buffer1 是 malloc 未初始化内存）',
  )
  check(
    !/memcpy\(buffer1\.data, CFDataGetBytePtr\(dataSource\), bytes\);/.test(fnBody),
    '旧的无校验 memcpy 已消除',
  )
}

// --- 反例自检 ---
const fakeFn = fnBody.replace('size_t copyBytes = MIN(bytes, availableBytes);', 'size_t copyBytes = bytes;')
check(
  !/MIN\(bytes, availableBytes\)/.test(fakeFn),
  '反例自检：拷贝长度改回 bytes 后，MIN 检查能失败',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
