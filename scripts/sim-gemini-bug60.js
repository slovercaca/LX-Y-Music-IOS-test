#!/usr/bin/env node
/**
 * Bug 60 契约（Gemini 审查 2026-11-21）：
 *   ArtistDetail 切换排序方式时两个 useEffect 并发重复触发 loadSongs——
 *   handleSortChange 一次 setSongs 同时改 sort 并清空 list，两个 effect 在
 *   同一提交中先后运行；loadSongs 的守卫是 `if (songsLoadingRef.current &&
 *   !isRefresh) return`，第二次调用 isRefresh=true 绕过守卫，两次网络请求
 *   并发发出。
 *
 * 钉住的不变量：
 *   - 第二个 effect（监听 songs.sort 的排序 effect）已删除，其首轮跳过 ref
 *     一并删除。
 *   - handleSortChange 中直接 loadSongs(newSort, 1, true)。
 *   - 第一个 effect 的依赖中去掉 songs.sort（排序切换不再经 effect 加载；
 *     本 effect 仍会因 list.length 变 0 重跑，但 handleSortChange 的调用已
 *     先置 songsLoadingRef，isRefresh=false 的补发会被守卫挡住）。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILE = path.join(ROOT, 'src/screens/ArtistDetail/index.tsx')

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

console.log('Bug 60 排序切换单次加载契约：')

const src = read(FILE)

check(
  !/isFirstSortEffect/.test(src),
  '排序 effect 的首轮跳过 ref 已删除（第二个 effect 已删）',
)
check(
  !/\}, \[songs\.sort, loadSongs\]\)/.test(src),
  '不再有以 [songs.sort, loadSongs] 为依赖的 effect',
)
const sortStart = src.indexOf('const handleSortChange')
const sortBody = sortStart >= 0 ? src.slice(sortStart, src.indexOf('const handleTabChange', sortStart)) : ''
check(sortStart >= 0, '找到 handleSortChange')
check(
  /loadSongs\(newSort, 1, true\)/.test(sortBody),
  'handleSortChange 直接调 loadSongs(newSort, 1, true)',
)
// 第一个 effect：只测依赖数组本身（effect 内注释会提到 songs.sort，不能全量测）
const firstEffect = src.match(/useEffect\(\(\) => \{\s*if \(activeTab === 'songs'\)[\s\S]*?\}, \[([^\]]*)\]\)/)
check(
  !!firstEffect && /songs\.list\.length/.test(firstEffect[1]) && !/songs\.sort/.test(firstEffect[1]),
  '第一个 effect 依赖含 songs.list.length、不含 songs.sort',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
