#!/usr/bin/env node
/**
 * Bug 51 契约（Gemini 审查 2026-11-21）：
 *   搜索页从歌单详情返回后输入框清空且「取消」按钮消失——selectedList 变
 *   null 时 setHeaderKey 重挂载 HeaderBar，但没有恢复输入文本；HeaderBar 的
 *   text/hasText state 重挂载后重置为空/false，「取消」按钮只在 hasText 时渲染。
 *
 * 钉住的不变量：
 *   - 存在一个以 headerKey 为依赖的 effect，在重挂载提交后（ref 已指向新
 *     实例）调用 headerBarRef.current?.setText(searchState.searchText)。
 *   - 该 effect 只在有搜索文本时调用（空文本不扰动）。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILE = path.join(ROOT, 'src/screens/Home/Views/Search/index.tsx')

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

console.log('Bug 51 搜索页返回恢复输入框契约：')

const src = read(FILE)

check(
  /useEffect\(\(\) => \{\s*if \(searchState\.searchText\) \{\s*headerBarRef\.current\?\.setText\(searchState\.searchText\)\s*\}\s*\}, \[headerKey\]\)/.test(src),
  '存在 headerKey 依赖的 effect，重挂载后恢复搜索文本',
)
check(
  /\/\/ Bug 51/.test(src),
  '恢复 effect 带有 Bug 51 注释',
)
// 反例自检：删掉该 effect 后检查能失败
const fake = src.replace(/useEffect\(\(\) => \{\s*if \(searchState\.searchText\) \{\s*headerBarRef\.current\?\.setText\(searchState\.searchText\)\s*\}\s*\}, \[headerKey\]\)/, '')
check(
  !/useEffect\(\(\) => \{\s*if \(searchState\.searchText\) \{\s*headerBarRef\.current\?\.setText\(searchState\.searchText\)\s*\}\s*\}, \[headerKey\]\)/.test(fake),
  '反例自检：删掉恢复 effect 后，检查能失败',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
