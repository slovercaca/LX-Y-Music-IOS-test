#!/usr/bin/env node
/**
 * Bug 57 契约（Gemini 审查 2026-11-21）：
 *   MusicMultiAddModal 批量移动 QQ 歌单歌曲时忽略 isMove——tx 分支只做添加
 *   后直接 return，全程未检查 isMove；批量「移动」实际只执行了「复制」，
 *   源歌单歌曲残留。对照 wy 分支有完整 if (isMove) 处理。
 *
 * 钉住的不变量：
 *   - tx 分支有 if (isMove)：添加成功后调 removeSongFromPlaylist 删源歌单
 *     歌曲，并清源歌单缓存、发 playlist_updated、报移动成功。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILE = path.join(ROOT, 'src/components/MusicMultiAddModal/MusicMultiAddModal.tsx')

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

console.log('Bug 57 批量移动 QQ 歌单补 isMove 契约：')

const src = read(FILE)
const txStart = src.indexOf("if (playlistType === 'tx')")
const txBody = txStart >= 0 ? src.slice(txStart, src.indexOf('if (selectInfo.isMove)', txStart)) : ''
check(txStart >= 0, '找到 tx 分支')
check(
  /if \(isMove\) \{/.test(txBody),
  'tx 分支检查 isMove',
)
check(
  /const sourcePlaylistId = fromListId\.replace\('tx__', ''\)/.test(txBody),
  '源歌单 id 剥离 tx__ 前缀',
)
check(
  /return txApi\.removeSongFromPlaylist\(sourcePlaylistId, songMids\)/.test(txBody),
  '添加成功后调 removeSongFromPlaylist 删源歌单歌曲',
)
check(
  /clearListDetailCache\('tx', sourcePlaylistId\)/.test(txBody),
  '清源歌单缓存',
)
check(
  /global\.app_event\.playlist_updated\(\{ source: 'tx', listId: sourcePlaylistId \}\)/.test(txBody),
  '发源歌单 playlist_updated',
)
check(
  /toast\(t\('list_edit_action_tip_move_success'\)\)/.test(txBody),
  '移动成功报 move_success（不是 add_success）',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
