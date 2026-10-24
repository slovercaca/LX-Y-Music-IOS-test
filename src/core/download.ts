import RNFetchBlob from '@/utils/rnFetchBlob'
import { toMD5, toast, requestStoragePermission } from '@/utils/tools'
import { getMusicUrl, getMusicUrlWithQuality, getLyricInfo } from '@/core/music'
import { getFileExtension, getFileExtensionFromUrl } from '@/screens/Home/Views/Mylist/MusicList/download/utils'
import { mergeLyrics } from '@/screens/Home/Views/Mylist/MusicList/download/lrcTool'
import { writeFile, unlink, downloadFile, moveFile, stopDownload } from '@/utils/fs'
import { getMusicDir, getLrcDir, getPictureDir, ensureLibraryDirs, findLibraryPicture, cacheCoverToLibrary, truncateToUtf8Bytes } from '@/utils/localLibrary'
import { writeMetadata, writePic, writeLyric, isWriteSupported } from '@/utils/localMediaMetadata'
import settingState from '@/store/setting/state'
import downloadState from '@/store/download/state'
import downloadActions from '@/store/download/action'
import { filterFileName, sizeFormate } from '@/utils'
import { getPicUrl } from '@/core/music/online'
import RNFS from 'react-native-fs'
import DownloadTask = LX.Download.DownloadTask

/** 下载失败的原始报错 → 用户能看懂的话（D6 人性化）：原文只进日志，不直接展示 */
export const friendlyDownloadError = (err: any): string => {
  const msg = String(err?.message ?? err ?? '')
  if (/no space|ENOSPC|空间不足/i.test(msg)) return '存储空间不足，请清理空间后重试'
  if (/network|fetch|socket|timeout|timed out|网络/i.test(msg)) return '网络异常，请检查网络后重试'
  if (/404|not found/i.test(msg)) return '歌曲链接失效（可能已下架），可换个音源重试'
  if (/403|forbidden|permission/i.test(msg)) return '下载被拒绝（403），可稍后或换音源重试'
  return '下载失败，请稍后重试'
}

// 用户主动暂停的任务 id：stopDownload 会让下载 Promise 以错误结束，
// processQueue 的 catch 靠这个集合区分「暂停」与「真失败」（D1 真暂停）
const pausedTaskIds = new Set<string>()
// 用户删除（取消）下载中任务的 id：与暂停区分——删除后静默收尾，不报失败、不计批量失败（中-18）
const cancelledTaskIds = new Set<string>()
// 批量入队计数（中-21）：多批重叠触发时合并统计，全部入队完才允许排空汇总
let batchAddingCount = 0

// 批量下载汇总（D5）：批量期间逐首完成/失败 toast 静默，队列排空后只弹一条汇总
let batchState: { success: number, fail: number, adding: boolean } | null = null
// 中：批量成员 id 集合——此前计数/提示抑制只看全局 batchState 是否存在，
// 批量进行期间单下的歌被吞提示且计入批量成败、第二批还会把计数清零。
// 改为按任务归属判定：只有批量添加的任务才计入批量。
const batchTaskIds = new Set<string>()
import wySdk from '@/utils/musicSdk/wy'
import bilibiliSdk from '@/utils/musicSdk/bilibili'

const taskQueue: DownloadTask[] = []
let isProcessing = false
const DOWNLOAD_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Mobile Safari/537.36',
}
const WY_MEDIA_HEADERS = {
  'User-Agent': '',
}
const getDownloadHeaders = (task: DownloadTask) => {
  return task.musicInfo.source === 'wy' ? WY_MEDIA_HEADERS : DOWNLOAD_HEADERS
}
let currentDownloadTask: any | null = null

const processQueue = async() => {
  if (isProcessing || taskQueue.length === 0) return
  isProcessing = true

  const task = taskQueue.shift()
  if (!task) {
    isProcessing = false
    return
  }

  try {
    await startDownload(task)
  } catch (error: any) {
    if (cancelledTaskIds.has(task.id)) {
      // 用户删掉了这个下载中任务：静默收尾，不报失败、不计入批量失败（中-18）
      cancelledTaskIds.delete(task.id)
    } else if (pausedTaskIds.has(task.id)) {
      // 用户主动暂停：保留任务与已下载进度，不报失败（D1）
      pausedTaskIds.delete(task.id)
      downloadActions.updateTask(task.id, { status: 'paused' })
    } else {
      console.log('[Download] 下载失败:', task.fileName, error?.message || error)
      downloadActions.updateTask(task.id, { status: 'error', errorMsg: friendlyDownloadError(error) })
      // 中：失败清半截文件——同扩展名时下载直接写最终路径，中途失败的
      // 截断音频会留在 music/ 被本地库当正常歌曲列出、播到一半断裂
      void unlink(task.filePath).catch(() => {})
      void unlink(downloadTempVariantPath(task)).catch(() => {})
      if (batchTaskIds.has(task.id)) {
        if (batchState) batchState.fail++
      } else toast(`${task.fileName} ${friendlyDownloadError(error)}`, 'short')
    }
  } finally {
    // 高：无论何种路径结束，都清掉本任务的暂停/取消残留标记——元数据
    // 阶段点的暂停此前无人消费，标记按确定性 id 残留，同歌重下会静默卡死
    pausedTaskIds.delete(task.id)
    cancelledTaskIds.delete(task.id)
    isProcessing = false
    processQueue()
    // 批量队列排空 → 只弹一条汇总（D5）
    if (batchState && batchAddingCount === 0 && taskQueue.length === 0 && !isProcessing) {
      const { success, fail } = batchState
      batchState = null
      batchTaskIds.clear()
      if (success + fail > 0) toast(`批量下载完成：成功 ${success} 首${fail ? `，失败 ${fail} 首` : ''}`, 'long')
    }
  }
}

// .download 临时变体路径（扩展名不一致/B站下载时实际写入的路径）
const downloadTempVariantPath = (task: DownloadTask): string => {
  const extMatch = /\.([^.]+)$/.exec(task.filePath)
  if (!extMatch || task.filePath.includes('.download.')) return ''
  return task.filePath.replace(/\.([^.]+)$/, '.download.$1')
}

const startDownload = async(task: DownloadTask) => {
  downloadActions.updateTask(task.id, { status: 'downloading' })
  // 不再弹「开始下载」（D4）：入队时已有「已加入队列」提示，串行队列里排后面的
  // 任务几分钟后才真正开始，这条 toast 只会让人困惑；进度看悬浮球/下载管理即可。

  let url: string
  // 实际拿到的音质（可能因歌曲不支持请求档位而降级）：写入任务，供「本地与下载」列表显示
  let actualQuality: LX.Quality | undefined
  let headers: any = getDownloadHeaders(task)
  if (task.isForceCookie && task.musicInfo.source === 'wy') {
    const highQualityLevels: LX.Quality[] = ['flac', 'hires', 'master', 'atmos', 'atmos_plus']
    console.log(`[Batch Download] Forcing cookie for ${task.musicInfo.name}`)
    try {
      const result: any = await (wySdk.cookie.getMusicUrl(task.musicInfo, task.quality) as any).promise
      if (!result.url) throw new Error('Cookie 未能获取到URL')
      if (result.level === 'exhigh' && highQualityLevels.includes(task.quality)) {
        throw new Error(`请求的音质 ${task.quality} 不可用`)
      }
      url = result.url
    } catch (error: any) {
      // 中：取链窗口期点了暂停又恰好取链失败——此前直接删任务，与暂停
      // 语义冲突（通用分支同场景是保留为 paused）
      if (pausedTaskIds.has(task.id)) {
        pausedTaskIds.delete(task.id)
        downloadActions.updateTask(task.id, { status: 'paused' })
        return
      }
      if (batchTaskIds.has(task.id)) {
        if (batchState) batchState.fail++
      } else toast(`${task.musicInfo.name} ${friendlyDownloadError(error)}`, 'short')
      removeTask(task.id)
      return
    }
  } else {
    if (task.musicInfo.source === 'bilibili') {
      console.log('[Download] 处理 bilibili 源')
      try {
        const result: any = await (bilibiliSdk.getMusicUrl(task.musicInfo, task.quality) as any).promise
        url = result.url
        if (result.headers) {
          headers = result.headers
          console.log('[Download] 使用 bilibili 自定义 headers')
        }
      } catch (error: any) {
        if (pausedTaskIds.has(task.id)) {
          pausedTaskIds.delete(task.id)
          downloadActions.updateTask(task.id, { status: 'paused' })
          return
        }
        if (batchTaskIds.has(task.id)) {
          if (batchState) batchState.fail++
        } else toast(`${task.musicInfo.name} ${friendlyDownloadError(error)}`, 'short')
        removeTask(task.id)
        return
      }
    } else {
      if (task.musicInfo.source === 'local') {
        // 本地 / 网盘音频（webdav 也是 source=local）：不存在「请求音质降级」，沿用原链路
        url = await getMusicUrl({ musicInfo: task.musicInfo, quality: task.quality, isRefresh: true })
      } else {
        const resolved = await getMusicUrlWithQuality({
          musicInfo: task.musicInfo as LX.Music.MusicInfoOnline,
          quality: task.quality,
          isRefresh: true,
        })
        url = resolved.url
        actualQuality = resolved.quality
      }
    }
  }

  if (actualQuality && actualQuality !== task.quality) {
    // 记录降级结果（hires → flac 之类），列表按实际音质展示
    downloadActions.updateTask(task.id, { actualQuality })
  }

  const isBilibiliSource = task.musicInfo.source === 'bilibili'
  let finalFilePath = task.filePath

  const urlExtension = getFileExtensionFromUrl(url)
  const taskExt = task.filePath.substring(task.filePath.lastIndexOf('.') + 1).toLowerCase()

  let downloadFilePath = task.filePath
  if (isBilibiliSource && urlExtension) {
    downloadFilePath = `${getMusicDir()}/${task.fileName}.download.${urlExtension}`
    console.log(`[Download] Bilibili 源使用临时路径下载: ${downloadFilePath}`)
  } else if (urlExtension && urlExtension !== taskExt) {
    downloadFilePath = `${getMusicDir()}/${task.fileName}.download.${urlExtension}`
    finalFilePath = `${getMusicDir()}/${task.fileName}.${urlExtension}`
    console.log(`[Download] URL 扩展名(${urlExtension})与任务扩展名(${taskExt})不一致，使用真实扩展名下载: ${downloadFilePath} -> ${finalFilePath}`)
  }

  // 取链期间用户可能已点暂停：此时还没建下载任务，直接收尾（状态已由 pauseTask 置 paused）
  if (pausedTaskIds.has(task.id)) {
    pausedTaskIds.delete(task.id)
    return
  }

  await requestStoragePermission()
  // 磁盘空间提醒（D15）：只提醒不拦截，避免空间不足时最后以原始写入错误收场、无从理解
  try {
    const fsInfo = await RNFS.getFSInfo()
    if (fsInfo.freeSpace < 100 * 1024 * 1024) toast(`存储空间不足（剩余 ${sizeFormate(fsInfo.freeSpace)}），下载可能失败`, 'long')
  } catch {}
  let lastWritten = 0
  let lastTime = Date.now()
  let downloadedFilePath: string
  try {
    // 统一本地库结构：根目录 + music/ + lrc/ + picture/
    await ensureLibraryDirs()

    // 高-3：取链后的几段 await（权限/空间/建目录）期间用户可能已点暂停；
    // 此刻还没建下载对象、stopDownload 无从停起，必须在这里再查一次，
    // 否则下载会照常下完并把状态覆写回 completed，暂停被吞。
    if (pausedTaskIds.has(task.id)) {
      pausedTaskIds.delete(task.id)
      return
    }
    if (cancelledTaskIds.has(task.id)) {
      cancelledTaskIds.delete(task.id)
      return
    }

    const downloadTask = downloadFile(url, downloadFilePath, {
      headers,
      progress: (res) => {
        const now = Date.now()
        const written = res.bytesWritten
        const total = res.contentLength
        const deltaTime = now - lastTime
        if (deltaTime === 0) return

        const deltaBytes = written - lastWritten
        const speed = deltaBytes / (deltaTime / 1000)

        lastWritten = written
        lastTime = now
        const percent = total > 0 ? written / total : 0
        downloadActions.updateTask(task.id, {
          progress: {
            ...task.progress,
            percent,
            downloaded: written,
            total,
            speed: `${sizeFormate(speed)}/s`,
          },
        })
      },
    })

    currentDownloadTask = downloadTask
    const downloadResult: any = await downloadTask.promise
    // 高：此前丢弃下载结果——403/404 错误页或 0 字节文件会被存成音频
    // 并标记 completed，毒文件长期留在 music/ 被当正常歌曲
    if (!downloadResult || downloadResult.statusCode < 200 || downloadResult.statusCode >= 300 || !(downloadResult.bytesWritten > 0)) {
      await unlink(downloadFilePath).catch(() => {})
      throw new Error(`下载失败（HTTP ${downloadResult?.statusCode ?? '未知'}）`)
    }
    // 高-3：文件刚下完、写元数据期间被暂停的场景——stopDownload 对已完成的
    // Promise 无效，此处消费暂停标记，保持 paused，不覆写 completed；
    // 残留标记若不清除，会按任务 id 毒化之后同歌重下（静默 return 卡死）。
    if (pausedTaskIds.has(task.id)) {
      pausedTaskIds.delete(task.id)
      downloadActions.updateTask(task.id, { status: 'paused' })
      return
    }
    if (cancelledTaskIds.has(task.id)) {
      cancelledTaskIds.delete(task.id)
      return
    }
    downloadedFilePath = downloadFilePath
    console.log('下载完成:', downloadedFilePath)

    if (finalFilePath !== downloadedFilePath) {
      try {
        // 低-12：目标已存在同名文件是改名失败主因（moveFile 不覆盖）——先清掉再改。
        // 改名若失败，任务会以 *.download.* 临时名完成，而歌词/封面按正式名存，
        // 这首歌的离线歌词/封面将永远匹配不上。
        await unlink(finalFilePath).catch(() => {})
        await moveFile(downloadedFilePath, finalFilePath)
        downloadedFilePath = finalFilePath
        console.log(`[Download] 重命名为最终路径: ${downloadedFilePath}`)
      } catch (renameError) {
        // 高：此前吞掉改名失败、带着 .download 临时名标记 completed，
        // 歌词/封面按正式名存永远匹配不上。改为进失败分支（文件保留
        // 在临时路径，重试/删除时按变体路径一并清理）
        console.warn('[Download] 重命名失败:', renameError)
        throw new Error('下载文件改名失败，请重试')
      }
    }

    if (!isBilibiliSource) {
      await handleMetadata(task, downloadedFilePath)
    } else {
      console.log('[Download] Bilibili 源跳过元数据处理')
      downloadActions.updateTask(task.id, { metadataStatus: { cover: 'success', lyric: 'success', tags: 'success' } })
    }
    // 元数据阶段用户删/暂停了任务：文件已下完，删除按其意愿清文件，
    // 暂停保留文件与 paused 状态，都不再覆写 completed
    if (cancelledTaskIds.has(task.id)) {
      cancelledTaskIds.delete(task.id)
      await unlink(downloadedFilePath).catch(() => {})
      return
    }
    if (pausedTaskIds.has(task.id)) {
      pausedTaskIds.delete(task.id)
      downloadActions.updateTask(task.id, { status: 'paused', filePath: downloadedFilePath })
      return
    }
    try {
      await RNFetchBlob.fs.scanFile([{ path: downloadedFilePath }])
      console.log(`[Download Manager] Media scan requested for: ${downloadedFilePath}`)
    } catch (scanError) {
      console.error(`[Download Manager] Failed to request media scan for ${downloadedFilePath}:`, scanError)
    }
    downloadActions.updateTask(task.id, { status: 'completed', progress: { ...task.progress, percent: 1 }, filePath: downloadedFilePath })

    // 下载完成后缓存歌词（内存缓存 + 同名 .lrc），保证离线也能显示歌词
    void cacheLyricForOffline(task, downloadedFilePath)
    // 下载完成后把封面缓存到 picture/（已存在则跳过），列表/播放各处优先读本地缓存
    void cacheDownloadedCover(task)

    if (batchTaskIds.has(task.id)) {
      if (batchState) batchState.success++
    } else if (!task.isForceCookie) {
      toast(`${task.fileName} 下载完成!`, 'short')
    }
  } finally {
    currentDownloadTask = null
  }
}

// 下载完成后缓存封面到 picture/<文件名>.<ext>（2026-10-22）：
// 与「下载设置-写入封面」（内嵌进音频）相互独立，保证本地有缓存时各处控件都能直接加载。
const cacheDownloadedCover = async(task: DownloadTask) => {
  try {
    if (await findLibraryPicture(task.fileName)) return
    const picUrl = await getPicUrl({ musicInfo: task.musicInfo as LX.Music.MusicInfoOnline } as any).catch(() => '')
    if (picUrl && picUrl.startsWith('http')) {
      await cacheCoverToLibrary(task.fileName, picUrl)
    }
  } catch (e: any) {
    console.warn('[Download] 封面缓存到 picture/ 失败（不影响歌曲）:', e?.message || e)
  }
}

// 下载完成后缓存歌词：仅当用户明确勾选「下载歌词文件」时才写出同名 .lrc；
// 「写入内嵌歌词」已由 handleMetadata 把歌词嵌入音频文件内部，不再额外生成 .lrc。
const cacheLyricForOffline = async(task: DownloadTask, filePath: string) => {
  try {
    if (!settingState.setting['download.writeLyric']) return
    const lyrics = await getLyricInfo({ musicInfo: task.musicInfo as LX.Music.MusicInfoOnline })
    const merged = mergeLyrics(lyrics.lyric, lyrics.tlyric, lyrics.rlyric)
    if (merged) {
      const lrcPath = `${getLrcDir()}/${task.fileName}.lrc`
      try {
        if (!(await RNFetchBlob.fs.exists(lrcPath))) {
          await writeFile(lrcPath, merged)
        }
      } catch (e: any) {
        console.warn('[Download] 写入离线歌词文件失败:', e?.message || e)
      }
    }
    console.log(`[Download] 离线歌词已缓存: ${task.fileName}`)
  } catch (e: any) {
    console.warn('[Download] 离线歌词缓存失败（不影响歌曲）:', e?.message || e)
  }
}

const handleMetadata = async(task: DownloadTask, filePath: string) => {
  // 按原生写入能力判断（iOS 的 LocalMediaMetadata 内联模块同样支持标签/封面/内嵌歌词写入），
  // 不再按平台一刀切跳过；能力不可用时整段跳过，避免误报与假成功
  // （与 MusicList/listAction.ts 的下载写入守卫保持一致）。
  if (!isWriteSupported()) return
  console.log('开始处理元数据:', filePath)

  const fileExt = filePath.substring(filePath.lastIndexOf('.') + 1).toLowerCase()
  console.log(`[Metadata] 文件格式: ${fileExt}`)

  if (settingState.setting['download.writeMetadata']) {
    try {
      const title = settingState.setting['download.writeAlias'] && task.musicInfo.alias
        ? `${task.musicInfo.name} (${task.musicInfo.alias})`
        : task.musicInfo.name

      await writeMetadata(filePath, {
        name: title,
        singer: task.musicInfo.singer,
        albumName: task.musicInfo.meta.albumName,
      }, true)
      downloadActions.updateTask(task.id, { metadataStatus: { ...task.metadataStatus, tags: 'success' } })
    } catch (e: any) {
      console.error('[Metadata] 标签信息写入失败:', e?.message || e)
      toast('标签信息写入失败', 'short')
      downloadActions.updateTask(task.id, { metadataStatus: { ...task.metadataStatus, tags: 'fail' } })
    }
  }

  if (settingState.setting['download.writePicture']) {
    try {
      const picUrl = await getPicUrl({ musicInfo: task.musicInfo as LX.Music.MusicInfoOnline } as any)
      const extension = getFileExtensionFromUrl(picUrl) || 'jpg'
      // 封面落盘到 picture/ 作为本地缓存（与音频同名），写入内嵌封面后保留不删
      const picPath = `${getPictureDir()}/${task.fileName}.${extension}`
      console.log(`[Metadata] 下载封面: ${picUrl} -> ${picPath}`)
      const { promise } = downloadFile(picUrl, picPath)
      const picResult: any = await promise
      // 中：此前不校验结果——404 的 HTML 以 .jpg 落盘 picture/，之后
      // 只判存在就复用、永不重下，这首歌封面被永久毒缓存顶掉
      if (!picResult || picResult.statusCode < 200 || picResult.statusCode >= 300 || !(picResult.bytesWritten > 0)) {
        await unlink(picPath).catch(() => {})
        throw new Error(`封面下载失败（HTTP ${picResult?.statusCode ?? '未知'}）`)
      }
      console.log('[Metadata] 封面下载完成，开始写入到音频文件')
      await writePic(filePath, picPath)
      console.log('[Metadata] 封面写入完成')
      downloadActions.updateTask(task.id, { metadataStatus: { ...task.metadataStatus, cover: 'success' } })
    } catch (e: any) {
      console.error('[Metadata] 封面写入失败:', e?.message || e)
      toast('封面写入失败', 'short')
      downloadActions.updateTask(task.id, { metadataStatus: { ...task.metadataStatus, cover: 'fail' } })
    }
  }

  if (settingState.setting['download.writeLyric'] || settingState.setting['download.writeEmbedLyric']) {
    try {
      const lyrics = await getLyricInfo({ musicInfo: task.musicInfo as LX.Music.MusicInfoOnline })
      const romaLyric = settingState.setting['download.writeRomaLyric'] ? lyrics.rlyric : null

      if (settingState.setting['download.writeEmbedLyric']) {
        const embedLyricContent = mergeLyrics(lyrics.lyric, lyrics.tlyric, romaLyric)
        if (embedLyricContent) {
          console.log('[Metadata] 写入嵌入歌词')
          await writeLyric(filePath, embedLyricContent)
        }
      }
      if (settingState.setting['download.writeLyric']) {
        const finalLyricContent = mergeLyrics(lyrics.lyric, lyrics.tlyric, romaLyric)
        if (finalLyricContent) {
          const lrcPath = `${getLrcDir()}/${task.fileName}.lrc`
          console.log(`[Metadata] 写入歌词文件: ${lrcPath}`)
          await writeFile(lrcPath, finalLyricContent)
        }
      }
      downloadActions.updateTask(task.id, { metadataStatus: { ...task.metadataStatus, lyric: 'success' } })
    } catch (e: any) {
      console.error('[Metadata] 歌词写入失败:', e?.message || e)
      toast('歌词写入失败', 'short')
      downloadActions.updateTask(task.id, { metadataStatus: { ...task.metadataStatus, lyric: 'fail' } })
    }
  }
}

export const retryMetadata = async(taskId: string) => {
  const task = downloadState.tasks.find(t => t.id === taskId)
  if (!task?.filePath) {
    toast('任务或文件不存在，无法重试')
    return
  }

  // 写入能力不可用时跳过（同 handleMetadata，按原生模块可用性而非平台判断）
  if (!isWriteSupported()) {
    toast('当前平台不支持写入元数据')
    return
  }

  console.log(`[Retry Metadata] 开始重试元数据写入，文件: ${task.filePath}`)
  toast('正在尝试重新获取元信息...')
  const filePath = task.filePath
  const metadataStatus = { ...task.metadataStatus }

  const fileExt = filePath.substring(filePath.lastIndexOf('.') + 1).toLowerCase()
  console.log(`[Retry Metadata] 文件格式: ${fileExt}`)

  if (metadataStatus.tags === 'fail' && settingState.setting['download.writeMetadata']) {
    try {
      const title = settingState.setting['download.writeAlias'] && task.musicInfo.alias
        ? `${task.musicInfo.name} (${task.musicInfo.alias})`
        : task.musicInfo.name

      console.log(`[Retry Metadata] 写入标签: title=${title}, singer=${task.musicInfo.singer}`)
      await writeMetadata(filePath, {
        name: title,
        singer: task.musicInfo.singer,
        albumName: task.musicInfo.meta.albumName,
      }, true)
      metadataStatus.tags = 'success'
      console.log('[Retry Metadata] 标签写入成功')
    } catch (e: any) {
      console.error(`[Retry Metadata] Write Tags Error for ${task.musicInfo.name}:`, e?.message || e)
      metadataStatus.tags = 'fail'
    }
  }

  if (metadataStatus.cover === 'fail' && settingState.setting['download.writePicture']) {
    try {
      const picUrl = await getPicUrl({ musicInfo: task.musicInfo as LX.Music.MusicInfoOnline } as any)
      const extension = getFileExtensionFromUrl(picUrl) || 'jpg'
      const picPath = `${getPictureDir()}/${task.fileName}.${extension}`

      console.log(`[Retry Metadata] 下载封面: ${picUrl} -> ${picPath}`)
      const { promise } = downloadFile(picUrl, picPath)
      const picResult: any = await promise
      if (!picResult || picResult.statusCode < 200 || picResult.statusCode >= 300 || !(picResult.bytesWritten > 0)) {
        await unlink(picPath).catch(() => {})
        throw new Error(`封面下载失败（HTTP ${picResult?.statusCode ?? '未知'}）`)
      }
      console.log('[Retry Metadata] 封面下载完成，开始写入')
      await writePic(filePath, picPath)
      metadataStatus.cover = 'success'
      console.log('[Retry Metadata] 封面写入成功')
    } catch (e: any) {
      console.error(`[Retry Metadata] Write Cover Error for ${task.musicInfo.name}:`, e?.message || e)
      metadataStatus.cover = 'fail'
    }
  }

  if (metadataStatus.lyric === 'fail' && (settingState.setting['download.writeLyric'] || settingState.setting['download.writeEmbedLyric'])) {
    try {
      const lyrics = await getLyricInfo({ musicInfo: task.musicInfo as LX.Music.MusicInfoOnline })
      const romaLyric = settingState.setting['download.writeRomaLyric'] ? lyrics.rlyric : null

      if (settingState.setting['download.writeEmbedLyric']) {
        const embedLyricContent = mergeLyrics(lyrics.lyric, lyrics.tlyric, romaLyric)
        if (embedLyricContent) {
          console.log('[Retry Metadata] 写入嵌入歌词')
          await writeLyric(filePath, embedLyricContent)
        }
      }
      if (settingState.setting['download.writeLyric']) {
        const finalLyricContent = mergeLyrics(lyrics.lyric, lyrics.tlyric, romaLyric)
        if (finalLyricContent) {
          const lrcPath = `${getLrcDir()}/${task.fileName}.lrc`
          console.log(`[Retry Metadata] 写入歌词文件: ${lrcPath}`)
          await writeFile(lrcPath, finalLyricContent)
        }
      }
      metadataStatus.lyric = 'success'
      console.log('[Retry Metadata] 歌词写入成功')
    } catch (e: any) {
      console.error(`[Retry Metadata] Write Lyric Error for ${task.musicInfo.name}:`, e?.message || e)
      metadataStatus.lyric = 'fail'
    }
  }

  downloadActions.updateTask(task.id, { metadataStatus })

  if (Object.values(metadataStatus).every(s => s !== 'fail')) {
    toast('元信息已全部修复成功！')
  } else {
    toast('部分元信息修复失败，请检查日志', 'long')
  }
}

export const retryTask = (taskId: string) => {
  const task = downloadState.tasks.find(t => t.id === taskId)
  if (!task) return

  if (task.status === 'error' || !task.filePath) {
    toast('正在重新下载...')
    removeTask(task.id)
    setTimeout(() => {
      // 低：此前丢弃 isForceCookie——网易云 Cookie 任务重试静默降级普通链路
      addTask(task.musicInfo, task.quality, task.isForceCookie)
    }, 200)
  } else if (Object.values(task.metadataStatus ?? {}).includes('fail')) {
    void retryMetadata(task.id)
  }
}

/**
 * 暂停任务（D1）：等待中的直接移出队列；下载中的停掉当前下载，
 * 任务与已下载进度保留在列表里，之后可从「继续」重新下载。
 */
export const pauseTask = (taskId: string) => {
  const task = downloadState.tasks.find(t => t.id === taskId)
  if (!task) return
  if (task.status === 'waiting') {
    const idx = taskQueue.findIndex(t => t.id === taskId)
    if (idx > -1) taskQueue.splice(idx, 1)
    downloadActions.updateTask(taskId, { status: 'paused' })
    return
  }
  if (task.status === 'downloading') {
    pausedTaskIds.add(taskId)
    downloadActions.updateTask(taskId, { status: 'paused' })
    const jobId = (currentDownloadTask as any)?.jobId
    if (typeof jobId === 'number') stopDownload(jobId)
  }
}

export const resumeTask = async(taskId: string) => {
  const task = downloadState.tasks.find(t => t.id === taskId)
  if (!task) return
  if (task.status !== 'paused') return

  if (taskQueue.some(t => t.id === task.id)) {
    return
  }

  // 中-22：先同步把状态改出 paused 再做异步清理——否则确认框双开/连点时，
  // 两次调用都通过上面的检查，同一任务会被入队下载两遍
  downloadActions.updateTask(task.id, {
    status: 'waiting',
    errorMsg: '',
    progress: { percent: 0, speed: '', downloaded: 0, total: 0 },
    metadataStatus: { cover: 'pending', lyric: 'pending', tags: 'pending' },
  })

  try {
    await unlink(task.filePath)
    // 中：.download 变体一并清——只删 filePath 时半截临时文件永留存
    const variant = downloadTempVariantPath(task)
    if (variant) await unlink(variant).catch(() => {})
  } catch (error) {
    // Ignore cleanup failures so we can still restart the download.
  }

  // 存疑处理：unlink 期间任务可能被删——复查仍在列表且仍是 waiting 才入队，
  // 否则会下出一个没有 UI 对应物的幽灵下载
  const freshTask = downloadState.tasks.find(t => t.id === task.id)
  if (!freshTask || freshTask.status !== 'waiting') return
  taskQueue.push(freshTask)
  processQueue()
}

export const addTask = (
  musicInfo: LX.Music.MusicInfo,
  quality: LX.Quality,
  isForceCookie: boolean = false,
  /** 批量入队时静默（批量流程自己会弹汇总提示，避免几十条刷屏） */
  silent: boolean = false,
) => {
  let extension = getFileExtension(quality)
  if (musicInfo.source === 'bilibili') {
    extension = 'mp3'
  }

  let finalSingerString = musicInfo.singer
  if (musicInfo.artists && musicInfo.artists.length > 6) {
    finalSingerString = musicInfo.artists.slice(0, 6).map(artist => artist.name).join('、') + '...'
  }
  // 低：链式 replace 只替首处、且替换串里的 $&/$' 会被特殊展开——用
  // 函数式 replacer 全量替换；文件名加 UTF-8 字节上限，长标题（中文
  // 3 字节/字）超 255 字节分量上限此前每次必 ENAMETOOLONG 失败
  let fileName = settingState.setting['download.fileName']
    .replace(/歌名/g, () => musicInfo.name)
    .replace(/歌手/g, () => finalSingerString)
  fileName = truncateToUtf8Bytes(filterFileName(fileName).trim(), 180)
  // 中：路径碰撞——同名同歌手的异歌、或同歌不同音质（扩展名同为 mp3）
  // 共用一条路径，后下覆盖先下、删一个连另一个的文件一起删。被其他
  // 任务占用时给文件名加歌曲 id 短后缀并写回任务
  let filePath = `${getMusicDir()}/${fileName}.${extension}`
  if (downloadState.tasks.some(t => t.filePath === filePath)) {
    const suffix = String(musicInfo.id).replace(/[^a-zA-Z0-9]/g, '').slice(-6) || 'x'
    fileName = `${fileName}-${suffix}`
    filePath = `${getMusicDir()}/${fileName}.${extension}`
  }

  const task: DownloadTask = {
    id: toMD5(`${musicInfo.id}-${quality}`),
    musicInfo,
    quality,
    status: 'waiting',
    filePath,
    fileName,
    progress: { percent: 0, speed: '', downloaded: 0, total: 0 },
    metadataStatus: { cover: 'pending', lyric: 'pending', tags: 'pending' },
    createdAt: Date.now(),
    isForceCookie,
  }

  const existingTask = downloadState.tasks.find(t => t.id === task.id)
  if (existingTask) {
    if (!silent) {
      if (existingTask.status === 'completed') toast('这首歌已下载，去「本地与下载」里听吧')
      else if (existingTask.status === 'downloading' || existingTask.status === 'waiting') toast('已在下载队列中')
      else toast('任务已存在，在「下载管理」里可继续')
    }
    return
  }

  // 中：批量入队（silent 且批次进行中）盖戳，成败只计入所属批次
  if (silent && batchState) batchTaskIds.add(task.id)
  downloadActions.addTask(task)
  taskQueue.push(task)
  processQueue()
  // 统一在这里给反馈：任何入口（播放页按钮 / 封面长按 / 歌曲菜单 / 批量）点了都有提示。
  // 延迟 350ms 是为了等 RN Modal（iOS 独立原生窗口、层级高于 RNN Toast overlay）退场，
  // 否则播放页里的提示会被菜单盖住，看起来「点了没反应」。
  if (!silent) {
    setTimeout(() => {
      toast(
        global.i18n.t('download_added_tip', { name: musicInfo.name, quality: global.i18n.t(quality) }),
        'short',
      )
    }, 350)
  }
}

export const removeTask = (id: string) => {
  const taskToRemove = downloadState.tasks.find(t => t.id === id)
  // 中-18/高-3：删下载中任务先打取消标记，让在途的 catch/完成路径静默收尾；
  // 同时清掉可能残留的暂停标记，防止按 id 毒化同歌重下
  if (taskToRemove && taskToRemove.status === 'downloading') cancelledTaskIds.add(id)
  pausedTaskIds.delete(id)
  if (currentDownloadTask && taskToRemove && taskToRemove.status === 'downloading') {
    const jobId = currentDownloadTask.jobId
    if (typeof jobId === 'number') {
      stopDownload(jobId)
    }
    if (taskToRemove.filePath) {
      void unlink(taskToRemove.filePath).catch(() => {})
      const variant = downloadTempVariantPath(taskToRemove)
      if (variant) void unlink(variant).catch(() => {})
      console.log(`[Download Manager] Canceled and deleted partial file: ${taskToRemove.filePath}`)
    }
    currentDownloadTask = null
  } else if (taskToRemove && taskToRemove.status !== 'completed' && taskToRemove.filePath) {
    void unlink(taskToRemove.filePath).catch(() => {})
    const variant = downloadTempVariantPath(taskToRemove)
    if (variant) void unlink(variant).catch(() => {})
  }
  const taskIndex = taskQueue.findIndex(t => t.id === id)
  if (taskIndex > -1) taskQueue.splice(taskIndex, 1)
  downloadActions.removeTask(id)
  // 2026-10-05 fix（P1-5）：不要碰 isProcessing、不要调 processQueue()——
  // 进行中的下载其 finally 本来就会重置标志并拉起下一个；无条件重置会导致
  // 并发下载（删已完成任务时）或重复拉起（删下载中任务时 finally 再拉一次）。
}


/**
 * Batch download tasks - add download tasks with interval
 * @param musicInfos Selected song list
 */
export const batchDownload = async(musicInfos: LX.Music.MusicInfo[]) => {
  // 中-21：上一批还在入队时再触发一批，不覆写全局计数——合并进当前批次一起汇总
  if (!batchState) batchState = { success: 0, fail: 0, adding: true }
  batchAddingCount++
  const cookie = settingState.setting['common.wy_cookie']
  const hasWyMusic = musicInfos.some(m => m.source === 'wy')

  if (hasWyMusic && !cookie) {
    toast('未配置网易云 Cookie，网易云音源将使用普通音质下载')
  }

  const quality = settingState.setting['download.quality']
  let wyCount = 0
  let otherCount = 0

  for (const musicInfo of musicInfos) {
    if (musicInfo.source === 'wy') wyCount++; else otherCount++
  }

  const tips = []
  if (wyCount > 0) tips.push(`${wyCount}首网易云${cookie ? '(Cookie)' : '(普通)'}`)
  if (otherCount > 0) tips.push(`${otherCount}首其他音源`)
  toast(`准备添加 ${musicInfos.length} 首歌曲到下载队列 (${tips.join(', ')})`)

  for (const musicInfo of musicInfos) {
    const isWyAndHasCookie = musicInfo.source === 'wy' && !!cookie
    addTask(musicInfo, quality, isWyAndHasCookie, true)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  batchAddingCount--
  if (batchState) batchState.adding = batchAddingCount > 0
  // 全部任务瞬间失败/未入队等极端情况：processQueue 不会再被触发，这里补一次排空检查
  if (batchState && batchAddingCount === 0 && taskQueue.length === 0 && !isProcessing) {
    const { success, fail } = batchState
    batchState = null
    batchTaskIds.clear()
    if (success + fail > 0) toast(`批量下载完成：成功 ${success} 首${fail ? `，失败 ${fail} 首` : ''}`, 'long')
  }
}

/**
 * 「立即下载」入口：按指定音质入队并立刻给出反馈（播放详情页 / 歌曲菜单共用）。
 * 此前播放详情页封面长按「下载歌曲」是直接 addTask，点下去没有任何提示，
 * 用户只能等下载完成后在悬浮球上看到状态变化。
 */
export const downloadMusicWithQuality = (musicInfo: LX.Music.MusicInfo, quality: LX.Quality) => {
  // 提示已下沉到 addTask（所有入口统一），这里不再重复弹
  addTask(musicInfo, quality)
}

/**
 * 直接按下载设置中的音质下载单曲，并提示所添加的音质（不再弹确认框）
 */
export const downloadMusic = (musicInfo: LX.Music.MusicInfo) => {
  // 之前这里是静默 return：下载开关关掉时点下载既没下载也没提示（用户反馈「点了没反应」）
  if (!settingState.setting['download.enable']) {
    toast('下载功能未开启（设置 → 下载设置里打开）', 'short')
    return
  }
  downloadMusicWithQuality(musicInfo, settingState.setting['download.quality'] as LX.Quality)
}
