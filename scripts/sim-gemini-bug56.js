#!/usr/bin/env node
/**
 * Bug 56 契约（Gemini 审查 2026-11-21）：
 *   酷狗歌单单曲「移动歌曲」传错 listid 与 fileids 类型——源歌单 id 可能是
 *   global_collection_id 字符串或 id_<specialid>，Number() 得 NaN；删除接口
 *   签名是 (cookie, listid: number, fileids: number[])，传 hash 字符串会被
 *   Number() 成 NaN（JSON 序列化后变 null），删除必败，移动变复制。
 *
 * 钉住的不变量：
 *   - 源 listid 复用 OnlineList 的 split('_') 取 parts[3] 模式，NaN 时在添加
 *     前阻断并提示。
 *   - 删除前拉源歌单建映射查数字 fileId，再传数字 fileids 给删除接口；
 *     不再传 [songHash]。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILE = path.join(ROOT, 'src/components/MusicAddModal/MusicAddModal.tsx')

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

console.log('Bug 56 酷狗移动传数字 listid/fileids 契约：')

const src = read(FILE)

check(
  /getPlaylistSongs as getKgPlaylistSongs/.test(src),
  '引入 getKgPlaylistSongs（拉源歌单查 fileId）',
)
const kgStart = src.indexOf("if (playlistType === 'kg')")
const kgBody = kgStart >= 0 ? src.slice(kgStart, src.indexOf('if (selectInfo.isMove)', kgStart)) : ''
check(kgStart >= 0, '找到 kg 分支')
check(
  /const parts = sourcePlaylistId\.split\('_'\)/.test(kgBody) &&
  /parts\.length >= 4 \? Number\(parts\[3\]\) : Number\(sourcePlaylistId\)/.test(kgBody),
  '源 listid 用 split(\'_\') 取 parts[3]（OnlineList 同款模式）',
)
check(
  /if \(!sourceListIdNum \|\| isNaN\(sourceListIdNum\)\)/.test(kgBody),
  '源 listid 做 NaN 校验',
)
// NaN 校验必须在 addKgSongToPlaylist 调用之前（添加前阻断，否则先加后删不成）
const nanCheckPos = kgBody.indexOf('if (!sourceListIdNum || isNaN(sourceListIdNum))')
const addPos = kgBody.indexOf('addKgSongToPlaylist(kgCookie, toListId, {')
check(
  nanCheckPos >= 0 && addPos >= 0 && nanCheckPos < addPos,
  'NaN 校验在添加调用之前（添加前阻断）',
)
check(
  /getKgPlaylistSongs\(kgCookie, sourcePlaylistId, page, 500\)/.test(kgBody),
  '拉源歌单歌曲列表查 fileId（分页，最多 20 页）',
)
check(
  /removeKgSongsFromPlaylist\(kgCookie, sourceListIdNum, \[fileId\]\)/.test(kgBody),
  '删除传数字 listid 与数字 fileids',
)
check(
  !/removeKgSongsFromPlaylist\(kgCookie, Number\(sourcePlaylistId\), \[songHash\]\)/.test(kgBody),
  '不再传 Number(源 id) 与 [songHash]（旧代码，NaN + null）',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
