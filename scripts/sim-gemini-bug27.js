#!/usr/bin/env node
/**
 * Gemini Bug 27 契约：rotateToWorkingProfile 每次尝试候选前先把 path
 * 重置为快照值。
 *   带 path 的候选试连失败后 path 已被改写，随后无 path 的老配置 apply
 *   时按「无 path 保留当前 path」会残留上一个候选的目录，同步写错地方。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FAILOVER = path.join(ROOT, 'src/core/sync/webdavFailover.ts')

let failures = 0
const check = (ok, msg) => {
  console.log(ok ? `  ✓ ${msg}` : `  ✗ ${msg}`)
  if (!ok) failures++
}

console.log('Gemini Bug 27 契约（故障转移前重置 path）：')

const src = fs.readFileSync(FAILOVER, 'utf8')
const fnStart = src.indexOf('const rotateToWorkingProfile')
const fnBody = src.slice(fnStart)

const reset = "settingActions.updateSetting({ 'sync.webdav.path': snapshot['sync.webdav.path'] })"
const apply = 'applyWebDAVServerProfile(candidate.id'

check(fnBody.includes(reset), '轮换循环内有 path 重置为快照值')
check(
  fnBody.indexOf(reset) >= 0 && fnBody.indexOf(reset) < fnBody.indexOf(apply),
  'path 重置在每次 applyWebDAVServerProfile 之前',
)
check(
  (fnBody.match(/settingActions\.updateSetting\(\{ 'sync\.webdav\.path'/g) || []).length === 1,
  'path 重置只出现一次（循环内统一处理，无多余重置）',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
