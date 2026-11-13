import RNFetchBlob from '@/utils/rnFetchBlob'
import { toMD5, toast, requestStoragePermission } from '@/utils/tools'
import { getMusicUrl, getMusicUrlWithQuality, getLyricInfo } from '@/core/music'
import { getFileExtension, getFileExtensionFromUrl } from '@/screens/Home/Views/Mylist/MusicList/download/utils'
import { mergeLyrics } from '@/screens/Home/Views/Mylist/MusicList/download/lrcTool'
import { writeFile, unlink, downloadFile, moveFile, stopDownload, existsFile, stat } from '@/utils/fs'
import { getMusicDir, getLrcDir, getPictureDir, ensureLibraryDirs, findLibraryPicture, cacheCoverToLibrary, isPicCacheEnabled, truncateToUtf8Bytes } from '@/utils/localLibrary'
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
// 4-3：addTask 磁盘校验是异步的——入队中（已过重任务检查、未写 store）的
// 任务 id 集合，连点时第二通调用靠它去重，避免异步窗口内重复入队
const addingTaskIds = new Set<string>()
// 4-4：resumeTask 已校验文件完整时登记（任务 id → 文件字节数），
// startDownload 见到登记即跳过取链+下载，直接走元数据/完成结算
const resumeCompleteFiles = new Map<string, number>()
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
// 下载多线程（2026-11-12）：worker 池，取代旧的 isProcessing 布尔门 + 单例
// currentDownloadTask。activeTaskIds = 已出队、正在处理（含取链中）的任务 id，
// 泵送上限与批量排空判定都看它；activeDownloadJobs 只存已建 RNFS 下载对象的
// 任务（供暂停/删除按任务查 jobId），生命周期由 startDownload 内的 downloadOnce
// 管理（建对象时 set、finally 里 delete）。
const activeTaskIds = new Set<string>()
const activeDownloadJobs = new Map<string, any>()
const DOWNLOAD_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Mobile Safari/537.36',
}
const WY_MEDIA_HEADERS = {
  'User-Agent': '',
}
const getDownloadHeaders = (task: DownloadTask) => {
  return task.musicInfo.source === 'wy' ? WY_MEDIA_HEADERS : DOWNLOAD_HEADERS
}

// 同时下载数量：读 download.concurrency（1-6，默认 3），非法值钳制。
// 并发数中途改大/改小即时生效：改大后下次泵送（或设置 UI 调 kickDownloadQueue）
// 立即补齐；改小后在途任务自然跑完、不再新开。
const getDownloadConcurrency = (): number => {
  const raw = settingState.setting['download.concurrency']
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 3
  return Math.min(6, Math.max(1, n))
}

// 批量队列排空 → 只弹一条汇总（D5）。排空 = 无入队中的批次、无排队任务、无在途任务。
const maybeReportBatchDrain = () => {
  if (!batchState || batchAddingCount !== 0 || taskQueue.length !== 0 || activeTaskIds.size !== 0) return
  const { success, fail } = batchState
  batchState = null
  batchTaskIds.clear()
  if (success + fail > 0) toast(`批量下载完成：成功 ${success} 首${fail ? `，失败 ${fail} 首` : ''}`, 'long')
}

// 单任务执行（含失败/暂停/取消收尾；原 processQueue 的 try/catch/finally 整体下移）
const runDownloadTask = async(task: DownloadTask) => {
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
      cleanupDownloadTempFiles(task)
      if (batchTaskIds.has(task.id)) {
        if (batchState) batchState.fail++
      } else toast(`${task.fileName} ${friendlyDownloadError(error)}`, 'short')
    }
  } finally {
    // 高：无论何种路径结束，都清掉本任务的暂停/取消残留标记——元数据
    // 阶段点的暂停此前无人消费，标记按确定性 id 残留，同歌重下会静默卡死
    pausedTaskIds.delete(task.id)
    cancelledTaskIds.delete(task.id)
    activeTaskIds.delete(task.id)
    processQueue()
    maybeReportBatchDrain()
  }
}

// 泵送：有空闲 worker 且队列非空时取出任务并行跑（fire-and-forget，各任务在
// 自己的 runDownloadTask 里结算；结算时 finally 再泵送）。
const processQueue = () => {
  const concurrency = getDownloadConcurrency()
  while (activeTaskIds.size < concurrency && taskQueue.length > 0) {
    const task = taskQueue.shift()
    if (!task) return
    activeTaskIds.add(task.id)
    void runDownloadTask(task)
  }
}

// 供并行数设置 UI 调用：调高上限后立即泵送排队的任务。
export const kickDownloadQueue = () => {
  processQueue()
}

// .download 临时变体路径（扩展名不一致/B站下载时实际写入的路径）
const downloadTempVariantPath = (task: DownloadTask): string => {
  const extMatch = /\.([^.]+)$/.exec(task.filePath)
  if (!extMatch || task.filePath.includes('.download.')) return ''
  return task.filePath.replace(/\.([^.]+)$/, '.download.$1')
}

// 任务记录里落盘的实际临时下载路径（2026-11-09）：与 actualQuality 同为后加的
// 可选字段——startDownload 定下临时路径后写回任务，使失败/删除/重启后清理用的
// 都是同一份路径事实。此前临时路径只存在于 startDownload 的局部变量，清理时按
// filePath 推导变体，推导用的是建任务时的扩展名，与实际写入的 URL 扩展名不一致
// 时必然删错、真临时文件永留存。旧任务无此字段，读取返回空串、清理回退推导。
type DownloadTaskWithTempPath = DownloadTask & { downloadTempPath?: string }
const recordedTempPath = (task: DownloadTask): string => (task as DownloadTaskWithTempPath).downloadTempPath ?? ''
const setRecordedTempPath = (task: DownloadTask, tempPath?: string) => {
  downloadActions.updateTask(task.id, { downloadTempPath: tempPath } as unknown as Partial<DownloadTask>)
}

// 需清理的临时文件路径清单：记录的实际路径优先，再补推导变体（相同则去重）
const downloadTempPaths = (task: DownloadTask): string[] => {
  const paths: string[] = []
  const recorded = recordedTempPath(task)
  if (recorded) paths.push(recorded)
  const variant = downloadTempVariantPath(task)
  if (variant && variant !== recorded) paths.push(variant)
  return paths
}

const cleanupDownloadTempFiles = (task: DownloadTask) => {
  for (const tempPath of downloadTempPaths(task)) void unlink(tempPath).catch(() => {})
}

const startDownload = async(task: DownloadTask) => {
  downloadActions.updateTask(task.id, { status: 'downloading' })
  // 不再弹「开始下载」（D4）：入队时已有「已加入队列」提示，串行队列里排后面的
  // 任务几分钟后才真正开始，这条 toast 只会让人困惑；进度看悬浮球/下载标签即可。

  /**
   * 取链（2026-11-12 失败策略整合）：三分支统一为一次解析。
   * - 网易 Cookie 强制链路 / B 站直连：失败后不再 toast+删任务，改为落到
   *   通用分支（getMusicUrlWithQuality，失败策略引擎在里面跑平台/音质/音源
   *   各步）；通用分支也失败才抛给 runDownloadTask 标 error（任务保留，可手动重试）。
   * - 返回实际解析到的歌曲（换源成功时与任务原歌曲不同源），供写回 actualSource。
   */
  const resolveTaskUrl = async(): Promise<{
    url: string
    headers: any
    actualQuality?: LX.Quality
    resolvedMusicInfo: LX.Music.MusicInfo
    fromBilibiliDirect: boolean
  }> => {
    const musicInfo = task.musicInfo
    if (task.isForceCookie && musicInfo.source === 'wy') {
      const highQualityLevels: LX.Quality[] = ['flac', 'hires', 'master', 'atmos', 'atmos_plus']
      console.log(`[Batch Download] Forcing cookie for ${musicInfo.name}`)
      try {
        const result: any = await (wySdk.cookie.getMusicUrl(musicInfo, task.quality) as any).promise
        if (!result.url) throw new Error('Cookie 未能获取到URL')
        if (result.level === 'exhigh' && highQualityLevels.includes(task.quality)) {
          throw new Error(`请求的音质 ${task.quality} 不可用`)
        }
        return { url: result.url, headers: getDownloadHeaders(task), resolvedMusicInfo: musicInfo, fromBilibiliDirect: false }
      } catch (error: any) {
        // 暂停/取消不落通用分支：直接抛，让 runDownloadTask 按标记收尾
        if (pausedTaskIds.has(task.id) || cancelledTaskIds.has(task.id)) throw error
        console.log(`[Download] 网易 Cookie 直连失败，改走通用取链（失败策略）: ${error?.message || error}`)
      }
    }
    if (musicInfo.source === 'bilibili') {
      console.log('[Download] 处理 bilibili 源')
      try {
        const result: any = await (bilibiliSdk.getMusicUrl(musicInfo, task.quality) as any).promise
        // D-9：与 wy Cookie 分支同口径——空 URL 抛错改走通用取链（失败策略），
        // 否则空 URL 直接返回给下载器，下游收到的任务没有可用的 URL。
        if (!result.url) throw new Error('Bilibili 未能获取到URL')
        if (result.headers) console.log('[Download] 使用 bilibili 自定义 headers')
        return { url: result.url, headers: result.headers ?? getDownloadHeaders(task), resolvedMusicInfo: musicInfo, fromBilibiliDirect: true }
      } catch (error: any) {
        if (pausedTaskIds.has(task.id) || cancelledTaskIds.has(task.id)) throw error
        console.log(`[Download] B 站直连失败，改走通用取链（失败策略）: ${error?.message || error}`)
      }
    }
    if (musicInfo.source === 'local') {
      // 本地 / 网盘音频（webdav 也是 source=local）：不存在「请求音质降级」，沿用原链路
      const url = await getMusicUrl({ musicInfo, quality: task.quality, isRefresh: true })
      return { url, headers: getDownloadHeaders(task), resolvedMusicInfo: musicInfo, fromBilibiliDirect: false }
    }
    const resolved = await getMusicUrlWithQuality({
      musicInfo: musicInfo as LX.Music.MusicInfoOnline,
      quality: task.quality,
      isRefresh: true,
    })
    return { url: resolved.url, headers: getDownloadHeaders(task), actualQuality: resolved.quality, resolvedMusicInfo: resolved.musicInfo, fromBilibiliDirect: false }
  }

  await requestStoragePermission()
  // 磁盘空间提醒（D15）：只提醒不拦截，避免空间不足时最后以原始写入错误收场、无从理解
  try {
    const fsInfo = await RNFS.getFSInfo()
    if (fsInfo.freeSpace < 100 * 1024 * 1024) toast(`存储空间不足（剩余 ${sizeFormate(fsInfo.freeSpace)}），下载可能失败`, 'long')
  } catch {}
  // 统一本地库结构：根目录 + music/ + lrc/ + picture/
  await ensureLibraryDirs()

  // 进度状态（跨两次文件下载尝试共享；每次 downloadOnce 开始时清零）
  let lastWritten = 0
  let lastSpeedText = '0 B/s'
  let knownTotal = 0
  const progressSamples: Array<{ time: number, written: number }> = []
  // 当前正在下载的 URL：上一遍的 HEAD 探测可能晚到，用它拦下过期探测结果
  //（否则第一遍文件的总量会被算到第二遍文件头上，进度与完成总量都错）
  let currentDownloadUrl = ''

  const publishProgress = () => {
    const freshTask = downloadState.tasks.find(t => t.id === task.id)
    if (!freshTask || freshTask.status !== 'downloading') return
    downloadActions.updateTask(task.id, {
      progress: {
        ...freshTask.progress,
        percent: knownTotal > 0 ? Math.min(1, Math.max(0, lastWritten / knownTotal)) : 0,
        downloaded: lastWritten,
        total: knownTotal,
        speed: lastSpeedText,
      },
    })
  }

  /**
   * 单次文件下载（2026-11-12 失败策略 D4）：取链 + 下载至多跑两遍——文件下载
   * 失败（网络中断 / 非 2xx / 0 字节）时清半截文件、重取一次新鲜 URL 再下一遍
   *（策略可能换平台/音质）；取链本身失败不进这层重试（策略引擎已跑过各步，
   * 再整条重跑等于请求翻倍）。暂停/取消由调用方在 catch 里先查集合、直接重抛。
   */
  const downloadOnce = async(url: string, headers: any, downloadFilePath: string): Promise<any> => {
    lastWritten = 0
    lastSpeedText = '0 B/s'
    knownTotal = 0
    progressSamples.length = 0
    // 速度起点采样（2026-11-13，0 B/s 修复）：下载开始即预置一个 written=0
    // 的起点，此后首个进度回调的 elapsed 就是真实下载耗时，首回调即可算出
    // 有意义的平均速度；此前首采样是第一次回调、又要 elapsed>=500 才算，
    // 500ms 内下完的歌速度永远算不出非零值。清零之后才预置；两遍重取链时
    // downloadOnce 各跑一次，第二遍重新清零并重新预置，不会串用第一遍起点。
    progressSamples.push({ time: Date.now(), written: 0 })
    currentDownloadUrl = url

    // 总量兜底：部分源站对 GET 使用分块传输，RNFS 回调的 contentLength
    // 全程是 -1/0，进度条只能一直显示「总量未知」。下载开始后并发发一个
    // HEAD 探测总大小（不阻塞下载、不下载正文）；探测不到就维持未知，
    // GET 回调一旦给出真实 contentLength，以 GET 的值为准覆盖探测值。
    const probeTotalByHead = () => {
      if (!/^https?:\/\//i.test(url)) return
      try {
        void fetch(url, { method: 'HEAD', headers })
          .then(response => {
            // 迟到的上一遍探测：当前已在下另一个 URL 时丢弃
            if (url !== currentDownloadUrl) return
            if (response.status < 200 || response.status >= 300 || knownTotal > 0) return
            const parsed = Number.parseInt(response.headers.get('content-length') ?? '', 10)
            if (!Number.isFinite(parsed) || parsed <= 0) return
            knownTotal = parsed
            publishProgress()
            console.log(`[Download] HEAD 探测到文件总量: ${task.fileName} ${parsed}`)
          })
          .catch(() => {})
      } catch {}
    }
    probeTotalByHead()

    const downloadTask = downloadFile(url, downloadFilePath, {
      headers,
      progress: (res) => {
        const now = Date.now()
        const written = Math.max(0, res.bytesWritten || 0)
        // GET 的 contentLength 是本次响应的权威总量；缺失（-1/0）时保留
        // HEAD 探测值，不再把已知的总量又覆写回未知
        if (res.contentLength > 0) knownTotal = res.contentLength

        // 速度用最近 2 秒的滑动窗口算，不再用相邻两次回调的瞬时差：
        // 250ms 级别的瞬时值抖动大、首帧还经常算出空/异常值，行里看起来
        // 就像「没有速度」。起点采样已预置，elapsed 是真实下载耗时，首回调
        // 即可算平均速度，不再设 500ms 门；只有同一毫秒内两次回调
        // （elapsed 为 0，除零）时才沿用上一次速度（初始 0 B/s）。
        progressSamples.push({ time: now, written })
        while (progressSamples.length > 2 && now - progressSamples[0].time > 2000) {
          progressSamples.shift()
        }
        const firstSample = progressSamples[0]
        const elapsed = now - firstSample.time
        if (elapsed > 0) {
          const speed = (written - firstSample.written) / (elapsed / 1000)
          if (Number.isFinite(speed) && speed >= 0) lastSpeedText = `${sizeFormate(speed)}/s`
        }

        lastWritten = written
        publishProgress()
      },
    })

    // 多线程（2026-11-12）：按任务 id 登记 RNFS 下载对象，供暂停/删除查 jobId；
    // finally 里注销（不论成功、失败还是被 stopDownload 中断）。
    activeDownloadJobs.set(task.id, downloadTask)
    try {
      const downloadResult: any = await downloadTask.promise
      // 高：此前丢弃下载结果——403/404 错误页或 0 字节文件会被存成音频
      // 并标记 completed，毒文件长期留在 music/ 被当正常歌曲
      if (!downloadResult || downloadResult.statusCode < 200 || downloadResult.statusCode >= 300 || !(downloadResult.bytesWritten > 0)) {
        await unlink(downloadFilePath).catch(() => {})
        throw new Error(`下载失败（HTTP ${downloadResult?.statusCode ?? '未知'}）`)
      }
      return downloadResult
    } finally {
      activeDownloadJobs.delete(task.id)
    }
  }

  // 取链 + 文件下载，至多 2 次（第 2 次是文件阶段失败后的重取链重试）
  let downloadedFilePath = ''
  let finalFilePath = task.filePath
  let downloadResult: any = null
  let usedBilibiliDirect = false
  let lastFileError: any = null
  // 4-4：resumeTask 已校验文件完整时跳过下载循环（attempt 上限为 0），
  // 循环后直接用已落盘文件结算（见下方 resumeCompleteSize 分支）
  const resumeCompleteSize = resumeCompleteFiles.get(task.id)
  const skipDownload = resumeCompleteSize != null
  if (skipDownload) resumeCompleteFiles.delete(task.id)
  for (let attempt = 0; attempt < (skipDownload ? 0 : 2); attempt++) {
    // 取链前用户可能已点暂停/删除：此时还没建下载任务，直接收尾
    //（状态已由 pauseTask / removeTask 置好）
    if (pausedTaskIds.has(task.id)) {
      pausedTaskIds.delete(task.id)
      return
    }
    if (cancelledTaskIds.has(task.id)) {
      cancelledTaskIds.delete(task.id)
      return
    }

    const resolved = await resolveTaskUrl()

    // 取链期间用户可能已点暂停：此时还没建下载任务，直接收尾
    if (pausedTaskIds.has(task.id)) {
      pausedTaskIds.delete(task.id)
      return
    }
    if (cancelledTaskIds.has(task.id)) {
      cancelledTaskIds.delete(task.id)
      return
    }

    // 实际拿到的音质（可能因歌曲不支持请求档位而降级）与实际来源（换源成功时
    // 与任务原平台不同）：写入任务，供「本地与下载」列表显示
    const writeBack: Partial<DownloadTask> = {}
    if (resolved.actualQuality && resolved.actualQuality !== task.quality) writeBack.actualQuality = resolved.actualQuality
    if (resolved.resolvedMusicInfo.source && resolved.resolvedMusicInfo.source !== task.musicInfo.source) {
      writeBack.actualSource = resolved.resolvedMusicInfo.source as LX.OnlineSource
    }
    if (Object.keys(writeBack).length) downloadActions.updateTask(task.id, writeBack)

    // 扩展名按本次 URL 重算（重取链可能换了平台/格式，临时路径与最终路径都得跟着变）
    const urlExtension = getFileExtensionFromUrl(resolved.url)
    const taskExt = task.filePath.substring(task.filePath.lastIndexOf('.') + 1).toLowerCase()
    let downloadFilePath = task.filePath
    finalFilePath = task.filePath
    if (urlExtension && urlExtension !== taskExt) {
      downloadFilePath = `${getMusicDir()}/${task.fileName}.download.${urlExtension}`
      finalFilePath = `${getMusicDir()}/${task.fileName}.${urlExtension}`
      console.log(`[Download] URL 扩展名(${urlExtension})与任务扩展名(${taskExt})不一致，使用真实扩展名下载: ${downloadFilePath} -> ${finalFilePath}`)
    }

    // 2026-11-09：真实扩展名算出的最终路径可能正好是另一条任务的 filePath
    //（如同歌的另一音质任务）——完成改名会先删目标文件，等于连带删掉对方已
    // 下好的文件、两条记录还指向同一路径。
    // 4-1：不再回退用本任务的规划路径（会把 FLAC 内容存成 .mp3、扩展名与格式
    // 错配，下游还按错扩展名写标签）——改加短后缀去重，保留真实扩展名。
    if (finalFilePath !== task.filePath && downloadState.tasks.some(t => t.id !== task.id && t.filePath === finalFilePath)) {
      const dotIndex = finalFilePath.lastIndexOf('.')
      const base = dotIndex > 0 ? finalFilePath.substring(0, dotIndex) : finalFilePath
      const ext = dotIndex > 0 ? finalFilePath.substring(dotIndex) : ''
      let n = 1
      let candidate = `${base}-${n}${ext}`
      while (downloadState.tasks.some(t => t.id !== task.id && t.filePath === candidate)) {
        n++
        candidate = `${base}-${n}${ext}`
      }
      console.log(`[Download] 最终路径 ${finalFilePath} 已被其他任务占用，改用去重路径 ${candidate}`)
      finalFilePath = candidate
    }

    // 2026-11-09：把实际临时路径落入任务记录，供失败/删除/重启后按同一份事实
    // 清理（见 recordedTempPath）；本次直写最终路径而记录里还留着上次尝试的
    // 临时路径时一并清掉，免得日后清理误删旧名
    if (downloadFilePath !== task.filePath) {
      setRecordedTempPath(task, downloadFilePath)
    } else if (recordedTempPath(task)) {
      setRecordedTempPath(task)
    }

    try {
      downloadResult = await downloadOnce(resolved.url, resolved.headers, downloadFilePath)
      downloadedFilePath = downloadFilePath
      usedBilibiliDirect = resolved.fromBilibiliDirect
      // 成功后按本次解析重申写回：第一遍换源/降级后下载失败、第二遍没换源
      // 却成功时，第一遍写回的 actualSource/actualQuality 是脏的，必须清掉，
      // 否则已完成记录会标错来源/音质。undefined 经 Object.assign 写入后读回
      // 即 falsy，列表行回退显示原平台/请求音质。
      downloadActions.updateTask(task.id, {
        actualQuality: resolved.actualQuality && resolved.actualQuality !== task.quality ? resolved.actualQuality : undefined,
        actualSource: resolved.resolvedMusicInfo.source && resolved.resolvedMusicInfo.source !== task.musicInfo.source ? resolved.resolvedMusicInfo.source as LX.OnlineSource : undefined,
      })
      break
    } catch (error: any) {
      // 暂停/取消不重试：直接抛，让 runDownloadTask 按标记收尾
      if (pausedTaskIds.has(task.id) || cancelledTaskIds.has(task.id)) throw error
      lastFileError = error
      // 半截文件已由 downloadOnce 的校验分支清过（0 字节/错误页场景）；
      // 网络中断场景的半截文件在这里补清，避免留在 music/ 被当正常歌曲
      await unlink(downloadFilePath).catch(() => {})
      if (attempt === 0) console.log(`[Download] 文件下载失败，重取链接再试一次: ${task.fileName} (${error?.message || error})`)
    }
  }
  // 4-4：恢复快路径——文件已完整落盘，伪造一份下载结果供下方元数据/完成
  // 结算共用（knownTotal 与 bytesWritten 都取实测大小）；bilibili 是否跳过
  // 元数据按 S-10 口径推断（本源且无 actualSource 写回才视为直连）。
  if (resumeCompleteSize != null) {
    downloadedFilePath = task.filePath
    downloadResult = { bytesWritten: resumeCompleteSize, statusCode: 200 }
    knownTotal = resumeCompleteSize
    // S-10：快路径按「本源是 bilibili 且无实际来源写回」推断直连，与正常
    // 路径按实际解析路由（resolved.fromBilibiliDirect）判定对齐。
    // actualSource 是上一遍下载成功后重申写回的持久化值：直连失败回落
    // 通用分支成功时写回实际来源（非 bilibili），快路径不再误判直连、
    // 不再跳过元数据；真正直连下载时写回清掉 actualSource，仍跳过元数据。
    usedBilibiliDirect = task.musicInfo.source === 'bilibili' && !task.actualSource
  }
  if (!downloadedFilePath || !downloadResult) throw lastFileError ?? new Error('下载失败')

  // 高-3：文件刚下完、写元数据期间被暂停的场景——stopDownload 对已完成的
  // Promise 无效，此处消费暂停标记，保持 paused，不覆写 completed；
  // 残留标记若不清除，会按任务 id 毒化之后同歌重下（静默 return 卡死）。
  if (pausedTaskIds.has(task.id)) {
    pausedTaskIds.delete(task.id)
    // 4-4：文件已完整落盘：把实际字节数写回 progress.total，供 resumeTask
    // 校验完整性（否则总量未知时无法区分完整文件与半截文件）
    const pausedProgress = downloadState.tasks.find(t => t.id === task.id)?.progress ?? task.progress
    downloadActions.updateTask(task.id, {
      status: 'paused',
      progress: { ...pausedProgress, percent: 1, downloaded: downloadResult.bytesWritten, total: downloadResult.bytesWritten, speed: '' },
    })
    return
  }
  if (cancelledTaskIds.has(task.id)) {
    cancelledTaskIds.delete(task.id)
    return
  }
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

  if (!usedBilibiliDirect) {
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
    // 4-4：同上，写回实际字节数供 resumeTask 校验完整性
    const pausedProgress = downloadState.tasks.find(t => t.id === task.id)?.progress ?? task.progress
    downloadActions.updateTask(task.id, {
      status: 'paused',
      filePath: downloadedFilePath,
      progress: { ...pausedProgress, percent: 1, downloaded: downloadResult.bytesWritten, total: downloadResult.bytesWritten, speed: '' },
    })
    return
  }
  try {
    await RNFetchBlob.fs.scanFile([{ path: downloadedFilePath }])
    console.log(`[Download Manager] Media scan requested for: ${downloadedFilePath}`)
  } catch (scanError) {
    console.error(`[Download Manager] Failed to request media scan for ${downloadedFilePath}:`, scanError)
  }
  const latestProgress = downloadState.tasks.find(t => t.id === task.id)?.progress ?? task.progress
  downloadActions.updateTask(task.id, {
    status: 'completed',
    progress: {
      ...latestProgress,
      percent: 1,
      downloaded: downloadResult.bytesWritten,
      // 下载已完整落盘：实际写入字节就是文件总量，HEAD/GET 都没给
      // 总量时用它兜底，避免已完成记录还显示大小未知
      total: knownTotal > 0 ? knownTotal : downloadResult.bytesWritten,
    },
    filePath: downloadedFilePath,
  })
  // 2026-11-09：临时文件已改名为最终路径，清掉任务里的临时路径记录
  if (recordedTempPath(task)) setRecordedTempPath(task)

  // 下载完成后缓存歌词（内存缓存 + 同名 .lrc），保证离线也能显示歌词
  void cacheLyricForOffline(task, downloadedFilePath)
  // 下载完成后把封面缓存到 picture/（已存在则跳过），列表/播放各处优先读本地缓存
  void cacheDownloadedCover(task)

  if (batchTaskIds.has(task.id)) {
    if (batchState) batchState.success++
  } else if (!task.isForceCookie) {
    toast(`${task.fileName} 下载完成!`, 'short')
  }
}

// 下载完成后缓存封面到 picture/<文件名>.<ext>（2026-10-22）：
// 与「下载设置-写入封面」（内嵌进音频）相互独立，保证本地有缓存时各处控件都能直接加载。
const cacheDownloadedCover = async(task: DownloadTask) => {
  try {
    // 歌词/封面缓存策略（2026-11-12）：封面缓存关闭时不补缓存，连在线取图
    // 的网络请求都省掉（cacheCoverToLibrary 内部还有一道同样的门）
    if (!isPicCacheEnabled()) return
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
// 注意（2026-11-12）：这是用户明确要的下载产物、不是自动缓存，不受歌词/封面
// 缓存策略开关控制——关掉「缓存歌词至本地」也不会影响下载时勾选的歌词文件。
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
    // S-9（双保险）：清掉 resumeTask 登记的快路径完整文件记录。任务已移
    // 出队列、本轮不会再进 startDownload；下次恢复时 resumeTask 总会重新
    // 校验磁盘文件并重新登记，清掉不损失任何信息。否则暂停期间文件被外部
    // 删掉后，再恢复时陈旧登记会让 startDownload 跳过下载、把不存在的
    // 文件标为已完成（新幻影记录）。与 removeTask 的清登记同口径。
    resumeCompleteFiles.delete(taskId)
    downloadActions.updateTask(taskId, { status: 'paused' })
    return
  }
  if (task.status === 'downloading') {
    pausedTaskIds.add(taskId)
    downloadActions.updateTask(taskId, { status: 'paused' })
    // 多线程（2026-11-12）：按任务 id 查它自己的 RNFS job（取链阶段还没建
    // 下载对象时 Map 里没有，startDownload 的检查点会按 pausedTaskIds 收尾）
    const jobId = (activeDownloadJobs.get(taskId) as any)?.jobId
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

  // 4-4：先记下校验要用的总量与路径——下面的 updateTask 会重置 progress，
  // 之后再读 task.progress.total 就读到 0 了
  const recordedTotal = task.progress?.total ?? 0
  const filePath = task.filePath

  // 中-22：先同步把状态改出 paused 再做异步清理——否则确认框双开/连点时，
  // 两次调用都通过上面的检查，同一任务会被入队下载两遍
  downloadActions.updateTask(task.id, {
    status: 'waiting',
    errorMsg: '',
    progress: { percent: 0, speed: '', downloaded: 0, total: 0 },
    metadataStatus: { cover: 'pending', lyric: 'pending', tags: 'pending' },
  })

  // 4-4：元数据阶段暂停时文件已完整——恢复前先校验磁盘文件，完整则跳过
  // 下载、直接走元数据/完成结算，不再无条件删掉重下。
  // 完整判定：文件存在且大小 >0，且任务记有总量时大小 ≥ 总量。
  // 注意：总量未知（recordedTotal 为 0）时不走快路径——下载中途暂停的
  // 半截文件同样「存在且非 0」，无法与完整文件区分；且元数据阶段暂停时
  // startDownload 已把实际字节数写回 progress.total，总量未知只可能是
  // 下载中途暂停（半截文件），必须重下。绝不用 percent===1 判定（总量
  // 未知时 percent 恒为 0）。
  let fileComplete = false
  let fileSize = 0
  try {
    if (filePath && (await existsFile(filePath))) {
      fileSize = (await stat(filePath)).size
      fileComplete = fileSize > 0 && recordedTotal > 0 && fileSize >= recordedTotal
    }
  } catch {
    fileComplete = false
  }

  if (fileComplete) {
    // 登记完整文件大小，startDownload 见到即跳过下载循环
    resumeCompleteFiles.set(task.id, fileSize)
    console.log(`[Download] 恢复任务文件已完整，跳过下载直接结算: ${task.fileName} (${fileSize} 字节)`)
  } else {
    // S-9：文件不完整——清掉可能残留的陈旧快路径登记（上次恢复时登记、
    // 任务 waiting 时被暂停、暂停期间文件被外部删除）。不清则 startDownload
    // 命中残留登记跳过下载、伪造结果，把不存在的文件标为已完成。
    // 本分支内 fileComplete 为 false，不存在本轮刚登记的合法记录，删不掉真东西；
    // resumeTask 每次恢复都会重新校验磁盘文件，清登记不损失任何信息。
    resumeCompleteFiles.delete(task.id)
    try {
      await unlink(filePath)
      // 中：.download 变体一并清——只删 filePath 时半截临时文件永留存
      // 2026-11-09：以任务记录的实际临时路径为准、推导变体兜底（见 downloadTempPaths）
      for (const tempPath of downloadTempPaths(task)) await unlink(tempPath).catch(() => {})
    } catch (error) {
      // Ignore cleanup failures so we can still restart the download.
    }
  }

  // 存疑处理：unlink 期间任务可能被删——复查仍在列表且仍是 waiting 才入队，
  // 否则会下出一个没有 UI 对应物的幽灵下载
  const freshTask = downloadState.tasks.find(t => t.id === task.id)
  if (!freshTask || freshTask.status !== 'waiting') {
    // 任务已不在等待态：清掉快路径登记，避免残留毒化之后同 id 任务
    resumeCompleteFiles.delete(task.id)
    return
  }
  // D-3：恢复→暂停→恢复三连击时，先到的调用在 await 磁盘校验后会看到后到
  // 调用置的 waiting、与后到调用一起入队，同一任务在队列里出现两次、并行
  // 写同一文件。入队前再查一次队列：先到者已入队时后到者直接返回。检查与
  // push 之间无 await、是同一同步块，原子性成立；若先到者已出队开下，
  // 状态已同步变为 downloading，上面的状态检查已把后到者拦下（updateTask
  // 是同步 Object.assign，startDownload 首行即置 downloading）。此处只
  // return、不清 resumeCompleteFiles——已入队的调用拥有该登记，清掉会让
  // 它丢掉快路径、把完整文件重下一遍。
  if (taskQueue.some(t => t.id === task.id)) return
  taskQueue.push(freshTask)
  processQueue()
}

export const addTask = async(
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

  const taskId = toMD5(`${musicInfo.id}-${quality}`)
  const existingTask = downloadState.tasks.find(t => t.id === taskId)
  if (existingTask || addingTaskIds.has(taskId)) {
    if (!silent) {
      if (existingTask?.status === 'completed') toast('这首歌已下载，去「本地与下载」里听吧')
      else if (existingTask?.status === 'downloading' || existingTask?.status === 'waiting') toast('已在下载队列中')
      else toast('任务已存在，在「本地与下载」的下载标签里可继续')
    }
    return
  }

  // 4-3：磁盘校验是异步的——先登记入队中 id，写 store 后再注销，
  // 否则连点时两通调用都会通过上面的重任务检查、重复入队
  addingTaskIds.add(taskId)
  try {
    // 4-3(a)：磁盘已有同名文件时不静默覆盖——跳过并提示（手动拷入/旧残留
    // 的同名文件此前会被下载直写或改名前 unlink 覆盖）。D-4：删已完成记录
    // 不删文件，删记录后重下会被这条拦住；提示里说明绕过方法——本地列表
    // 的批量删除会删磁盘文件（LocalDownload handleDeleteSelected），删掉
    // 文件后再下即可。不改成静默覆盖，4-3(a) 的本意保留。
    if (await existsFile(filePath).catch(() => false)) {
      if (!silent) toast('本地已有同名文件，跳过下载；如需重下，请先在「本地与下载」里删除这首歌', 'long')
      return
    }

    const task: DownloadTask = {
      id: taskId,
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

    // 中：批量入队（silent 且批次进行中）盖戳，成败只计入所属批次
    if (silent && batchState) batchTaskIds.add(task.id)
    downloadActions.addTask(task)
    taskQueue.push(task)
    processQueue()
  } finally {
    addingTaskIds.delete(taskId)
  }
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
  // 4-4：同理清掉恢复快路径登记——任务在 waiting 队列里被删时登记还在，
  // 同歌同音质重下会命中残留登记、跳过下载却拿到已被删掉的文件
  resumeCompleteFiles.delete(id)
  // 多线程（2026-11-12）：按任务 id 查它自己的 RNFS job（取链阶段还没建下载
  // 对象时 Map 里没有，in-flight 的 startDownload 会按 cancelledTaskIds 收尾）
  const downloadJob = activeDownloadJobs.get(id)
  if (downloadJob && taskToRemove && taskToRemove.status === 'downloading') {
    const jobId = downloadJob.jobId
    if (typeof jobId === 'number') {
      stopDownload(jobId)
    }
    if (taskToRemove.filePath) {
      void unlink(taskToRemove.filePath).catch(() => {})
      cleanupDownloadTempFiles(taskToRemove)
      console.log(`[Download Manager] Canceled and deleted partial file: ${taskToRemove.filePath}`)
    }
  } else if (taskToRemove && taskToRemove.status !== 'completed' && taskToRemove.filePath) {
    void unlink(taskToRemove.filePath).catch(() => {})
    cleanupDownloadTempFiles(taskToRemove)
  }
  const taskIndex = taskQueue.findIndex(t => t.id === id)
  if (taskIndex > -1) taskQueue.splice(taskIndex, 1)
  downloadActions.removeTask(id)
  // 2026-10-05 fix（P1-5）+ 2026-11-12 多线程：不要碰 activeTaskIds、不要调
  // processQueue()——进行中的下载其 runDownloadTask finally 本来就会删 active
  // 并泵送下一个；无条件删/泵会导致重复拉起或排空误判。
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
  // 全部任务瞬间失败/未入队等极端情况：runDownloadTask 的 finally 不会再被触发，
  // 这里补一次排空检查
  maybeReportBatchDrain()
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
