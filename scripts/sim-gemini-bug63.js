#!/usr/bin/env node
/**
 * Bug 63 契约（Gemini 审查 2026-11-21）：
 *   评论加载更多回调 listRef.current 缺少判空与异常捕获——CommentHot 与
 *   CommentNew 的 handleListLoadMore 的 .then 内
 *   listRef.current?.setList(filterList([...listRef.current.getList(),
 *   ...comments]))，外层 ?. 只保护 setList，内层 getList 无保护；链上无
 *   .catch，void 丢弃。请求在途退出评论页后回调到达，内层裸读抛 TypeError，
 *   成为未处理 rejection。
 *
 * 钉住的不变量（两文件同改）：
 *   - .then 内先 if (!listRef.current) return 再读 getList。
 *   - 链上补 .catch(() => {})。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILES = [
  'src/screens/Comment/CommentHot.tsx',
  'src/screens/Comment/CommentNew.tsx',
]

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

console.log('Bug 63 评论加载更多判空与捕获契约：')

for (const rel of FILES) {
  const name = path.basename(rel)
  const src = read(path.join(ROOT, rel))
  const loadStart = src.indexOf('const handleListLoadMore')
  const loadBody = loadStart >= 0 ? src.slice(loadStart, src.indexOf('const handleListRefresh', loadStart)) : ''
  check(loadStart >= 0, `${name}：找到 handleListLoadMore`)
  check(
    /\.then\(\(\{ comments \}\) => \{\s*\/\/ Bug 63[\s\S]*?if \(!listRef\.current\) return/.test(loadBody),
    `${name}：.then 内先判空 listRef.current 再读 getList`,
  )
  check(
    /\.catch\(\(\) => \{\}\)\s*\.finally\(updateStatus\)/.test(loadBody),
    `${name}：链上补 .catch(() => {})（在 .finally 之前）`,
  )
  // 判空必须在 getList 读取之前（从判空位置之后找 getList，排除注释提及）
  const guardPos = loadBody.indexOf('if (!listRef.current) return')
  const getListPos = guardPos >= 0 ? loadBody.indexOf('listRef.current.getList()', guardPos) : -1
  check(
    guardPos >= 0 && getListPos >= 0 && guardPos < getListPos,
    `${name}：判空在 getList 读取之前`,
  )
}

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
