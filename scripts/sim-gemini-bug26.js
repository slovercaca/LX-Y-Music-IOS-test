#!/usr/bin/env node
/**
 * Gemini Bug 26 契约：下载自定义音源后，基线 Hash 按落盘后本地实际值算。
 *   比对侧 localHash 是 getAllDataForSync 重建的 { list, scripts }（仅含
 *   名单内脚本、固定键顺序），直接存远端原始 JSON 会在键顺序/孤立脚本键
 *   不同时误判本地有变、下一轮误传一次。
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

console.log('Gemini Bug 26 契约（音源基线按落盘后实际值）：')

const src = fs.readFileSync(SYNC, 'utf8')

check(
  (src.match(/const \{ userApis: writtenApis \} = await getAllDataForSync\(\)/g) || []).length === 2,
  '两处下载分支（自动 + 手动）都在 overwriteUserApis 后重读落盘实际值',
)
check(
  (src.match(/'sync\.webdav\.lastSyncUserApisHash': JSON\.stringify\(writtenApis\)/g) || []).length === 2,
  '两处基线都存 JSON.stringify(writtenApis)',
)
check(
  !src.includes("'sync.webdav.lastSyncUserApisHash': JSON.stringify(remoteData.data)"),
  '自动下载分支不再存远端原始 JSON（remoteData.data）',
)
check(
  !src.includes("'sync.webdav.lastSyncUserApisHash': JSON.stringify(remoteApisData.data)"),
  '手动下载分支不再存远端原始 JSON（remoteApisData.data）',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
