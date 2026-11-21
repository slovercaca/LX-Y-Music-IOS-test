#!/usr/bin/env node
/**
 * Bug 52 契约（Gemini 审查 2026-11-21）：
 *   音源测试 HEAD 失败清除缓存重取后仍用过期旧 url——const url = result?.url
 *   无法更新；重取只重写了 result，url 仍指向旧值，且新 HEAD 只读了
 *   content-length，未更新 contentTypeExt/realFileName。后续日志、扩展名判定、
 *   成功记录都用旧 url，「同源一致」被打破。
 *
 * 钉住的不变量：
 *   - url 用 let 声明，重取成功后同步更新 url = newUrl。
 *   - 从 newHeadResponse 重读 content-type 与 content-disposition，更新
 *     contentTypeExt / realFileName。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILE = path.join(ROOT, 'src/screens/Home/Views/Setting/settings/Basic/SourceTest.tsx')

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

console.log('Bug 52 音源测试重取同步 url 契约：')

const src = read(FILE)

check(
  /let url = result\?\.url/.test(src),
  'url 用 let 声明（可更新）',
)
check(
  !/const url = result\?\.url/.test(src),
  '不再用 const url（旧代码无法更新）',
)
const retryStart = src.indexOf('result = { url: newUrl, type: quality }')
const retryBody = retryStart >= 0 ? src.slice(retryStart, retryStart + 1600) : ''
check(retryStart >= 0, '找到清缓存重取分支')
check(
  /url = newUrl/.test(retryBody),
  '重取成功后同步更新 url = newUrl',
)
check(
  /const newContentType = newHeadResponse\.headers\.get\('content-type'\)/.test(retryBody) &&
  /contentTypeExt = contentTypeMap\[newContentType \|\| ''\] \|\| ''/.test(retryBody),
  '从 newHeadResponse 重读 content-type 更新 contentTypeExt',
)
check(
  /const newContentDisposition = newHeadResponse\.headers\.get\('content-disposition'\)/.test(retryBody) &&
  /realFileName = decodeURIComponent\(newFilenameMatch\[1\]\.replace\(\/"\/g, ''\)\)/.test(retryBody),
  '从 newHeadResponse 重读 content-disposition 更新 realFileName',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
