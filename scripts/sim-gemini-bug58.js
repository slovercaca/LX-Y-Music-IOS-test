#!/usr/bin/env node
/**
 * Bug 58 契约（Gemini 审查 2026-11-21）：
 *   MusicMultiAddModal/List 过滤当前网易云源歌单时前缀不匹配——listId 是带
 *   前缀的 wy__123456，而网易订阅歌单的 l.id 是不带前缀的原始数字 id，
 *   l.id != listId 恒为真，源歌单未被排除；移动时误选源歌单自身，wy 分支
 *   先加后删同一歌单，选中歌曲被清空。tx 不受影响（l.id 自带 tx__ 前缀）。
 *
 * 钉住的不变量：
 *   - wy 类型比较前剥离 ^wy__ 前缀；tx 与本地比较逻辑不动。
 *   - 过滤谓词本身用纯函数模拟验证（三类歌单）。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILE = path.join(ROOT, 'src/components/MusicMultiAddModal/List.tsx')

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

console.log('Bug 58 移动过滤源歌单前缀归一化契约：')

const src = read(FILE)

check(
  /if \(playlistType === 'wy'\) return String\(l\.id\) !== String\(listId\)\.replace\(\/\^wy__\/, ''\)/.test(src),
  'wy 比较前剥离 ^wy__ 前缀',
)
check(
  /return l\.id != listId/.test(src),
  '非 wy 类型保持原比较逻辑（tx 自带 tx__ 前缀不受影响）',
)
check(
  !/return sourceList\.filter\(\(l\) => l\.id != listId\)/.test(src),
  '不再用无归一化的单行过滤（旧代码）',
)

// --- 过滤谓词模拟（与实现同规则） ---
const keep = (playlistType, l, listId) => {
  if (playlistType === 'wy') return String(l.id) !== String(listId).replace(/^wy__/, '')
  return l.id != listId
}
// wy：源歌单 123 应被排除，456 保留
check(
  keep('wy', { id: 123 }, 'wy__123') === false,
  'wy：源歌单（id=123，listId=wy__123）被排除',
)
check(
  keep('wy', { id: 456 }, 'wy__123') === true,
  'wy：非源歌单（id=456）保留',
)
// tx：l.id 自带 tx__ 前缀，与 listId 直接比对
check(
  keep('tx', { id: 'tx__789' }, 'tx__789') === false,
  'tx：源歌单（id=tx__789）被排除',
)
check(
  keep('tx', { id: 'tx__111' }, 'tx__789') === true,
  'tx：非源歌单（id=tx__111）保留',
)
// 本地：无前缀
check(
  keep('local', { id: 'abc' }, 'abc') === false,
  '本地：源歌单被排除',
)
check(
  keep('local', { id: 'def' }, 'abc') === true,
  '本地：非源歌单保留',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
