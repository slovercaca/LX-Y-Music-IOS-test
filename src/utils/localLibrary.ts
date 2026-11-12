import settingState from '@/store/setting/state'
import { getDefaultDownloadPath } from '@/utils/downloadPath'
import { existsFile, mkdir, readDir, unlink, downloadFile, writeFile } from '@/utils/fs'
import { filterFileName } from '@/utils'

/**
 * 本地音乐库统一目录结构（2026-10-22）。
 *
 * 下载根目录（设置 download.path，未设置时用默认目录）下固定三类子目录：
 * - music/   音频文件
 * - lrc/     歌词文件（与音频同名，扩展名 .lrc）
 * - picture/ 封面文件（与音频同名，图片扩展名）
 *
 * 历史上普通下载把音频/歌词平铺在根目录、封面只内嵌不落盘，各处查找逻辑
 * 也各写一份。现在所有落盘与查找都走这里，禁止再手写拼接路径。
 * WebDAV 下载目录是另一套根（webdav.downloadPath），结构相同但不归这里管。
 */

export const PIC_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'heic', 'heif', 'avif']
export const AUDIO_EXTS = ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'ape']

export const getLibraryRoot = (): string => {
  const path = (settingState.setting['download.path'] ?? '').trim() || getDefaultDownloadPath()
  return path.endsWith('/') ? path.slice(0, -1) : path
}

export const getMusicDir = (): string => `${getLibraryRoot()}/music`
export const getLrcDir = (): string => `${getLibraryRoot()}/lrc`
export const getPictureDir = (): string => `${getLibraryRoot()}/picture`

export const ensureLibraryDirs = async(): Promise<void> => {
  await mkdir(getLibraryRoot()).catch(() => {})
  await mkdir(getMusicDir()).catch(() => {})
  await mkdir(getLrcDir()).catch(() => {})
  await mkdir(getPictureDir()).catch(() => {})
}

/**
 * 歌词/封面缓存策略（2026-11-12，设置：基础设置 → 歌词封面缓存）。
 *
 * - 总开关 `player.mediaCacheEnabled`（默认开）：关 = 不进行歌词和封面的
 *   任何缓存——播放/浏览时在线获取的歌词封面只在内存里显示一次、用完即弃，
 *   不落盘（= 显示一次后自动删除）；已缓存的文件不受影响，不会被追删。
 * - `player.mediaCacheLyric`（默认开）：缓存歌词至本地（lrc/）。
 * - `player.mediaCachePic`（默认开）：缓存封面至本地（picture/）。
 *   取代旧键 `player.autoCacheOnlinePic`（见 config/setting.ts 的迁移）。
 *
 * 「缓存」只指播放/浏览时的自动落盘。下载动作产生的文件（按下载设置写入的
 * .lrc、内嵌封面用的 picture/ 中间文件）是用户明确要的下载产物，不受这三个
 * 开关控制。WebDAV 封面缓存（getCacheDir()/covers）是另一套显示缓存，也不在
 * 此策略内。
 *
 * 全部用 `!== false` 判定：老版本设置文件 / WebDAV 同步来的旧设置里缺这几个
 * 键时默认开，保持现行行为，不因缺键静默关掉缓存。
 */
export const isMediaCacheEnabled = (): boolean => settingState.setting['player.mediaCacheEnabled'] !== false
export const isLyricCacheEnabled = (): boolean => isMediaCacheEnabled() && settingState.setting['player.mediaCacheLyric'] !== false
export const isPicCacheEnabled = (): boolean => isMediaCacheEnabled() && settingState.setting['player.mediaCachePic'] !== false

/** 按 UTF-8 字节数截断字符串（不切坏多字节字符） */
export const truncateToUtf8Bytes = (str: string, maxBytes: number): string => {
  let bytes = 0
  let out = ''
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 0
    const b = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    if (bytes + b > maxBytes) break
    bytes += b
    out += ch
  }
  return out
}

/** 文件名（可带扩展名）→ 不带扩展名的基名 */
export const baseNameOf = (fileName: string): string => fileName.replace(/\.[^/.]+$/, '')

/**
 * 按下载文件名模板生成封面/歌词基名，与下载任务的 fileName 保持一致，
 * 保证「在线时缓存的封面」与「下载后的音频」同名对应。
 */
export const coverBaseForSong = (name: string, singer: string): string => {
  const template = settingState.setting['download.fileName'] || '歌名 - 歌手'
  // 低：与下载文件名同一口径——函数式全量替换（防 $ 展开）+ 字节截断，
  // 否则长标题/含 $ 的歌名下封面基名与音频基名对不上
  const raw = template.replace(/歌名/g, () => name || '').replace(/歌手/g, () => singer || '')
  return truncateToUtf8Bytes(filterFileName(raw).trim(), 180)
}

/** 在 picture/ 里按基名找封面文件，找到返回完整路径 */
export const findPictureInDir = async(dir: string, baseName: string): Promise<string | null> => {
  for (const ext of PIC_EXTS) {
    const p = `${dir}/${baseName}.${ext}`
    if (await existsFile(p).catch(() => false)) return p
  }
  return null
}

/** 在本地库 picture/ 里按基名找封面 */
export const findLibraryPicture = async(baseName: string): Promise<string | null> => {
  if (!baseName) return null
  return findPictureInDir(getPictureDir(), baseName)
}

/**
 * 按音频路径找同名封面（本地文件结构兼容）：
 * 1. 音频同目录同名图片
 * 2. 音频目录的 picture/ 子目录
 * 3. 父目录的 picture/（音频在 music/ 时即根目录 picture/）
 */
export const findPictureForAudio = async(audioPath: string): Promise<string | null> => {
  if (!audioPath) return null
  const base = baseNameOf(audioPath.split('/').pop() || '')
  if (!base) return null
  const audioDir = audioPath.substring(0, audioPath.lastIndexOf('/'))
  const parentDir = audioDir.substring(0, audioDir.lastIndexOf('/'))
  for (const dir of [audioDir, `${audioDir}/picture`, `${parentDir}/picture`]) {
    const found = await findPictureInDir(dir, base)
    if (found) return found
  }
  return null
}

/**
 * 按音频路径找同名 .lrc（本地文件结构兼容）：
 * 1. 音频同目录
 * 2. 音频目录的 lrc/ 子目录
 * 3. 父目录的 lrc/（音频在 music/ 时即根目录 lrc/）
 */
export const findLyricForAudio = async(audioPath: string): Promise<string | null> => {
  if (!audioPath) return null
  const base = baseNameOf(audioPath.split('/').pop() || '')
  if (!base) return null
  const audioDir = audioPath.substring(0, audioPath.lastIndexOf('/'))
  const parentDir = audioDir.substring(0, audioDir.lastIndexOf('/'))
  for (const p of [`${audioDir}/${base}.lrc`, `${audioDir}/lrc/${base}.lrc`, `${parentDir}/lrc/${base}.lrc`]) {
    if (await existsFile(p).catch(() => false)) return p
  }
  return null
}

const coverInflight = new Map<string, Promise<string | null>>()

/**
 * 把在线封面 URL 下载缓存到本地库 picture/（同名已存在则直接复用）。
 * 返回 file:// 路径；失败返回 null（不抛错，封面缓存是尽力而为）。
 * 同一基名并发去重，避免列表滚动时重复下载。
 */
export const cacheCoverToLibrary = async(baseName: string, url: string): Promise<string | null> => {
  if (!baseName || !url || !url.startsWith('http')) return null
  // 缓存策略总门：所有调用方（在线封面自动缓存、下载完成补缓存、歌单页直接
  // 下载）统一在这里受总开关 + 封面开关约束，调用方无需各自再判
  if (!isPicCacheEnabled()) return null
  const existing = await findLibraryPicture(baseName)
  if (existing) return `file://${existing}`

  const inflight = coverInflight.get(baseName)
  if (inflight) return inflight

  const task = (async(): Promise<string | null> => {
    const extRaw = url.split('.').pop()?.split('?')[0]?.toLowerCase() || 'jpg'
    const ext = PIC_EXTS.includes(extRaw) ? extRaw : 'jpg'
    const target = `${getPictureDir()}/${baseName}.${ext}`
    try {
      await mkdir(getPictureDir()).catch(() => {})
      const { promise } = downloadFile(url, target)
      const result: any = await promise
      const status = result?.statusCode ?? 200
      // 状态码异常或空文件都视为失败并清掉，避免半截文件被当成有效缓存（毒缓存）
      if (status < 200 || status >= 300 || !(result?.bytesWritten > 0)) {
        await unlink(target).catch(() => {})
        return null
      }
      if (!(await existsFile(target).catch(() => false))) return null
      return `file://${target}`
    } catch {
      await unlink(target).catch(() => {})
      return null
    } finally {
      coverInflight.delete(baseName)
    }
  })()
  coverInflight.set(baseName, task)
  return task
}

/** 列出某目录下的文件名（仅文件），失败返回空数组 */
export const listFileNames = async(dir: string): Promise<string[]> => {
  const entries = await readDir(dir).catch(() => [])
  return entries.filter(e => e.isFile).map(e => e.name)
}

const lyricInflight = new Map<string, Promise<string | null>>()

/**
 * 把在线获取的歌词缓存到本地库 lrc/（与 cacheCoverToLibrary 对称，2026-11-12）。
 * 同名 .lrc 已存在则直接复用、不覆盖（用户自己的歌词文件优先）。
 * 返回 file:// 路径；失败返回 null（不抛错，歌词缓存是尽力而为）。
 * 同一基名并发去重，避免播放与预取同时写同一文件。
 */
export const cacheLyricToLibrary = async(baseName: string, lyricText: string): Promise<string | null> => {
  if (!baseName || !lyricText || !lyricText.trim()) return null
  if (!isLyricCacheEnabled()) return null
  const target = `${getLrcDir()}/${baseName}.lrc`
  if (await existsFile(target).catch(() => false)) return `file://${target}`

  const inflight = lyricInflight.get(baseName)
  if (inflight) return inflight

  const task = (async(): Promise<string | null> => {
    try {
      await mkdir(getLrcDir()).catch(() => {})
      // 二次确认：等待 mkdir 期间可能有另一路（下载完成写 lrc）先落了盘，
      // 此时以先落盘的文件为准，不覆盖
      if (await existsFile(target).catch(() => false)) return `file://${target}`
      await writeFile(target, lyricText)
      if (!(await existsFile(target).catch(() => false))) return null
      return `file://${target}`
    } catch {
      await unlink(target).catch(() => {})
      return null
    } finally {
      lyricInflight.delete(baseName)
    }
  })()
  lyricInflight.set(baseName, task)
  return task
}

export interface LibraryMediaIndex {
  /** lrc/ 及其各级子目录下所有 .lrc 的去扩展名基名（小写） */
  lrcBases: Set<string>
  /** picture/ 及其各级子目录下所有图片的去扩展名基名（小写） */
  picBases: Set<string>
  /** 全部 .lrc 文件的完整路径（供清理孤立文件用） */
  lrcFiles: string[]
  /** 全部图片文件的完整路径（供清理孤立文件用） */
  picFiles: string[]
  /** 全部音频文件的去扩展名基名（小写，供清理孤立文件判定「有对应歌曲」用） */
  audioBases: Set<string>
}

const PIC_EXT_SET = new Set(PIC_EXTS)
const AUDIO_EXT_SET = new Set(AUDIO_EXTS)
const getMediaExt = (name: string): string => {
  const ext = name.split('.').pop()
  return ext && ext !== name ? ext.toLowerCase() : ''
}

/**
 * 递归扫描本地库根目录下的歌词与封面文件（2026-11-12）。
 *
 * 本地列表「有歌词/有封面」指示的唯一依据：扫到了就是有，没扫到就是没有。
 * 必须递归——此前只读 lrc/、picture/ 顶层 + music/、根目录、旧「本地」夹
 * 的顶层散落文件，漏掉了播放查找三级口径覆盖的位置（音频目录的 lrc/、
 * picture/ 子目录、父目录兄弟目录、用户自建子目录），造成「本地明明缓存到
 * 了、列表却显示没有」。递归口径与 findLyricForAudio/findPictureForAudio
 * 的查找范围一致，指示与实际播放行为不再脱节。
 *
 * 深度上限 5（根 → music/lrc/picture/本地 → 其子目录 → 再深两层），
 * visited 集合防目录环；单目录读失败只跳过该目录，不让整个扫描失败。
 */
export const scanLibraryMediaFiles = async(maxDepth = 5): Promise<LibraryMediaIndex> => {
  const index: LibraryMediaIndex = { lrcBases: new Set(), picBases: new Set(), lrcFiles: [], picFiles: [], audioBases: new Set() }
  const visited = new Set<string>()
  const stack: Array<{ dir: string, depth: number }> = [{ dir: getLibraryRoot(), depth: 0 }]
  while (stack.length) {
    const { dir, depth } = stack.pop()!
    if (visited.has(dir)) continue
    visited.add(dir)
    const entries = await readDir(dir).catch(() => [])
    for (const entry of entries) {
      if (entry.isFile) {
        const ext = getMediaExt(entry.name)
        if (ext === 'lrc') {
          index.lrcBases.add(baseNameOf(entry.name).toLowerCase())
          index.lrcFiles.push(entry.path)
        } else if (PIC_EXT_SET.has(ext)) {
          index.picBases.add(baseNameOf(entry.name).toLowerCase())
          index.picFiles.push(entry.path)
        } else if (AUDIO_EXT_SET.has(ext)) {
          // 音频基名也一并收集：清理孤立文件时以此判定「有对应歌曲」——
          // 音频可能在子目录里（列表只展示顶层音频），只按列表里的歌判定会
          // 把子目录歌曲的歌词/封面误判为孤立文件删掉
          index.audioBases.add(baseNameOf(entry.name).toLowerCase())
        }
      } else if (entry.isDirectory && depth < maxDepth) {
        stack.push({ dir: entry.path, depth: depth + 1 })
      }
    }
  }
  return index
}
