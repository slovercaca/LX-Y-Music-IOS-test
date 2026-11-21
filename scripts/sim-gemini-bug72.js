#!/usr/bin/env node
/**
 * Bug 72 契约（2026-11-21，Gemini 全量审查，P0，与 71 同文件同批修）：
 *   LXID3USLTFrameValue 只有 0x03 和 0x01 两个分支，其余直接 return nil。
 *   ID3v2 文本编码共 4 种，0x00（ISO-8859-1）和 0x02（UTF-16BE 无 BOM）
 *   的内嵌歌词直接丢失（写封面/标签时回读旧 USLT 得 nil）。
 *   底层 LXStringFromEncodingBytes 已支持 0x00/0x02，缺的只是 USLT 里
 *   按编码跳过内容描述符的分支逻辑。
 *
 * 本脚本钉住的不变量：
 *   - 0x00 并入 0x03 分支（Latin-1 描述符单字节 NUL 终止）。
 *   - 0x02 并入 0x01 分支（UTF-16BE 描述符双字节 NUL 终止、无 BOM）。
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

console.log('Bug 72 契约（USLT 0x00/0x02 编码分支）：')

const src = read(HELPERS)
const fnStart = src.indexOf('static NSString *LXID3USLTFrameValue(')
const fnEnd = src.indexOf('static NSData *LXID3BuildUSLTFrame(', fnStart)
const fnBody = fnStart >= 0 && fnEnd > fnStart ? src.slice(fnStart, fnEnd) : ''

check(fnBody.length > 0, '定位到 LXID3USLTFrameValue 函数体')
if (fnBody.length > 0) {
  check(
    /if \(enc == 0x03 \|\| enc == 0x00\) \{/.test(fnBody),
    '0x00（Latin-1）并入 0x03 分支（单字节 NUL 终止扫描）',
  )
  check(
    /\} else if \(enc == 0x01 \|\| enc == 0x02\) \{/.test(fnBody),
    '0x02（UTF-16BE 无 BOM）并入 0x01 分支（双字节 NUL 终止扫描）',
  )
  check(
    !/if \(enc == 0x03\) \{/.test(fnBody) && !/\} else if \(enc == 0x01\) \{/.test(fnBody),
    '旧的单编码分支已消除（不再有编码直接 return nil）',
  )
  // 两分支仍把 enc 原样传给底层解码（底层已支持 0x00/0x02）
  const decodes = fnBody.match(/return LXStringFromEncodingBytes\(b \+ offset, body\.length - offset, enc\);/g) || []
  check(
    decodes.length === 2,
    `两分支都把 enc 原样传给 LXStringFromEncodingBytes（实际 ${decodes.length} 处）`,
  )
}

// --- 反例自检 ---
const fakeFn = fnBody.replace('if (enc == 0x03 || enc == 0x00) {', 'if (enc == 0x03) {')
check(
  !/enc == 0x03 \|\| enc == 0x00/.test(fakeFn),
  '反例自检：0x00 被踢出分支后，合并检查能失败',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
