#!/usr/bin/env node
/**
 * Gemini Bug 22 契约：putFileWithProgressInternal 的统一取消状态。
 *   修复属实部分：入口即暴露句柄（stat + DELETE 期间）、降级 readFile
 *   之后、verify 之前各有检查；原生/降级两通道共享 outerAborted。
 *   严格的"块间间隙"因 putViaNative 同步注册句柄而不可达，不修。
 *   看门狗在 readFile 期间触发清 stallTimer 是 deferred 项，不修。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const UPLOAD = path.join(ROOT, 'src/core/webdavMusic/upload.ts')

let failures = 0
const check = (ok, msg) => {
  console.log(ok ? `  ✓ ${msg}` : `  ✗ ${msg}`)
  if (!ok) failures++
}

console.log('Gemini Bug 22 契约（上传统一取消状态）：')

const src = fs.readFileSync(UPLOAD, 'utf8')
const fnStart = src.indexOf('const putFileWithProgressInternal')
const fnBody = src.slice(fnStart)

check(fnBody.includes('let outerAborted = false'), '函数顶部维护统一的 outerAborted')
check(fnBody.includes('let activeCancel: (() => void) | null = null'), '函数顶部维护 activeCancel')
check(
  fnBody.indexOf('exposeAbortHandle()') >= 0 &&
  fnBody.indexOf('exposeAbortHandle()') < fnBody.indexOf('await statFile(localPath)'),
  '入口即暴露句柄（在第一个 await 之前同步执行）',
)
check(
  (fnBody.match(/nativeAbortHandle,/g) || []).length === 2,
  '分块与单 PUT 两处 putViaNative 都走 nativeAbortHandle 包装',
)
check(
  (fnBody.match(/if \(outerAborted\) throw new UploadAbortedError\(\)/g) || []).length === 6,
  'outerAborted 检查点有 6 处（DELETE 后 / 每块前 / 分块 verify 前 / 单 PUT 前 / 单 verify 前 / readFile 后）',
)
check(
  (fnBody.match(/outerAborted \|\| abortRequested/g) || []).length === 4,
  '降级通道 4 处 abort 检查都同时看 outerAborted',
)
check(
  fnBody.includes('activeCancel = fallbackAbort'),
  '降级通道把取消动作记为 activeCancel',
)
check(
  (fnBody.match(/outerAborted = true/g) || []).length === 2,
  '入口句柄与降级句柄都置 outerAborted（共 2 处）',
)
// 禁区：deleteRemoteFileOrAbort（删失败即中止以保护旧文件）不得改动。
check(
  src.includes('throw new Error(`删除远端旧文件失败（HTTP ${status ?? \'未知\'}），已中止上传以保护旧文件：${remotePath}`)'),
  '禁区：upload.ts 的 deleteRemoteFileOrAbort 保护旧文件逻辑未动',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
