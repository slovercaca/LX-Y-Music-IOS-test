#!/usr/bin/env node
/**
 * Gemini Bug 23 契约：下载远端设置落盘用不标脏的 settingActions.updateSetting。
 *   标脏版会让 3 秒后防抖空跑一轮同步；store 直写同样广播与落盘，仅跳过
 *   markSettingsChanged（webdavFailover.ts 已有相同用法先例）。
 *   只改两处下载落盘，基线 updateSetting（仅 lastSync* 键，本就不标脏）不动。
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

console.log('Gemini Bug 23 契约（下载设置落盘不标脏）：')

const src = fs.readFileSync(SYNC, 'utf8')

check(
  src.includes("import settingActions from '@/store/setting/action'"),
  'webdavSync.ts 引入 settingActions',
)
check(
  (src.match(/settingActions\.updateSetting\(filtered\)/g) || []).length === 2,
  '两处下载落盘（自动 + 手动）都走 settingActions.updateSetting(filtered)',
)
check(
  (src.match(/updateSetting\(filtered\)/g) || []).length === 2,
  '不存在标脏版 updateSetting(filtered) 残留（总数与不标脏版一致）',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
