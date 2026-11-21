#!/usr/bin/env node
/**
 * Bug 71 契约（2026-11-21，Gemini 全量审查，P0）：
 *   LXStringFromEncodingBytes 无条件裁掉末尾一个 0x00 字节。对 UTF-16
 *   （0x01/0x02）是错的：带终止符 0x00 0x00 时只裁 1 字节，长度变奇数，
 *   initWithBytes: 解码失败返回 nil；更普遍的是 UTF-16LE 文本以 ASCII
 *   结尾时末字节本身就是 0x00（无终止符也被裁成奇数 → nil）——几乎所有
 *   以 ASCII 结尾的 UTF-16LE 标题/歌手/专辑都读失败，写封面/歌词时
 *   LXWriteMP3Metadata 回读旧帧得 nil，字段被静默丢掉。
 *
 * 本脚本钉住的不变量：
 *   - UTF-16（0x01/0x02）仅当末尾两字节都是 0x00 时裁 2 字节。
 *   - 单字节/UTF-8（0x00/0x03）裁 1 字节。
 *   - 旧的无条件裁 1 字节已消除。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const HELPERS = path.join(ROOT, 'ios/LxMusicMobile/LXEmbeddedMetadataHelpers.mm')

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

console.log('Bug 71 契约（UTF-16 ID3 文本帧截断）：')

const src = read(HELPERS)
const fnStart = src.indexOf('static NSString *LXStringFromEncodingBytes(')
const fnEnd = src.indexOf('static NSString *LXID3TextFrameValue(', fnStart)
const fnBody = fnStart >= 0 && fnEnd > fnStart ? src.slice(fnStart, fnEnd) : ''

check(fnBody.length > 0, '定位到 LXStringFromEncodingBytes 函数体')
if (fnBody.length > 0) {
  check(
    /if \(enc == 0x01 \|\| enc == 0x02\) \{\s*if \(length >= 2 && bytes\[length - 1\] == 0 && bytes\[length - 2\] == 0\) length -= 2;/.test(fnBody),
    'UTF-16（0x01/0x02）仅当末尾两字节都是 0x00 时裁 2 字节',
  )
  check(
    /\} else if \(length > 0 && bytes\[length - 1\] == 0\) \{\s*length--;\s*\}/.test(fnBody),
    '单字节/UTF-8（0x00/0x03）裁 1 字节',
  )
  check(
    !/if \(length > 0 && bytes\[length - 1\] == 0\) length--;/ .test(fnBody),
    '旧的无条件裁 1 字节已消除（不再把 UTF-16 裁成奇数长度）',
  )
  check(
    /if \(length == 0\) return nil;/.test(fnBody),
    '截断后长度为 0 仍返回 nil（空串语义不变）',
  )
}

// --- 反例自检 ---
const fakeFn = fnBody.replace('if (length >= 2 && bytes[length - 1] == 0 && bytes[length - 2] == 0) length -= 2;', 'if (length > 0 && bytes[length - 1] == 0) length--;')
check(
  !/bytes\[length - 2\] == 0\) length -= 2;/.test(fakeFn),
  '反例自检：UTF-16 改回裁 1 字节后，双零检查能失败',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
