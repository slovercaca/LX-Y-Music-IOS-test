#!/usr/bin/env node
/**
 * Gemini Bug 32 契约：已在 list Tab 时定位跳转不写 pendingJumpIdRef。
 *   此前先写 pending 再 scrollToMusic；已在 list 时 setActiveTab('list')
 *   是同值调用、消费 effect 不触发，pending 残留到下次切回 list 时误跳旧歌。
 *   修法：activeTabRef 读当前 tab，已在 list 时直接滚动并清空 pending，
 *   仅非 list 时才写 pending。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const PAGE = path.join(ROOT, 'src/screens/Home/Views/WebDAV/useWebDAVPage.ts')

let failures = 0
const check = (ok, msg) => {
  console.log(ok ? `  ✓ ${msg}` : `  ✗ ${msg}`)
  if (!ok) failures++
}

console.log('Gemini Bug 32 契约（定位跳转不残留 pending）：')

const src = fs.readFileSync(PAGE, 'utf8')

check(
  src.includes("const activeTabRef = useRef<ActiveTab>('list')"),
  '新增 activeTabRef（初始值与 activeTab state 一致）',
)
check(
  src.includes('activeTabRef.current = activeTab'),
  '有 effect 把 activeTab 同步到 activeTabRef',
)

const handlerStart = src.indexOf('const handleJumpPosition = () => {')
const handlerBody = src.slice(handlerStart, src.indexOf('}, [scrollToMusic])', handlerStart))
check(
  handlerBody.includes("if (activeTabRef.current === 'list')"),
  'handleJumpPosition 按 activeTabRef 判断是否已在 list',
)
check(
  handlerBody.includes('pendingJumpIdRef.current = null'),
  '已在 list 时清空残留 pending',
)
check(
  handlerBody.includes('pendingJumpIdRef.current = musicInfo.id'),
  '非 list 时仍写 pending（等切 tab 后由消费 effect 滚动）',
)
check(
  handlerBody.indexOf('pendingJumpIdRef.current = null') < handlerBody.indexOf('pendingJumpIdRef.current = musicInfo.id'),
  '清空分支在前、写 pending 分支在后（list 分支不写 pending）',
)
check(
  handlerBody.includes('scrollToMusic(musicInfo.id)'),
  '两种情况都照常 scrollToMusic',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
