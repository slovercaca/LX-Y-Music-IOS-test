#!/usr/bin/env node
/**
 * Bug 50 契约（Gemini 审查 2026-11-21）：
 *   隐藏自建歌单后拖拽排序下标错位——persistReorder 直接把可见下标 to
 *   传给 updateUserListPosition，而底层 list_update_position 操作的是完整
 *   自建歌单数组（含隐藏歌单，不含默认/我喜欢歌单），position 是移除待移项
 *   后的插入下标。可见下标与完整下标之间差了「目标位置之前隐藏歌单的数量」。
 *
 * 钉住的不变量：
 *   - persistReorder 用重排后相邻可见歌单在完整自建歌单数组中的位置换算
 *     完整下标（下标基数是 allList 滤掉 DEFAULT/LOVE 后的自建歌单数组，
 *     不是 allList 本身——allList 前两项不在底层数组内，直接用会偏 2）。
 *   - 换算时考虑「移除 moved 后其后的项下标前移一位」。
 *   - 换算算法本身用纯函数模拟验证（两组拖拽场景）。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILE = path.join(ROOT, 'src/screens/Home/Views/Mylist/NewListUI.tsx')

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

console.log('Bug 50 拖拽排序下标换算契约：')

const src = read(FILE)
const start = src.indexOf('const persistReorder')
const body = start >= 0 ? src.slice(start, src.indexOf('const handleDragRelease', start)) : ''

check(start >= 0, '找到 persistReorder')
check(
  /const fullLists = allList\.filter\(l => l\.id !== LIST_IDS\.DEFAULT && l\.id !== LIST_IDS\.LOVE\)/.test(body),
  '完整下标的基数是 allList 滤掉 DEFAULT/LOVE 后的自建歌单数组',
)
check(
  /const movedFullIndex = fullLists\.findIndex\(l => l\.id === moved\.id\)/.test(body),
  '取 moved 在完整数组中的下标',
)
check(
  /indexAfterRemoval/.test(body) && /fullIndex > movedFullIndex \? fullIndex - 1 : fullIndex/.test(body),
  '换算时考虑移除 moved 后其后的项下标前移一位',
)
check(
  /const after = next\[to \+ 1\]/.test(body) && /const before = next\[to - 1\]/.test(body),
  '用重排后相邻可见歌单（后一项 / 末尾时前一项）定位插入点',
)
check(
  /void updateUserListPosition\(fullPosition, \[moved\.id\]\)/.test(body),
  '传换算后的完整下标 fullPosition，不再直接传可见下标 to',
)
check(
  !/void updateUserListPosition\(to, \[moved\.id\]\)/.test(body),
  '不再直接传可见下标 to',
)
check(
  /\[userLists, allList\]/.test(body),
  'persistReorder 依赖包含 allList',
)

// --- 换算算法模拟（与实现同规则） ---
const convert = (fullLists, visible, from, to) => {
  const next = [...visible]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  const movedFullIndex = fullLists.indexOf(moved)
  const indexAfterRemoval = (fi) => (movedFullIndex >= 0 && fi > movedFullIndex ? fi - 1 : fi)
  const after = next[to + 1]
  if (after) return indexAfterRemoval(fullLists.indexOf(after))
  const before = next[to - 1]
  return indexAfterRemoval(fullLists.indexOf(before)) + 1
}
const apply = (fullLists, moved, pos) => {
  const rest = fullLists.filter(l => l !== moved)
  rest.splice(Math.max(0, Math.min(pos, rest.length)), 0, moved)
  return rest
}
// 完整：[A, H1(隐藏), B, C, H2(隐藏), D]，可见：[A, B, C, D]
const full = ['A', 'H1', 'B', 'C', 'H2', 'D']
const visible = ['A', 'B', 'C', 'D']
// 场景 1：拖 B（可见 1）到可见末尾（可见 3）→ 完整数组里 B 应落到 D 之后
const pos1 = convert(full, visible, 1, 3)
check(
  JSON.stringify(apply(full, 'B', pos1)) === JSON.stringify(['A', 'H1', 'C', 'H2', 'D', 'B']),
  `拖 B 到可见末尾：换算下标 ${pos1}，落点在 D 之后（旧代码传 3 会插到 C 之前）`,
)
// 场景 2：拖 D（可见 3）到可见 1（A、B 之间）→ 完整数组里 D 应落到 A、H1 之后、B 之前
const pos2 = convert(full, visible, 3, 1)
check(
  JSON.stringify(apply(full, 'D', pos2)) === JSON.stringify(['A', 'H1', 'D', 'B', 'C', 'H2']),
  `拖 D 到可见 1：换算下标 ${pos2}，落点在 A、H1 之后、B 之前`,
)
// 场景 3：无隐藏歌单时换算结果与可见下标一致（无回归）
const pos3 = convert(['A', 'B', 'C', 'D'], ['A', 'B', 'C', 'D'], 0, 2)
check(pos3 === 2, `无隐藏歌单时换算下标 ${pos3} 与可见下标一致`)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
