#!/usr/bin/env node
/**
 * 下载项播放时实际平台展示契约（2026-11-14）：
 *   下载与本地里的歌如果是换源下载的（实际下载平台与原平台不同），
 *   播放时详情页徽章要显示「原平台 → 实际下载平台」；未换源时保持原样。
 *
 * 链路：下载任务 task.actualSource（换源成功时写回）
 *   → 本地列表 taskToPlayItem 抄进播放项 metadata.actualSource
 *   → getMusicUrlInfo 非在线分支对下载项返回 metadata.actualSource（缺失回退原平台）
 *   → setMusicUrl → setResource 写 playerState.actualSource + 广播
 *   → SourceQualityBadge 对比原平台（metadata.musicInfo.source）后展示箭头。
 *
 * 本脚本钉住的不变量：
 *   - ListItem.metadata 类型含 actualSource?: LX.OnlineSource。
 *   - taskToPlayItem 把 task.actualSource 带进 metadata。
 *   - getMusicUrlInfo 非在线分支对下载项取 metadata.actualSource、缺失回退原平台。
 *   - 徽章对下载项取 metadata.musicInfo 为原平台（与 actualSource 对比的基准）。
 *   - 下载列表行本身的实际平台小字展示不受影响（DownloadManager/ListItem）。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const LIST_TYPE = path.join(ROOT, 'src/types/download_list.d.ts')
const LOCAL_DOWNLOAD = path.join(ROOT, 'src/screens/Home/Views/LocalDownload/index.tsx')
const INDEX = path.join(ROOT, 'src/core/music/index.ts')
const BADGE = path.join(ROOT, 'src/screens/PlayDetail/components/SourceQualityBadge.tsx')
const DL_LIST_ITEM = path.join(ROOT, 'src/screens/DownloadManager/ListItem.tsx')

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

console.log('下载项播放时实际平台展示契约：')

const listTypeSrc = read(LIST_TYPE)
const localDownloadSrc = read(LOCAL_DOWNLOAD)
const indexSrc = read(INDEX)
const badgeSrc = read(BADGE)
const dlListItemSrc = read(DL_LIST_ITEM)

// --- 类型：ListItem.metadata 含 actualSource ---
check(
  /actualSource\?: LX\.OnlineSource/.test(listTypeSrc),
  'ListItem.metadata 类型含 actualSource?: LX.OnlineSource',
)

// --- 转换：taskToPlayItem 带 actualSource ---
check(
  /const taskToPlayItem = \(task: LX\.Download\.DownloadTask\)/.test(localDownloadSrc) &&
  /actualSource: task\.actualSource/.test(localDownloadSrc),
  'taskToPlayItem 把 task.actualSource 带进播放项 metadata',
)

// --- 取链：非在线分支对下载项取实际下载平台 ---
check(
  /const resolvedSource: LX\.Source \| null = 'progress' in musicInfo/.test(indexSrc) &&
  /musicInfo\.metadata\?\.actualSource \?\? originalSource/.test(indexSrc),
  'getMusicUrlInfo 非在线分支：下载项取 metadata.actualSource、缺失回退原平台',
)
check(
  /return \{ url, quality: quality \?\? null, source: resolvedSource \}/.test(indexSrc),
  'getMusicUrlInfo 非在线分支返回 resolvedSource',
)

// --- 徽章：下载项的原平台基准是 metadata.musicInfo ---
check(
  /'progress' in playMusicInfo\.musicInfo/.test(badgeSrc) &&
  /playMusicInfo\.musicInfo\.metadata\.musicInfo/.test(badgeSrc),
  '徽章对下载项取 metadata.musicInfo 为原平台（与 actualSource 对比的基准）',
)
check(
  /streamInfo\.actualSource !== musicInfo\.source/.test(badgeSrc),
  '徽章只在实际平台与原平台不同时展示箭头',
)

// --- 下载列表行本身的展示不受影响 ---
check(
  /task\.actualSource && task\.actualSource !== task\.musicInfo\.source/.test(dlListItemSrc),
  '下载列表行仍按 task.actualSource 显示实际平台小字',
)

// --- 反例自检：taskToPlayItem 漏抄 actualSource 时检查能发现 ---
{
  const stripped = localDownloadSrc.replace(/\n\s*actualSource: task\.actualSource,/, '')
  check(
    !/actualSource: task\.actualSource/.test(stripped),
    '反例自检：taskToPlayItem 漏抄 actualSource 时检查能发现',
  )
}

if (failures > 0) {
  console.log(`失败：${failures} 项`)
  process.exit(1)
}
console.log('全部通过')
