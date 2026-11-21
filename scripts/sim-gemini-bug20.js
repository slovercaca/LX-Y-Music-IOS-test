#!/usr/bin/env node
/**
 * Gemini Bug 20 契约：isPoisonedCache 必须用 base64 读首字节。
 *   此前 read(filePath, 1, 0, 'utf8') 单独解码 1 字节，JPEG（0xFF）、
 *   PNG（0x89）、无 ID3 头 MP3（0xFF）的首字节均非法、read 直接 reject，
 *   .catch 得 null 后误判毒缓存，每次播放都删缓存重下。
 * 本脚本钉住：base64 读取 + 解码字节比对 0x3C，且首字节判定逻辑本身
 * 对 0xFF/0x89/0x3C 三类首字节给出正确结论。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILES = path.join(ROOT, 'src/core/webdavMusic/files.ts')

let failures = 0
const check = (ok, msg) => {
  console.log(ok ? `  ✓ ${msg}` : `  ✗ ${msg}`)
  if (!ok) failures++
}

console.log('Gemini Bug 20 契约（isPoisonedCache base64 首字节）：')

const src = fs.readFileSync(FILES, 'utf8')
const fnStart = src.indexOf('export const isPoisonedCache')
const fnBody = src.slice(fnStart, src.indexOf('\n}\n', fnStart))

check(
  fnBody.includes("read(filePath, 1, 0, 'base64')"),
  "isPoisonedCache 用 read(filePath, 1, 0, 'base64') 读首字节",
)
check(
  !fnBody.includes("read(filePath, 1, 0, 'utf8')"),
  'isPoisonedCache 不再用 utf8 读首字节',
)
check(
  fnBody.includes("Buffer.from(head, 'base64')[0] === 0x3C"),
  '比对解码字节 === 0x3C（\'<\'）',
)

// --- 判定逻辑本身的行为自检（与实现同款表达式） ---
const isPoisonedHead = (head) => Buffer.from(head, 'base64')[0] === 0x3C
const b64 = (byte) => Buffer.from([byte]).toString('base64')
check(isPoisonedHead(b64(0x3C)) === true, '首字节 0x3C（\'<\'，错误页面）判毒')
check(isPoisonedHead(b64(0xFF)) === false, '首字节 0xFF（JPEG/无 ID3 MP3）不判毒')
check(isPoisonedHead(b64(0x89)) === false, '首字节 0x89（PNG）不判毒')
check(isPoisonedHead(b64(0x66)) === false, '首字节 0x66（FLAC 的 f）不判毒')

// --- 反例自检 ---
check(
  !fnBody.replace("read(filePath, 1, 0, 'base64')", "read(filePath, 1, 0, 'utf8')").includes("read(filePath, 1, 0, 'base64')"),
  '反例自检：改回 utf8 后，base64 检查能失败',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
