#!/usr/bin/env node
/**
 * Gemini Bug 28 契约：WS 同步客户端 connect 回调内统一用局部 socket。
 *   旧连接的 close/error/finished/open 回调读模块级 client，会在重连后
 *   覆写新连接状态；消息解密是异步的，onCallBeforeParams 读 client 会把
 *   旧连接的 RPC 发到新 socket 上（各 handler 都依赖首参 socket 身份）。
 *   与 3-10(a) 的 connectGen 代际机制配合，不重复、不冲突。
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

console.log('Gemini Bug 28 契约（WS 客户端用闭包 socket）：')

const src = fs.readFileSync(CLIENT, 'utf8')
const fnStart = src.indexOf('export const connect = ')
const fnBody = src.slice(fnStart)

check(
  fnBody.includes('return [socket, ...rawArgs]'),
  'onCallBeforeParams 返回闭包 socket（旧连接 RPC 不串到新 socket）',
)
check(
  !fnBody.includes('return [client, ...rawArgs]'),
  'onCallBeforeParams 不再读模块级 client',
)
check(
  fnBody.includes('socket.isReady = true') && !src.includes('client!.isReady'),
  'finished() 用 socket.isReady，不再用 client!.isReady（disconnect 后不抛空指针）',
)
check(
  fnBody.includes('socket.isReady = false') && fnBody.includes('socket.moduleReadys = {'),
  'open 处理器用闭包 socket 设 isReady/moduleReadys',
)
check(
  (src.match(/if \(socket !== client\) return/g) || []).length === 5,
  'socket !== client 守卫有 5 处（finished / open / close / error / 心跳 close 监听）',
)
check(
  !/client\?\.close\(SYNC_CLOSE_CODE\.failed\)/.test(fnBody.replace(/\/\/.*$/gm, '')),
  '消息解析/解密失败时关本连接 socket，不再关模块级 client（忽略旧注释行）',
)
// 3-10(a) 代际机制仍在，不被重复或冲突。
check(src.includes('let connectGen = 0'), '3-10(a) connectGen 代际机制仍在')
check(src.includes('if (gen !== connectGen) return'), '延迟重连的代际检查仍在')

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
