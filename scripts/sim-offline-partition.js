#!/usr/bin/env node
/**
 * 离线分区展示契约（2026-11-13）：
 *   进入离线模式后，在线列表里未下载歌曲沉底并置灰，退出离线自动恢复原序；
 *   点置灰行只弹提示、不进播放链路。
 *
 * 本脚本钉住的不变量：
 *   - 分区是展示层派生（useMemo），不写回 setList/onListUpdate——
 *     store 与父组件的原列表不受影响，退出离线即恢复。
 *   - 分区 memo 依赖含 listVersion（musicInfoUpdate 原地换行对象不换数组
 *     引用，缺了它分区拿旧对象渲染）。
 *   - FlatList data 用分区后的数组；onPlayList/选区/菜单/scrollToInfo
 *     的下标一律回译到原列表（调用方按原列表理解下标）。
 *   - 置灰行点播拦截 toast，不进播放链路（防 autoSkipOnError 当失败切走）。
 *   - 正在播放的那首视为可用，不沉底、不置灰。
 *   - ListItem 的 isDimmed 进 memo 比较器（否则置灰状态变了行不重渲）。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const INDEX = path.join(ROOT, 'src/core/music/index.ts')
const LIST = path.join(ROOT, 'src/components/OnlineList/List.tsx')
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

console.log('离线分区展示契约：')

const indexSrc = read(INDEX)
const listSrc = read(LIST)
const itemSrc = read(LIST_ITEM)

// --- 同步已下载判定（core/music/index.ts） ---
check(
  /export const buildDownloadedLookup/.test(indexSrc) &&
  /export const isSongDownloaded/.test(indexSrc),
  'buildDownloadedLookup / isSongDownloaded 已导出',
)
check(
  /buildDownloadedLookup[\s\S]{0,600}task\.status !== 'completed' \|\| !task\.filePath/.test(indexSrc),
  '查找表只收已完成且有文件路径的任务',
)
check(
  /isSongDownloaded[\s\S]{0,500}lookup\.ids\.has\(song\.id\)/.test(indexSrc) &&
  /isSongDownloaded[\s\S]{0,500}lookup\.nameSinger\.has/.test(indexSrc),
  '判定先 ID 后歌名+歌手（与 findOfflineLocalFile 同口径）',
)

// --- 分区派生（OnlineList/List.tsx） ---
check(
  /const partition = useMemo\(\(\) => \{\s*if \(!offlineMode\) return \{ list: currentList/.test(listSrc),
  '分区 memo：非离线时原样返回 currentList',
)
{
  const memoStart = listSrc.indexOf('const partition = useMemo')
  const memoEnd = listSrc.indexOf('const displayListRef', memoStart)
  const memo = memoStart >= 0 && memoEnd > memoStart ? listSrc.slice(memoStart, memoEnd) : ''
  check(memo.length > 0, '分区 memo 可解析')
  if (memo) {
    check(/\[currentList, listVersion, offlineMode, downloadTasks, playingId\]/.test(memo), '分区 memo 依赖含 listVersion（原地换行对象时重算）')
    check(/song\.id === playingId/.test(memo), '正在播放的歌视为可用（不沉底、不置灰）')
    check(/isSongDownloaded\(song, lookup\)/.test(memo), '分区用同步已下载判定')
  }
}
check(
  /data=\{partition\.list\}/.test(listSrc),
  'FlatList data 用分区后的数组',
)
check(
  /onPlayList\(toOriginalIndex\(item, index\), item\)/.test(listSrc),
  'onPlayList 收到的下标已回译到原列表',
)
check(
  /displayListRef\.current\.findIndex/.test(listSrc) &&
  /scrollToInfo\(info\) \{[\s\S]{0,200}displayListRef/.test(listSrc),
  'scrollToInfo 按展示列表定位',
)
check(
  /partition\.dimmedIds\.has\(item\.id\)/.test(listSrc) &&
  /toast\('离线模式：该歌曲未下载'\)/.test(listSrc),
  '置灰行点播拦截 toast、不进播放链路',
)
check(
  /isDimmed=\{d\.dimmedIds\.has\(item\.id\)\}/.test(listSrc),
  'renderItem 把 isDimmed 传给行组件',
)
check(
  /extraData=\{`[^`]*downloadVersionRef\.current/.test(listSrc),
  'extraData 含下载任务版本号（驱动行重渲）',
)
check(
  !/\[\.\.\.partition\.dimmedIds\]\.join/.test(listSrc),
  'S-2：extraData 不再拼置灰 id 全量字符串（O(n) → O(1) 版本号）',
)
check(
  /useEffect\(\(\) => \{\s*if \(offlineMode\) setOfflineBannerDismissed\(false\)/.test(listSrc),
  'S-3：离线横幅关闭状态随 offlineMode 重置',
)
check(
  /onListUpdate\?\.\(list\)/.test(listSrc) && !/onListUpdate\?\.\(partition/.test(listSrc),
  'onListUpdate 仍回传原列表（分区不写回 store）',
)

// --- 行置灰（OnlineList/ListItem.tsx） ---
check(
  /isDimmed\?: boolean/.test(itemSrc) && /isDimmed = false/.test(itemSrc),
  'ListItem 有 isDimmed 属性（默认 false）',
)
check(
  /opacity: isDimmed \? 0\.45 : 1/.test(itemSrc),
  '置灰行整行降透明度',
)
check(
  /prevProps\.isDimmed === nextProps\.isDimmed/.test(itemSrc),
  'memo 比较器含 isDimmed（置灰变化时行重渲）',
)

// 反例自检：去掉分区 data 后检查能发现
{
  const stripped = listSrc.replace('data={partition.list}', 'data={currentList}')
  check(!/data=\{partition\.list\}/.test(stripped), '反例自检：分区 data 被换回原列表时检查能发现')
}

if (failures > 0) {
  console.log(`失败：${failures} 项`)
  process.exit(1)
}
console.log('全部通过')
