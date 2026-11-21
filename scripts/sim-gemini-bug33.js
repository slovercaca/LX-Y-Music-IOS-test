#!/usr/bin/env node
/**
 * Gemini Bug 33 契约：批量入队配对歌词/封面时，查重在 await stat() 之后、
 * set 之前的同一同步块内。
 *   此前查重与 set 之间隔了一次 await，同批两首同底名音频的配对任务都会
 *   在对方写入前通过查重，随后重复入队同一歌词/封面。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MANAGER = path.join(ROOT, 'src/screens/Home/Views/WebDAV/useUploadManager.ts')

let failures = 0
const check = (ok, msg) => {
  console.log(ok ? `  ✓ ${msg}` : `  ✗ ${msg}`)
  if (!ok) failures++
}

console.log('Gemini Bug 33 契约（配对查重在 stat 之后、set 之前）：')

const src = fs.readFileSync(MANAGER, 'utf8')

const checkPairing = (label, callSite, setCall) => {
  // 从配对调用点（不是文件头的 import）取块，到本块的 paired++ 为止。
  const blockStart = src.indexOf(callSite)
  const block = src.slice(blockStart, src.indexOf('paired++', blockStart))
  const statIdx = block.indexOf('await stat(')
  const dedupIdx = block.indexOf('for (const it of itemsRef.current.values())')
  const setIdx = block.indexOf(setCall)
  check(statIdx >= 0 && dedupIdx >= 0 && setIdx >= 0, `${label}：stat / 查重 / set 三处都在`)
  check(
    statIdx < dedupIdx,
    `${label}：查重在 await stat() 之后（不在 await 之前）`,
  )
  check(
    dedupIdx < setIdx,
    `${label}：查重在 set 之前`,
  )
  // 查重与 set 之间无 await：同一同步块内，JS 单线程下查重 + 写入原子。
  const between = block.slice(dedupIdx, setIdx)
  check(
    !between.includes('await '),
    `${label}：查重与 set 之间无 await（原子）`,
  )
}

checkPairing('歌词配对', 'const lrcPath = await findLocalLyricFile', 'itemsRef.current.set(lrcId, lrcItem)')
checkPairing('封面配对', 'const coverPath = await findLocalCoverFile', 'itemsRef.current.set(coverId, coverItem)')

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
