#!/usr/bin/env node
/**
 * Gemini Bug 25 契约：debouncedSync 仅清已同步域的脏标志。
 *   triggerWebDAVSync 在歌单开关关闭、双端冲突、弹窗取消、远端解析失败等
 *   跳过路径下也返回 'ok'，旧 debouncedSync 无条件清标志，自动同步停滞到
 *   下一次用户变更。修法：各域返回是否真正跑完，记在 lastSyncOutcomes，
 *   debouncedSync 成功后仅清已同步域。
 *   'ok'/'failed'/'not-run'/'not-configured' 四态契约与 3-6 锚点不动。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SYNC = path.join(ROOT, 'src/core/sync/webdavSync.ts')

let failures = 0
const check = (ok, msg) => {
  console.log(ok ? `  ✓ ${msg}` : `  ✗ ${msg}`)
  if (!ok) failures++
}

console.log('Gemini Bug 25 契约（debouncedSync 按域清标志）：')

const src = fs.readFileSync(SYNC, 'utf8')

check(
  src.includes('async function syncSettingsAuto(): Promise<boolean>'),
  'syncSettingsAuto 返回 Promise<boolean>（是否真正跑完）',
)
check(
  src.includes('async function syncUserApisAuto(): Promise<boolean>'),
  'syncUserApisAuto 返回 Promise<boolean>（是否真正跑完）',
)
check(
  src.includes('let lastSyncOutcomes = { lists: false, settings: false, apis: false }'),
  '模块级 lastSyncOutcomes 记录各域结果',
)
check(
  src.includes('lastSyncOutcomes.settings = await syncSettingsAuto()') &&
  src.includes('lastSyncOutcomes.apis = await syncUserApisAuto()'),
  'runSettingsAndApisSync 记录设置/音源两域结果',
)
check(
  src.includes('if (listsChangeSeq === lSeq && lastSyncOutcomes.lists) listsChanged = false'),
  'debouncedSync 仅在歌单域真正跑完时清 listsChanged',
)
check(
  !src.includes('if (listsChangeSeq === lSeq) listsChanged = false'),
  '不存在无条件清 listsChanged 的旧写法残留',
)
check(
  src.includes("if (settingsChangeSeq === sSeq && settingsSynced) settingsChanged = false"),
  'debouncedSync 仅在设置/音源域（开关关闭视为无需同步）都跑完时清 settingsChanged',
)
check(
  (src.match(/lastSyncOutcomes\.lists = true/g) || []).length === 7,
  '歌单域完成点有 7 处（云端无文件 / 首次同步 / 冲突上传 / 冲突下载 / 合并 / 本地上传 / 双端一致）',
)
// 3-6 锚点（sim-gemini-round2-contract.js 同款）不得破坏。
check(src.includes('let succeeded = true'), '3-6 锚点：succeeded 跟踪变量仍在')
check(src.includes('succeeded = false'), '3-6 锚点：catch 里 succeeded 置 false 仍在')
check(src.includes("return succeeded ? 'ok' : 'failed'"), '3-6 锚点：四态返回行仍在')

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
