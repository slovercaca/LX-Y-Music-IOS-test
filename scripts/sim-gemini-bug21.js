#!/usr/bin/env node
/**
 * Gemini Bug 21 契约：scanFolder 的父目录通用封面回退必须在第一遍
 * 循环之后（仍在第二遍递归之前）。
 *   此前继承在循环之前，父 cover.jpg（优先级 0）占住 genericPic 后，
 *   子目录任何通用封面都因严格小于比较（0 < 0 为假）换不掉。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const LIBRARY = path.join(ROOT, 'src/core/webdavMusic/library.ts')

let failures = 0
const check = (ok, msg) => {
  console.log(ok ? `  ✓ ${msg}` : `  ✗ ${msg}`)
  if (!ok) failures++
}

console.log('Gemini Bug 21 契约（scanFolder 父封面回退位置）：')

const src = fs.readFileSync(LIBRARY, 'utf8')
const fnStart = src.indexOf('scanFolder')
const fnBody = src.slice(fnStart)

const fallback = 'if (!media.genericPic && parentGenericPic) media.genericPic = parentGenericPic'
const priorityCmp = 'genericPicPriority.indexOf(base) < genericPicPriority.indexOf(currentBase)'
const secondPass = '// 第二遍：递归子目录 + 收集音频'

const fallbackIdx = fnBody.indexOf(fallback)
const cmpIdx = fnBody.indexOf(priorityCmp)
const secondIdx = fnBody.indexOf(secondPass)

check(fallbackIdx >= 0, '父目录通用封面回退赋值存在')
check(
  (fnBody.match(/if \(!media\.genericPic && parentGenericPic\) media\.genericPic = parentGenericPic/g) || []).length === 1,
  '回退赋值只出现一次（没有旧位置残留）',
)
check(
  fallbackIdx > cmpIdx && cmpIdx >= 0,
  '回退赋值在第一遍循环的优先级比较之后（本地封面先按优先级选）',
)
check(
  fallbackIdx < secondIdx && secondIdx >= 0,
  '回退赋值仍在第二遍递归之前（不影响向下传递给孙目录）',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
