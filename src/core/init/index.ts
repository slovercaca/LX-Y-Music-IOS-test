import { initSetting, showPactModal, updateSetting } from '@/core/common'
import registerPlaybackService from '@/plugins/player/service'
import initTheme from './theme'
import initI18n from './i18n'
import initUserApi from './userApi'
import initPlayer from './player'
import dataInit from './dataInit'
import initSync from './sync'
import initCommonState from './common'
import { initDeeplink } from './deeplink'
import { setApiSource } from '@/core/apiSource'
import commonActions from '@/store/common/action'
import settingState from '@/store/setting/state'
import { bootLog } from '@/utils/bootLog'
import { cheatTip } from '@/utils/tools'
import initUiMode from './uiMode'
import { Platform } from 'react-native'
import RNFS from 'react-native-fs'
import { mkdir, readDir, moveFile, existsFile, unlink } from '@/utils/fs'
import { getDefaultDownloadPath } from '@/utils/downloadPath'
import { getDownloadTasks, saveDownloadTasks } from '@/utils/data/download'
import downloadActions from '@/store/download/action'
import { startCookieKeepAlive } from '@/utils/cookieKeepAlive'
import { withTimeout } from '@/utils/withTimeout'
import defaultSetting from '@/config/defaultSetting'

let isFirstPush = true
const handlePushedHomeScreen = async() => {
  await cheatTip()
  const isAgreePact = !!settingState.setting['common.isAgreePact']
  if (isAgreePact) {
    if (isFirstPush) {
      isFirstPush = false
      void initDeeplink()
    }
  } else {
    if (isFirstPush) isFirstPush = false
    showPactModal()
  }

  // 公告已改为本地固定内容，且只在「首次安装 + 签署许可协议之后」弹一次
  // （由协议弹窗在接受后触发检查，见 PactModal.scheduleAnnouncementCheckAfterPact），
  // 这里不再做启动检查：已同意协议的老用户不会在更新后突然被弹公告。
  // 若将来又要向老用户推送新公告，需要在这里恢复一次检查（并把 utils/announcement 的
  // announcementId 改掉，本地已展示 ID 不一致时才会弹）。
}

let isInited = false
export default async() => {
  if (isInited) return handlePushedHomeScreen
  bootLog('Initing...')
  commonActions.setFontSize(global.lx.fontSize)
  bootLog('Font size changed.')
  const setting = await withTimeout(initSetting(), 'Setting', defaultSetting)
  bootLog('Setting inited.')
  // console.log(setting)

  await withTimeout(initTheme(setting), 'Theme', undefined)
  bootLog('Theme inited.')
  await withTimeout(initI18n(setting), 'I18n', undefined)
  bootLog('I18n inited.')

  await withTimeout(initUserApi(setting), 'User Api', undefined)
  bootLog('User Api inited.')

  initUiMode()
  bootLog('Ui Mode inited.')

  setApiSource(setting['common.apiSource'])
  bootLog('Api inited.')

  registerPlaybackService()
  bootLog('Playback Service Registered.')
  await withTimeout(initPlayer(setting), 'Player', undefined)
  bootLog('Player inited.')
  // 中存疑-24：两步必须串行——dataInit 把下载任务读进内存，initDownloadPath 做
  // 路径迁移并写回。此前并发：时序不利时内存里还是旧路径的任务，后续保存会把
  // 旧路径写回磁盘、抵消本次迁移（已迁移歌曲被误判 missing）。
  void (async() => {
    try {
      await dataInit(setting)
      bootLog('Data inited.')
    } catch (err: any) {
      bootLog(`Data init failed: ${err?.stack ?? err?.message ?? err}`)
    }
    try {
      await initDownloadPath(setting)
      bootLog('Download path inited.')
    } catch (err: any) {
      bootLog(`Download path init failed: ${err?.stack ?? err?.message ?? err}`)
    }
  })()
  await withTimeout(initCommonState(setting), 'Common State', undefined)
  bootLog('Common State inited.')

  void initSync(setting)
  bootLog('Sync inited.')

  startCookieKeepAlive()
  bootLog('Cookie keepalive inited.')

  // syncSetting()

  isInited ||= true

  return handlePushedHomeScreen
}

/**
 * 初始化下载目录：
 * - 若设置中无 download.path，则预创建默认下载目录「本地」，确保「文件」App 中可见。
 * - iOS 上迁移历史下载文件到「本地」文件夹：
 *   1. 旧默认目录 `${Documents}/LX-Y Music` 内全部文件；
 *   2. 早期版本散落在 Documents 根目录的下载文件（以下载任务记录为准，
 *      连同同名 .lrc 歌词一并移动）。
 *   迁移后同步改写下载任务的 filePath，保证列表内文件继续可播。
 */
const initDownloadPath = async(_setting: LX.AppSetting) => {
  const defaultPath = getDefaultDownloadPath()

  // 预创建默认下载目录（无论当前是否使用默认路径，都确保其存在）。
  try {
    await mkdir(defaultPath)
  } catch (err) {
    console.error('[Download Path] Failed to create default download directory:', err)
  }

  if (Platform.OS !== 'ios') return

  const movedPaths = new Map<string, string>()

  // 1) 迁移旧默认目录 `${Documents}/LX-Y Music` 内的全部文件
  const oldDefaultPath = `${RNFS.DocumentDirectoryPath}/LX-Y Music`
  try {
    if (await existsFile(oldDefaultPath)) {
      const items = await readDir(oldDefaultPath)
      for (const item of items) {
        if (item.isDirectory) continue
        const targetPath = `${defaultPath}/${item.name}`
        try {
          await moveFile(item.path, targetPath)
          movedPaths.set(item.path, targetPath)
        } catch (moveErr) {
          console.warn(`[Download Path] Failed to move ${item.path} to ${targetPath}:`, moveErr)
        }
      }
      // 中：此前只要旧目录存在就无条件把 download.path 重置为空——
      // 空目录永不删除，于是每次启动都重置，经同步/备份带入的自定义
      // 下载路径永远存不住。只在真迁移了文件、或设置正指向旧目录时
      // 才重置；迁完删掉旧空目录，下次启动不再进入本分支。
      const currentPath = (_setting['download.path'] ?? '').trim()
      if (movedPaths.size > 0 || currentPath.startsWith(oldDefaultPath)) {
        updateSetting({ 'download.path': '' })
      }
      if (movedPaths.size > 0) {
        await unlink(oldDefaultPath).catch(() => {})
        console.log('[Download Path] Migrated legacy download directory into 本地.')
      }
    }
  } catch (err) {
    console.error('[Download Path] Failed to migrate legacy download directory:', err)
  }

  // 2) 迁移散落在 Documents 根目录的下载文件（按下载任务记录精确移动）
  try {
    const tasks = await getDownloadTasks()
    let changed = false
    for (const task of tasks) {
      const filePath = task.filePath
      if (!filePath || !filePath.startsWith(`${RNFS.DocumentDirectoryPath}/`)) continue
      if (filePath.startsWith(`${defaultPath}/`)) continue
      if (movedPaths.has(filePath)) {
        task.filePath = movedPaths.get(filePath)!
        changed = true
        continue
      }
      const targetPath = `${defaultPath}/${filePath.split('/').pop()}`
      try {
        if (await existsFile(filePath)) {
          await moveFile(filePath, targetPath)
          movedPaths.set(filePath, targetPath)
          // 同名 .lrc 歌词一并迁移
          const lrcPath = filePath.replace(/\.[^/.]+$/, '.lrc')
          if (lrcPath !== filePath && (await existsFile(lrcPath).catch(() => false))) {
            await moveFile(lrcPath, targetPath.replace(/\.[^/.]+$/, '.lrc')).catch(() => {})
          }
          // P0（2026-10-12）：只有文件真实存在并移动成功，才改写任务路径。
          // 之前无条件改写，导致源文件不存在时任务指向一个空位置，离线无法播放。
          task.filePath = targetPath
          changed = true
        }
      } catch (moveErr) {
        console.warn(`[Download Path] Failed to move ${filePath} to ${targetPath}:`, moveErr)
      }
    }
    if (changed) {
      await saveDownloadTasks(tasks)
      downloadActions.setTasks(await getDownloadTasks())
      console.log('[Download Path] Rewrote download task paths into 本地.')
    }
  } catch (err) {
    console.error('[Download Path] Failed to migrate stray download files:', err)
  }

  // 3) 修复已被旧版迁移写坏的任务路径（P0，2026-10-12）。
  // 旧版无条件改写 task.filePath，导致部分任务指向不存在的位置。
  // 按文件名在下载目录/旧目录/Documents 根逐个找回，修复任务路径。
  try {
    const tasks = await getDownloadTasks()
    let repaired = false
    const legacyPath = `${RNFS.DocumentDirectoryPath}/LX-Y Music`
    const docRoot = RNFS.DocumentDirectoryPath
    for (const task of tasks) {
      const filePath = task.filePath
      if (!filePath) continue
      if (await existsFile(filePath).catch(() => false)) continue
      const baseName = filePath.split('/').pop()
      if (!baseName) continue
      const candidates = [
        `${defaultPath}/${baseName}`,
        `${defaultPath}/music/${baseName}`,
        `${defaultPath}/本地/${baseName}`,
        `${legacyPath}/${baseName}`,
        `${docRoot}/${baseName}`,
      ]
      for (const candidate of candidates) {
        if (candidate === filePath) continue
        if (await existsFile(candidate).catch(() => false)) {
          console.log('[Download Path] Repaired task path:', filePath, '->', candidate)
          task.filePath = candidate
          repaired = true
          break
        }
      }
    }
    if (repaired) {
      await saveDownloadTasks(tasks)
      downloadActions.setTasks(await getDownloadTasks())
      console.log('[Download Path] Repaired broken download task paths.')
    }
  } catch (err) {
    console.error('[Download Path] Failed to repair download task paths:', err)
  }

  // 4) 统一本地库结构（2026-10-22）：根目录平铺的音频/歌词/封面分别搬进
  //    music/、lrc/、picture/；旧「本地」子文件夹（旧版“本地”页扫描目录）
  //    里的文件一并归位。搬移后同步改写下载任务 filePath，保证继续可播。
  //    幂等：已在子目录内的不动；目标同名已存在时跳过（不覆盖）。
  try {
    const root = (_setting['download.path'] ?? '').trim() || defaultPath
    const musicDir = `${root}/music`
    const lrcDir = `${root}/lrc`
    const pictureDir = `${root}/picture`
    await mkdir(musicDir).catch(() => {})
    await mkdir(lrcDir).catch(() => {})
    await mkdir(pictureDir).catch(() => {})

    const audioExts = new Set(['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'ape'])
    const picExts = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'heic', 'heif', 'avif'])
    const moved = new Map<string, string>()

    const sweepDir = async(dir: string) => {
      const items = await readDir(dir).catch(() => [])
      for (const item of items) {
        if (!item.isFile) continue
        const ext = item.name.split('.').pop()?.toLowerCase() || ''
        const targetDir = audioExts.has(ext) ? musicDir : ext === 'lrc' ? lrcDir : picExts.has(ext) ? pictureDir : null
        if (!targetDir) continue
        if (item.path.startsWith(`${targetDir}/`)) continue
        const targetPath = `${targetDir}/${item.name}`
        if (await existsFile(targetPath).catch(() => false)) continue
        try {
          await moveFile(item.path, targetPath)
          moved.set(item.path, targetPath)
        } catch (moveErr) {
          console.warn(`[Download Path] Structure migrate failed ${item.path} -> ${targetPath}:`, moveErr)
        }
      }
    }

    await sweepDir(root)
    // 旧「本地」子文件夹（root 本身已是该文件夹时不重复处理）
    const legacyLocalDir = `${root}/本地`
    if (legacyLocalDir !== root) await sweepDir(legacyLocalDir)

    if (moved.size > 0) {
      const tasks = await getDownloadTasks()
      let changed = false
      for (const task of tasks) {
        const next = task.filePath ? moved.get(task.filePath) : undefined
        if (next) {
          task.filePath = next
          changed = true
        }
      }
      if (changed) {
        await saveDownloadTasks(tasks)
        downloadActions.setTasks(await getDownloadTasks())
      }
      console.log(`[Download Path] Structure migrated ${moved.size} files into music/lrc/picture.`)
      // 一次性提示标记（D17）：文件被搬走后用户在「文件」App 里会以为歌丢了，
      // 由本地列表页消费该标记弹一次说明后清除
      try {
        const { saveData } = await import('@/plugins/storage')
        await saveData('library_structure_migrated_notice', true)
      } catch {}
    }
  } catch (err) {
    console.error('[Download Path] Failed to migrate library structure:', err)
  }
}
