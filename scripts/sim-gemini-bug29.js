#!/usr/bin/env node
/**
 * Gemini Bug 29 契约：hello() 的 .catch 放行版本不匹配错误，只吞网络异常。
 *   此前 high/lowServiceVersion 也被吞成 false，调用方只能抛
 *   connectServiceFailed，用户看不到版本不匹配的真实原因。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const AUTH = path.join(ROOT, 'src/plugins/sync/client/auth.ts')

let failures = 0
const check = (ok, msg) => {
  console.log(ok ? `  ✓ ${msg}` : `  ✗ ${msg}`)
  if (!ok) failures++
}

console.log('Gemini Bug 29 契约（hello 放行版本错误）：')

const src = fs.readFileSync(AUTH, 'utf8')
const helloStart = src.indexOf('const hello = ')
const helloBody = src.slice(helloStart, src.indexOf('const getServerId'))

check(
  helloBody.includes('if (err?.message === SYNC_CODE.highServiceVersion || err?.message === SYNC_CODE.lowServiceVersion) throw err'),
  'hello 的 .catch 按 err.message 比对后重新抛出版本不匹配错误',
)
check(
  helloBody.includes('return false'),
  '网络异常仍吞成 false（调用方照常报连接失败）',
)
// .then 回调里也有一个 return false（版本无差异时），只在 .catch 块内比顺序。
const catchBody = helloBody.slice(helloBody.indexOf('.catch('))
check(
  catchBody.indexOf('throw err') < catchBody.indexOf('return false'),
  '版本错误放行在 .catch 的 return false 之前（放行先生效）',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
