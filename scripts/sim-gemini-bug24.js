#!/usr/bin/env node
/**
 * Gemini Bug 24 契约：WebDAV 下载/合并歌单调 overwriteListFull 必须标 isRemote。
 *   不标时 list_data_overwrite 会入队 + 标脏，新 op 落在 opsAtStart 快照之外
 *   清不掉，3 秒后防抖把刚下载的云端数据原样再上传一次（回声重传）。
 *   isRemote 分支仅跳过入队与标脏，落盘、保存与 UI 刷新完全相同。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const LIST = path.join(ROOT, 'src/core/list.ts')
const SYNC = path.join(ROOT, 'src/core/sync/webdavSync.ts')
const BACKUP = path.join(ROOT, 'src/screens/Home/Views/Setting/settings/Backup/actions.ts')

let failures = 0
const check = (ok, msg) => {
  console.log(ok ? `  ✓ ${msg}` : `  ✗ ${msg}`)
  if (!ok) failures++
}

console.log('Gemini Bug 24 契约（overwriteListFull isRemote）：')

const listSrc = fs.readFileSync(LIST, 'utf8')
const syncSrc = fs.readFileSync(SYNC, 'utf8')
const backupSrc = fs.readFileSync(BACKUP, 'utf8')

check(
  listSrc.includes('export const overwriteListFull = async(data: LX.List.ListActionDataOverwrite, isRemote: boolean = false)'),
  'overwriteListFull 增加 isRemote 参数（默认 false，本地调用方行为不变）',
)
check(
  listSrc.includes('await global.list_event.list_data_overwrite(data, isRemote)'),
  'overwriteListFull 把 isRemote 透传给 list_data_overwrite',
)
check(
  (syncSrc.match(/overwriteListFull\([^)]*,\s*true\)/g) || []).length === 4,
  'webdavSync.ts 4 处调用（手动下载 / 首次同步 / 冲突下载 / 合并）都传 true',
)
check(
  (syncSrc.match(/await overwriteListFull\(/g) || []).length === 4,
  'webdavSync.ts 没有漏标的 overwriteListFull 调用（总数即为 4）',
)
check(
  !/overwriteListFull\([^)]*,\s*true\)/.test(backupSrc),
  '备份恢复/导入仍走默认 false（本地操作应入队标脏，行为不变）',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
