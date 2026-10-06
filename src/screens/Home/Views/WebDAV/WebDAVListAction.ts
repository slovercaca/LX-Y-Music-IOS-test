import { findMusic } from '@/utils/musicSdk'
import {
  getWebDAVConfig,
  updateWebDAVMusicMeta,
  getWebDAVDownloadUrl,
  saveWebDAVConfig,
  getWebDAVRemoteUrl,
  getWebDAVAuthHeaders,
  downloadToFileAtomic,
} from '@/core/webdavMusic/drive'
import { existsFile, mkdir, getWebDAVPrivateDirectory } from '@/utils/fs'
import { toast, requestStoragePermission } from '@/utils/tools'
import settingState from '@/store/setting/state'
import { updateListMusics, addListMusics } from '@/core/list'
import { webDAVLog } from '@/core/webdavMusic/logger'
import { readPic, readMetadata } from '@/utils/localMediaMetadata'
import { handleGetOnlinePicUrl } from '@/core/music'
import { LIST_IDS } from '@/config/constant'

/**
 * WebDAV 列表动作（重写版）。
 *
 * 职责：歌曲的"下载到本地 / 下载并导入下载列表 / 在线封面 / 移除"。
 * 认证头统一走 getWebDAVAuthHeaders()（不再本地重复拼 Basic），
 * 单曲/批量下载统一走 downloadToFileAtomic（statusCode 校验 + 原子落盘，
 * 旧版单曲下载是直写目标文件、无原子保护）。
 */

const parsePathForName = (filePath: string) => ({
  ext: filePath.split('.').pop()?.toLowerCase() || '',
  nameWithoutExt: filePath.substring(0, filePath.lastIndexOf('.')),
  fileName: filePath.split('/').pop() || '',
})

const chunk = <T>(arr: T[], size: number): T[][] => {
  const result: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size))
  }
  return result
}

/** 下载目录：用户在「WebDAV 下载路径」选的目录，未选则用应用私有目录 */
const getDefaultDownloadDir = (): string => {
  const settings = settingState.setting
  // 键名必须是 'webdav.downloadPath'（默认设置 / 「WebDAV 下载路径」选择器 /
  // core/music/local.ts 用的都是它）
  const webdavPath = settings['webdav.downloadPath']
  if (webdavPath && typeof webdavPath === 'string' && webdavPath.trim()) {
    return webdavPath.trim()
  }
  return getWebDAVPrivateDirectory()
}

/** 下载后读标签，回写名称/歌手/专辑（只补空缺，不覆盖已有） */
const applyMetadataAfterDownload = async(
  musicInfo: LX.WebDAV.MusicInfo,
  filePath: string,
): Promise<void> => {
  const fileMetadata = await readMetadata(filePath).catch(() => null)
  const updates: Record<string, any> = { filePath }
  if (fileMetadata) {
    if (fileMetadata.albumName) updates.albumName = fileMetadata.albumName
    if (fileMetadata.name && !musicInfo.name) updates.name = fileMetadata.name
    if (fileMetadata.singer && !musicInfo.singer) updates.singer = fileMetadata.singer
  }
  await updateWebDAVMusicMeta(musicInfo.id, updates)

  const picPath = await readPic(filePath).catch(() => null)
  if (picPath) {
    const newPicUrl = picPath.startsWith('/') ? `file://${picPath}` : picPath
    await updateWebDAVMusicMeta(musicInfo.id, { picUrl: newPicUrl })
  }
}

/**
 * 下载单首歌曲（含同名歌词）到 <下载目录>/music/（歌词进 lrc/）。
 * 已存在则跳过；返回内嵌封面 URL（没有则 undefined）。
 */
export const handleWebDAVDownload = async(
  musicInfo: LX.WebDAV.MusicInfo,
): Promise<string | undefined> => {
  const downloadDir = getDefaultDownloadDir()
  const fileName = musicInfo.meta.fileName

  if (!fileName) {
    toast('无法获取文件名')
    return undefined
  }

  // 歌曲下载到 music/ 子文件夹，歌词下载到 lrc/ 子文件夹
  const musicDir = `${downloadDir}/music`
  const lrcDir = `${downloadDir}/lrc`
  const filePath = `${musicDir}/${fileName}`
  const exists = await existsFile(filePath).catch(() => false)

  if (!exists) {
    try {
      // P2（2026-10-06）：删除死变量 headers（downloadToFileAtomic 内部自取）
      const downloadUrl = getWebDAVDownloadUrl(musicInfo)
      await mkdir(musicDir)
      // 原子下载：校验 statusCode，防毒缓存（错误页面写入目标文件）
      await downloadToFileAtomic({
        url: downloadUrl,
        targetPath: filePath,
        statusError: (statusCode) => `下载失败（${statusCode}）`,
        moveError: '下载失败（文件落盘失败）',
      })

      // 同时下载歌词（如果服务器上有同名 .lrc）
      if (musicInfo.meta.lrcPath) {
        try {
          await mkdir(lrcDir)
          const lrcFileName = fileName.replace(/\.[^/.]+$/, '.lrc')
          const lrcFilePath = `${lrcDir}/${lrcFileName}`
          const lrcExists = await existsFile(lrcFilePath).catch(() => false)
          if (!lrcExists) {
            const lrcUrl = getWebDAVRemoteUrl(musicInfo.meta.lrcPath)
            await downloadToFileAtomic({
              url: lrcUrl,
              targetPath: lrcFilePath,
              statusError: (statusCode) => `歌词下载失败（${statusCode}）`,
              moveError: '歌词下载失败（文件落盘失败）',
            })
          }
        } catch {
          // 歌词下载失败不影响歌曲
        }
      }

      await applyMetadataAfterDownload(musicInfo, filePath)
    } catch (error: any) {
      webDAVLog.error('handleWebDAVDownload: download failed', { fileName, error: error.message })
      toast(`下载失败：${error.message}`, 'long')
      return undefined
    }
  }

  try {
    const picPath = await readPic(filePath).catch(() => null)
    if (picPath) {
      const newPicUrl = picPath.startsWith('/') ? `file://${picPath}` : picPath
      await updateWebDAVMusicMeta(musicInfo.id, { picUrl: newPicUrl })
      return newPicUrl
    }
  } catch {
    // ignore
  }

  return undefined
}

/**
 * 批量下载：逐个下载，跳过已存在；本地记录被删则清掉旧 filePath。
 * 返回成功下载（含已存在）的本地路径列表。
 */
export const handleWebDAVBatchDownload = async(
  songs: LX.WebDAV.MusicInfo[],
  onProgress?: (current: number, total: number, currentSong: string) => void,
): Promise<string[]> => {
  const hasPermission = await requestStoragePermission()
  if (!hasPermission) {
    toast('请授予存储权限后重试', 'long')
    return []
  }

  const downloadDir = getDefaultDownloadDir()
  const downloadedPaths: string[] = []

  webDAVLog.info('handleWebDAVBatchDownload: starting batch download', { songCount: songs.length })

  try {
    await mkdir(downloadDir)

    let currentIndex = 0
    for (const musicInfo of songs) {
      currentIndex++
      const fileName = musicInfo.meta.fileName
      if (!fileName) continue
      const musicDir = `${downloadDir}/music`
      // P1-19：不同远端目录的同名文件，用父目录名区分本地文件名，避免互相覆盖。
      // 如 /music/周杰伦/告白气球.flac → 周杰伦_告白气球.flac
      let localFileName = fileName
      const remotePath = musicInfo.meta.remotePath
      if (remotePath) {
        const segments = remotePath.split('/').filter(Boolean)
        // 倒数第二段是父目录名（最后一段是文件名本身）
        if (segments.length >= 2) {
          const parentDir = segments[segments.length - 2].replace(/[/\\:*?"<>|]/g, '_')
          if (parentDir && parentDir.toLowerCase() !== 'music') {
            localFileName = `${parentDir}_${fileName}`
          }
        }
      }
      const filePath = `${musicDir}/${localFileName}`

      onProgress?.(currentIndex, songs.length, fileName)

      // P1-19 兼容：老版本下载的文件用旧命名（无父目录前缀），
      // 先检查旧路径，避免升级后重复下载。
      const legacyFilePath = `${musicDir}/${fileName}`
      const fileExists = await existsFile(filePath).catch(() => false)
      const legacyExists = localFileName !== fileName
        ? await existsFile(legacyFilePath).catch(() => false)
        : false
      const effectiveFilePath = fileExists ? filePath : (legacyExists ? legacyFilePath : filePath)

      if (musicInfo.meta.filePath && !fileExists && !legacyExists) {
        webDAVLog.info('handleWebDAVBatchDownload: file was deleted, clearing old filePath', { oldPath: musicInfo.meta.filePath })
        // 传 null 显式清空（传 undefined 会被 update 判断跳过，永远清不掉）
        await updateWebDAVMusicMeta(musicInfo.id, { filePath: null })
      }

      if (fileExists || legacyExists) {
        webDAVLog.info('handleWebDAVBatchDownload: file already exists, skipping', { filePath: effectiveFilePath })
        downloadedPaths.push(effectiveFilePath)
        await updateWebDAVMusicMeta(musicInfo.id, { filePath: effectiveFilePath })
        continue
      }

      await mkdir(musicDir).catch(() => {})

      try {
        const downloadUrl = getWebDAVDownloadUrl(musicInfo)
        webDAVLog.info('handleWebDAVBatchDownload: downloading', { currentIndex, fileName })

        await downloadToFileAtomic({
          url: downloadUrl,
          targetPath: filePath,
          statusError: (statusCode) => `下载失败（${statusCode}）`,
          moveError: '下载失败（文件落盘失败）',
        })

        await applyMetadataAfterDownload(musicInfo, filePath)

        // 歌词下载到 lrc/ 子目录（文件名与本地音频对应，同样加父目录前缀防重名）
        if (musicInfo.meta.lrcPath) {
          try {
            const lrcDir = `${downloadDir}/lrc`
            await mkdir(lrcDir).catch(() => {})
            const lrcFileName = localFileName.replace(/\.[^/.]+$/, '.lrc')
            const lrcFilePath = `${lrcDir}/${lrcFileName}`
            if (!await existsFile(lrcFilePath).catch(() => false)) {
              const lrcUrl = getWebDAVRemoteUrl(musicInfo.meta.lrcPath)
              // 原子下载：失败不污染目标路径，下次仍会重试
              await downloadToFileAtomic({
                url: lrcUrl,
                targetPath: lrcFilePath,
                statusError: (statusCode) => `歌词下载失败（${statusCode}）`,
                moveError: '歌词下载失败（文件落盘失败）',
              })
            }
          } catch {
            // 歌词下载失败不影响歌曲
          }
        }

        downloadedPaths.push(filePath)
        webDAVLog.info('handleWebDAVBatchDownload: download completed', { currentIndex, fileName, filePath })
      } catch (error: any) {
        webDAVLog.error('handleWebDAVBatchDownload: download failed', { fileName, error: error.message })
      }
    }

    webDAVLog.info('handleWebDAVBatchDownload: batch download completed', { downloadedCount: downloadedPaths.length })
    return downloadedPaths
  } catch (error: any) {
    webDAVLog.error('handleWebDAVBatchDownload: batch download failed', { error: error.message })
    throw error
  }
}

const buildLocalMusicInfo = (
  filePath: string,
  metadata: Awaited<ReturnType<typeof readMetadata>>,
  picPath: string | null,
): LX.Music.MusicInfoLocal => {
  const { nameWithoutExt, fileName } = parsePathForName(filePath)
  return {
    id: `local_${filePath}`,
    name: metadata?.name || nameWithoutExt,
    singer: metadata?.singer || '',
    albumName: metadata?.albumName || '',
    interval: metadata?.interval ? `${metadata.interval}s` : '',
    source: 'local' as const,
    meta: {
      picUrl: picPath ? (picPath.startsWith('/') ? `file://${picPath}` : picPath) : '',
      filePath,
      fileName,
    },
  } as unknown as LX.Music.MusicInfoLocal
}

const buildLocalMusicInfoByFilePath = (filePath: string): LX.Music.MusicInfoLocal => {
  const { nameWithoutExt, fileName } = parsePathForName(filePath)
  return {
    id: `local_${filePath}`,
    name: nameWithoutExt,
    singer: '',
    albumName: '',
    interval: '',
    source: 'local' as const,
    meta: {
      picUrl: '',
      fileName,
      // filePath 必须带上：下载列表先添加后补全标签的两段式流程中，
      // 中途任何播放/判断逻辑都依赖 meta.filePath 定位本地文件。
      filePath,
    },
  } as unknown as LX.Music.MusicInfoLocal
}

/**
 * 扫描并下载：先批量下载全部歌曲，再导入下载列表并逐批读取标签补全。
 * （两段式：先按文件名占位添加，再读标签 update，避免 UI 长时间卡死）
 */
export const handleWebDAVDownloadAndImport = async(
  songs: LX.WebDAV.MusicInfo[],
  setLoadingText: (text: string) => void,
): Promise<void> => {
  if (songs.length === 0) {
    toast('没有可下载的歌曲')
    return
  }

  setLoadingText(`正在下载 0/${songs.length}...`)
  webDAVLog.info('handleWebDAVDownloadAndImport: starting process', { songCount: songs.length })

  try {
    const downloadedPaths = await handleWebDAVBatchDownload(songs, (current, total, fileName) => {
      setLoadingText(`正在下载 ${current}/${total}...\n${fileName}`)
    })

    if (downloadedPaths.length === 0) {
      toast('没有成功下载任何歌曲')
      return
    }

    webDAVLog.info('handleWebDAVDownloadAndImport: download completed', { downloadedCount: downloadedPaths.length })

    const files = downloadedPaths.map(path => {
      const name = path.split('/').pop() || ''
      return { path, name } as any
    })

    setLoadingText('正在添加到列表...')
    await addListMusics(
      LIST_IDS.DOWNLOAD,
      files.map(buildLocalMusicInfoByFilePath),
      settingState.setting['list.addMusicLocationType'],
    )

    toast(global.i18n.t('list_select_local_file_temp_add_tip', { total: files.length }), 'long')

    setLoadingText('正在读取音乐标签...')

    const createLocalMusicInfos = async(
      filePaths: string[],
      errorPath: string[],
    ): Promise<LX.Music.MusicInfoLocal[]> => {
      const list: LX.Music.MusicInfoLocal[] = []
      for (const batch of chunk(filePaths, 5)) {
        const results = await Promise.all(
          batch.map(async(path) => {
            const info = await readMetadata(path)
            const picPath = await readPic(path).catch(() => null)
            return { path, info, picPath }
          }),
        )
        for (const { path, info, picPath } of results) {
          if (!info) {
            errorPath.push(path)
            continue
          }
          list.push(buildLocalMusicInfo(path, info, picPath))
        }
      }
      return list
    }

    const createThrottleAddMusics = (
      add: (listId: string, musicInfos: LX.Music.MusicInfoLocal[]) => Promise<void>,
      remove: (listId: string, errorPath: string[]) => Promise<void>,
      listId: string,
    ) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let _musicInfos: LX.Music.MusicInfoLocal[] = []
      let _errorPath: string[] = []
      return (musicInfos: LX.Music.MusicInfoLocal[], errorPath?: string[]) => {
        if (musicInfos.length) _musicInfos.push(...musicInfos)
        if (errorPath) _errorPath.push(...errorPath)
        if (timer) return
        timer = setTimeout(async() => {
          timer = null
          const musicInfos = _musicInfos
          const errorPath = _errorPath
          _musicInfos = []
          _errorPath = []
          if (musicInfos.length) await add(listId, musicInfos)
          if (errorPath.length) await remove(listId, errorPath)
        }, 100)
      }
    }

    const handleUpdateMusics = async(
      filePaths: string[],
      throttleUpdateMusics: (musicInfos: LX.Music.MusicInfoLocal[], errorPath?: string[]) => void,
      index: number = -1,
      total: number = 0,
      errorPath: string[] = [],
    ) => {
      if (!total) total = filePaths.length
      const paths = filePaths.slice(index + 1, index + 11)
      const musicInfos = await createLocalMusicInfos(paths, errorPath)
      if (musicInfos.length) {
        throttleUpdateMusics(musicInfos)
        await updateListMusics(musicInfos.map((info) => ({ id: LIST_IDS.DOWNLOAD, musicInfo: info })))
      }
      setLoadingText(`正在读取标签 ${Math.min(index + 11, total)}/${total}...`)
      index += 10
      if (filePaths.length - 1 > index) {
        await handleUpdateMusics(filePaths, throttleUpdateMusics, index, total, errorPath)
      } else {
        if (errorPath.length) {
          toast(
            global.i18n.t('list_select_local_file_result_failed_tip', {
              total,
              success: total - errorPath.length,
              failed: errorPath.length,
            }),
            'long',
          )
        } else {
          toast(global.i18n.t('list_select_local_file_result_tip', { total }), 'long')
        }
        throttleUpdateMusics([], errorPath)
        setLoadingText('')
      }
    }

    const throttleUpdateMusics = createThrottleAddMusics(
      async(listId, musicInfos) => {
        return updateListMusics(musicInfos.map((info) => ({ id: listId, musicInfo: info })))
      },
      async(_listId, _errorPath) => {
        return Promise.resolve()
      },
      LIST_IDS.DOWNLOAD,
    )

    await handleUpdateMusics(downloadedPaths, throttleUpdateMusics)

    webDAVLog.info('handleWebDAVDownloadAndImport: all processes completed')
  } catch (error: any) {
    webDAVLog.error('handleWebDAVDownloadAndImport: process failed', { error: error.message })
    toast(`导入失败：${error.message}`, 'long')
    setLoadingText('')
  }
}

/** 从在线音乐源获取封面（按歌名/歌手匹配） */
export const handleFetchWebDAVPicFromOnline = async(
  musicInfo: LX.WebDAV.MusicInfo,
): Promise<string | undefined> => {
  try {
    const searchResult = await findMusic({
      name: musicInfo.name || '',
      singer: musicInfo.singer || '',
      albumName: musicInfo.meta.albumName || '',
      interval: musicInfo.interval || '',
      source: 'kw',
    })

    if (searchResult.length === 0) {
      toast('未找到匹配的在线歌曲')
      return undefined
    }

    const matched = searchResult[0] as LX.Music.MusicInfoOnline
    const result = await handleGetOnlinePicUrl({
      musicInfo: matched,
      isRefresh: true,
      onToggleSource: () => {},
      allowToggleSource: false,
    })

    if (result.url) {
      await updateWebDAVMusicMeta(musicInfo.id, { picUrl: result.url })
      return result.url
    }
  } catch (error: any) {
    webDAVLog.error('handleFetchWebDAVPicFromOnline: failed', { error: error.message })
    toast(`获取封面失败：${error.message}`, 'long')
  }

  return undefined
}

/** 从 WebDAV 列表中移除歌曲（只删本地记录，不删服务器文件） */
export const handleWebDAVRemove = async(
  musicInfo: LX.WebDAV.MusicInfo,
): Promise<boolean> => {
  try {
    const config = await getWebDAVConfig()
    const songs = (config.songs || []).filter(s => s.id !== musicInfo.id)
    await saveWebDAVConfig({ ...config, songs })
    toast('已移除')
    return true
  } catch (error: any) {
    webDAVLog.error('handleWebDAVRemove: failed', { error: error.message })
    toast(`移除失败：${error.message}`, 'long')
    return false
  }
}
