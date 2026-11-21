#!/usr/bin/env node
/**
 * Bug 69 契约（2026-11-21，Gemini 全量审查）：
 *   __lx_native_call__set_timeout 的 dispatch_after 只捕获 identifier 和
 *   timeout，未捕获代际标识；dispatch_after 不可取消。脚本重载后旧定时器
 *   到期，直接调新上下文的 __set_timeout__，而 preload 每上下文 timeoutId
 *   都从 0 递增，新脚本同编号回调会被提前/错误触发。
 *   （注：动作名是 __set_timeout__，Gemini 原文的 set_timeout 是笔误。）
 *
 * 本脚本钉住的不变量：
 *   - 注册时捕获 scheduledKey = [weakSelf.scriptKey copy]。
 *   - 回调内校验 scheduledKey 与当前 scriptKey 相等才触发。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const APP_DELEGATE = path.join(ROOT, 'ios/LxMusicMobile/AppDelegate.mm')

let failures = 0
const check = (ok, msg) => {
  console.log(ok ? `  ✓ ${msg}` : `  ✗ ${msg}`)
  if (!ok) failures++
}

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    check(false, `读取失败：${p}`)
    return ''
  }
}

console.log('Bug 69 契约（setTimeout 脚本重载代际校验）：')

const src = read(APP_DELEGATE)
const blkStart = src.indexOf('context[@"__lx_native_call__set_timeout"]')
const blkEnd = src.indexOf('NSString *preloadScript = [self loadPreloadScript];', blkStart)
const blkBody = blkStart >= 0 && blkEnd > blkStart ? src.slice(blkStart, blkEnd) : ''

check(blkBody.length > 0, '定位到 __lx_native_call__set_timeout block')
if (blkBody.length > 0) {
  check(
    /NSString \*scheduledKey = \[weakSelf\.scriptKey copy\];/.test(blkBody),
    '注册时捕获 scheduledKey = [weakSelf.scriptKey copy]',
  )
  const captureAt = blkBody.indexOf('NSString *scheduledKey = [weakSelf.scriptKey copy];')
  const dispatchAt = blkBody.indexOf('dispatch_after(')
  const guardAt = blkBody.indexOf('if (scheduledKey == nil || ![scheduledKey isEqualToString:weakSelf.scriptKey]) return;')
  const callAt = blkBody.indexOf('[weakSelf callJSAction:@"__set_timeout__" data:identifier ?: @0];')
  check(
    captureAt >= 0 && dispatchAt > captureAt,
    '捕获发生在 dispatch_after 之前',
  )
  check(
    guardAt > dispatchAt && guardAt > 0,
    '回调内校验 scheduledKey 与当前 scriptKey 相等才触发',
  )
  check(
    callAt > guardAt && callAt > 0,
    '校验在 callJSAction 之前（失败即丢弃，不触新脚本回调）',
  )
  check(
    /callJSAction:@"__set_timeout__"/.test(blkBody),
    '动作名是 __set_timeout__（非 Gemini 笔误的 set_timeout）',
  )
}

// --- 反例自检 ---
const fakeBlk = blkBody.replace('if (scheduledKey == nil || ![scheduledKey isEqualToString:weakSelf.scriptKey]) return;\n      ', '')
check(
  !/scheduledKey isEqualToString/.test(fakeBlk),
  '反例自检：删掉回调内校验后，校验检查能失败',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
