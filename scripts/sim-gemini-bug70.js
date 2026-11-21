#!/usr/bin/env node
/**
 * Bug 70 契约（2026-11-21，Gemini 全量审查）：
 *   user-api-preload.js 的 bufToString('base64') 走
 *   bytesToString（手写 UTF-8 解码器）+ 原生 str2b64（再 UTF-8 编码），
 *   任何含 ≥0x80 字节的二进制数据（密钥/密文）必然损坏；dataToB64 经此
 *   路径被 utils.crypto.aesEncrypt/rsaEncrypt 使用。
 *   另：bytesToString 多字节分支读 bytes[i+1]/bytes[i+2] 无边界校验，
 *   末尾截断序列读到 undefined（undefined & 63 得 0），产出错误字符。
 *
 * 本脚本钉住的不变量（文本断言 + 函数实测）：
 *   - 'base64' 分支直接按位映射（bytesToBase64），不走 UTF-8 往返。
 *   - bytesToString 多字节分支有 i+1/i+2 边界检查。
 *   - 实测：bytesToBase64 与 Buffer base64 在 0..255 全表及 ≥0x80 输入上一致；
 *     bytesToString 正常序列解码不变、截断序列出 U+FFFD 且不越界。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const PRELOAD = path.join(ROOT, 'ios/LxMusicMobile/user-api-preload.js')

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

console.log('Bug 70 契约（二进制转 Base64 不走 UTF-8）：')

const src = read(PRELOAD)

// --- 文本断言 ---
check(
  /function bytesToBase64\(bytes\) \{/.test(src),
  'bytesToBase64 函数存在（按位映射到 Base64 字符表）',
)
check(
  /case 'base64':[\s\S]*?return bytesToBase64\(Array\.from\(buf\)\)/.test(src),
  "bufToString 的 'base64' 分支调 bytesToBase64",
)
check(
  !/nativeFuncs\.utils_str2b64\(bytesToString\(Array\.from\(buf\)\)\)/.test(src),
  '旧的 bytesToString + 原生 str2b64 往返路径已消除',
)
check(
  /if \(i \+ 1 >= bytes\.length\) \{\s*result \+= '\\uFFFD'/.test(src),
  'bytesToString 二字节分支有 i+1 边界检查（截断出 U+FFFD）',
)
check(
  /if \(i \+ 2 >= bytes\.length\) \{\s*result \+= '\\uFFFD'/.test(src),
  'bytesToString 三字节分支有 i+2 边界检查（截断出 U+FFFD）',
)

// --- 函数实测：从 preload 提取 bytesToBase64/bytesToString 对照 ---
const b64Match = src.match(/const BASE64_CHARS[\s\S]*?\n  \}\n/)
const btsMatch = src.match(/function bytesToString\(bytes\) \{[\s\S]*?\n  \}\n/)
check(b64Match !== null, '能从 preload 提取 bytesToBase64 源码')
check(btsMatch !== null, '能从 preload 提取 bytesToString 源码')
if (b64Match && btsMatch) {
  const bytesToBase64 = new Function(b64Match[0].replace(/^  /gm, '') + '; return bytesToBase64')()
  const bytesToString = new Function(btsMatch[0].replace(/^  /gm, '') + '; return bytesToString')()

  const b64Cases = [
    [], [0], [255], [0, 0, 0], [255, 255, 255],
    [0x80], [0x80, 0x80], [0xFF, 0xFE, 0xFD, 0x00, 0x01],
    [72, 101, 108, 108, 111],
    Array.from({ length: 256 }, (_, i) => i),
    Array.from({ length: 1000 }, (_, i) => (i * 37 + 11) % 256),
  ]
  let b64Fail = 0
  for (const c of b64Cases) {
    if (bytesToBase64(c) !== Buffer.from(c).toString('base64')) b64Fail++
  }
  check(b64Fail === 0, `bytesToBase64 与 Buffer base64 在 ${b64Cases.length} 组输入（含 ≥0x80 字节、0..255 全表）上一致`)

  check(bytesToString([72, 105]) === 'Hi', 'bytesToString ASCII 序列解码不变')
  check(bytesToString([0xC3, 0xA9]) === 'é', 'bytesToString 二字节序列解码不变')
  check(bytesToString([0xE4, 0xB8, 0xAD]) === '中', 'bytesToString 三字节序列解码不变')
  check(bytesToString([0xC3]) === '\uFFFD', 'bytesToString 末尾截断二字节序列出 U+FFFD（不读越界）')
  check(bytesToString([0xE4]) === '\uFFFD', 'bytesToString 末尾截断三字节序列出 U+FFFD（不读越界）')
  check(bytesToString([0x41, 0xC3]) === 'A\uFFFD', 'bytesToString 截断序列前正常字符不受影响')
}

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
