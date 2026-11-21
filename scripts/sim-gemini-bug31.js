#!/usr/bin/env node
/**
 * Gemini Bug 31 契约：getLocalListData 请求前快照 userLists。
 *   userLists 是模块级可变数组，getListMusics 异步等待期间增删/重排歌单
 *   会让 .then 里重读的 userLists 与 Promise.all 结果下标错位，错配的
 *   歌单数据会发给对端设备。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const LIST_EVENT = path.join(ROOT, 'src/plugins/sync/listEvent.ts')

let failures = 0
const check = (ok, msg) => {
  console.log(ok ? `  ✓ ${msg}` : `  ✗ ${msg}`)
  if (!ok) failures++
}

console.log('Gemini Bug 31 契约（getLocalListData 快照 userLists）：')

const src = fs.readFileSync(LIST_EVENT, 'utf8')
const fnStart = src.indexOf('export const getLocalListData')
const fnBody = src.slice(fnStart, src.indexOf('export const setLocalListData'))

check(
  fnBody.includes('const lists = [...userLists]'),
  '请求前 const lists = [...userLists] 快照',
)
check(
  fnBody.indexOf('const lists = [...userLists]') < fnBody.indexOf('return Promise.all'),
  '快照在 Promise.all 之前',
)
check(
  fnBody.includes('...lists.map(async(l) => getListMusics(l.id))'),
  'Promise.all 内用快照 lists 取歌单曲目',
)
check(
  fnBody.includes('userList: lists.map((l, i) => buildUserListInfoFull({ ...l, list: userList[i] }))'),
  '.then 内用同一快照 lists 组装结果（下标对齐）',
)
check(
  !fnBody.includes('userLists.map('),
  '.then 内不再重读可变的 userLists',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
