#!/usr/bin/env node
/**
 * Bug 55 契约（Gemini 审查 2026-11-21）：
 *   SonglistDetail 乐观添加酷狗歌曲缺少 meta 导致渲染崩溃——addSongToList
 *   把 albumName/albumId/songmid/hash/mixsongid/fileId 平铺在顶层，没有 meta
 *   字段，用 as any 绕过类型检查；渲染侧 ListItem 多处无可选链直接读
 *   item.meta（:112 useIsWyLiked 立即抛 TypeError），添加后 setList 立即崩溃。
 *
 * 钉住的不变量：
 *   - addSongToList 按 LX.Music.MusicInfo_kg 规范构造完整 meta（含 songId /
 *     albumName / albumId / picUrl / qualitys / _qualitys / hash），无 as any。
 *   - ListItem 对 item.meta 的读取全部带可选链（防御其他来源的残缺歌曲）。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MUSIC_LIST = path.join(ROOT, 'src/screens/SonglistDetail/MusicList.tsx')
const LIST_ITEM = path.join(ROOT, 'src/components/OnlineList/ListItem.tsx')

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

console.log('Bug 55 乐观添加构造完整 meta 契约：')

const musicList = read(MUSIC_LIST)
const addStart = musicList.indexOf('addSongToList(rawSong: any)')
const addBody = addStart >= 0 ? musicList.slice(addStart, musicList.indexOf('},\n    }),', addStart)) : ''
check(addStart >= 0, '找到 addSongToList')
check(
  /meta: \{[\s\S]*?songId: rawSong\.audio_id \|\| rawSong\.hash/.test(addBody),
  'meta.songId 取 audio_id/hash',
)
check(
  /picUrl: rawSong\.cover \? rawSong\.cover\.replace\('\{size\}', '400'\) : null/.test(addBody),
  'meta.picUrl 取 cover（{size} 换 400）',
)
check(
  /qualitys: \[\]/.test(addBody) && /_qualitys: \{\}/.test(addBody),
  'meta 含 qualitys / _qualitys（未知时留空）',
)
check(
  /hash: rawSong\.hash \|\| ''/.test(addBody),
  'meta.hash 取 rawSong.hash',
)
check(
  !/} as any/.test(addBody),
  'addSongToList 构造体不再用 as any 绕过类型检查',
)
check(
  !/fileId: rawSong\.fileid/.test(addBody) && !/mixsongid: rawSong\.mixsongid/.test(addBody),
  '去掉顶层平铺的 fileId / mixsongid（不在声明类型内）',
)

// --- ListItem 防御 ---
const listItem = read(LIST_ITEM)
check(
  /useIsWyLiked\(item\.meta\?\.songId \?\? ''\)/.test(listItem),
  'ListItem useIsWyLiked 读 item.meta?.songId',
)
check(
  /useIsKgLiked\(\(\(item\.meta as any\)\?\.hash \|\| item\.meta\?\.songId\) \?\? ''\)/.test(listItem),
  'ListItem useIsKgLiked 读 item.meta?.hash / item.meta?.songId',
)
check(
  /\(item\.meta as any\)\?\.songmid/.test(listItem) && /\(item\.meta as any\)\?\.strMediaMid/.test(listItem),
  'ListItem tx songmid/strMediaMid 读取带可选链',
)
check(
  /item\.meta\?\.albumName/.test(listItem),
  'ListItem albumName 读取带可选链',
)
check(
  /item\.meta\?\.fee === 1/.test(listItem) && /item\.meta\?\.originCoverType === 2/.test(listItem),
  'ListItem fee / originCoverType 读取带可选链',
)
const bareMetaReads = (listItem.match(/item\.meta\.(songId|albumName|fee|originCoverType)/g) || []).length
check(
  bareMetaReads === 0,
  `ListItem 不再有无保护的 item.meta.* 读取（实际 ${bareMetaReads} 处）`,
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
