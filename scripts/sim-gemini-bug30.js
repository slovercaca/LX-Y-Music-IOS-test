#!/usr/bin/env node
/**
 * Gemini Bug 30 契约：heartbeatTools 关闭分支清定时器，超限不再 throw。
 *   socket 在 open 前以 failed 码关闭时，残留的 2 分钟 connectTimeout
 *   会误触发一次重连（与"failed 不重连"意图相悖）；两处 throw 位于异步
 *   回调内，属未捕获异常。normal/failed 分支清定时器前先确认是当前连接
 *   的 socket，避免清掉新连接的定时器。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const CLIENT = path.join(ROOT, 'src/plugins/sync/client/client.ts')

let failures = 0
const check = (ok, msg) => {
  console.log(ok ? `  ✓ ${msg}` : `  ✗ ${msg}`)
  if (!ok) failures++
}

console.log('Gemini Bug 30 契约（心跳定时器清理与超限不抛错）：')

const src = fs.readFileSync(CLIENT, 'utf8')
const hbStart = src.indexOf('const heartbeatTools = {')
const hbBody = src.slice(hbStart, src.indexOf('let client: LX.Sync.Socket | null'))

check(
  !hbBody.includes("throw new Error('connect error')"),
  '两处 throw new Error(\'connect error\') 已移除',
)
check(
  (hbBody.match(/log\.error\('connect error: max retry reached'\)/g) || []).length === 2,
  '两处超限都改为 log.error + return（共 2 处）',
)
const closeStart = hbBody.indexOf("socket.addEventListener('close'")
const closeBody = hbBody.slice(closeStart)
check(
  closeBody.includes('if (socket !== client) return'),
  '心跳 close 监听先确认是当前连接的 socket（旧 socket 迟到 close 不动新连接）',
)
check(
  closeBody.indexOf('if (socket !== client) return') < closeBody.indexOf('this.clearTimeout()'),
  '代际确认在清定时器之前（不误清新连接的定时器）',
)
check(
  closeBody.includes('this.clearTimeout()'),
  'normal/failed 关闭分支先清定时器（不残留 connectTimeout 致非预期重连）',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
