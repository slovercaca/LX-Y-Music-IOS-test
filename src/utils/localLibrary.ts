import settingState from '@/store/setting/state'
import { getDefaultDownloadPath } from '@/utils/downloadPath'
import { existsFile, mkdir, readDir, unlink, downloadFile } from '@/utils/fs'
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
