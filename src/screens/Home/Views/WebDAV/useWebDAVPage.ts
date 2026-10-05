import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, type FlatList, type TextInput } from 'react-native'
import { confirmDialog, toast, getRowInfo } from '@/utils/tools'
import { LIST_IDS } from '@/config/constant'
import { overwriteListMusics } from '@/core/list'
import { playList } from '@/core/player/player'
import { addTempPlayList } from '@/core/player/tempPlayList'
import { useHorizontalMode } from '@/utils/hooks'
import { usePlayMusicInfo } from '@/store/player/hook'
import { useDownloadTasks } from '@/store/download/hook'
import playerState from '@/store/player/state'
import {
  fetchWebDAVPic,
  getWebDAVConfig,
  listWebDAVFolders,
  saveWebDAVFilterPath,
  saveWebDAVSelectedFolder,
  scanWebDAVSongs,
  updateWebDAVMusicMeta,
  checkWebDAVRemoteExists,
  joinWebDAVRemotePath,
  getWebDAVMusicDir,
  uploadWebDAVMusicFile,
  type WebDAVUploadItem,
} from '@/core/webdavMusic/drive'
import { testConnection, resetClient } from '@/utils/webdav'
import { existsFile, selectFile, stat, unlink } from '@/utils/fs'
import { readMetadata, readPic } from '@/utils/localMediaMetadata'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import {
  handleWebDAVDownload,
  handleFetchWebDAVPicFromOnline,
  handleWebDAVRemove,
  handleWebDAVDownloadAndImport,
} from './WebDAVListAction'
import type { WebDAVListMenuType, SelectInfo as WebDAVSelectInfo } from './WebDAVListMenu'

export type ActiveTab = 'config' | 'list' | 'folders' | 'upload'

export interface UploadProgress {
  current: number
  total: number
  fileName: string
  fileSize: number
  uploadedSize: number
  totalSize: number
}

/**
 * WebDAV 页面状态与逻辑（从旧 index.tsx 提取）。
 * 四个 tab（列表/目录/上传/配置）共用这一个 hook，UI 只负责渲染。
 */
export function useWebDAVPage() {
  const playMusicInfo = usePlayMusicInfo()
  const [activeTab, setActiveTab] = useState<ActiveTab>('list')

  // 未配置时不让进上传 tab（旧 TabButton onPress 里的守卫，收拢到这里）
  const webdavUrl = useSettingValue('sync.webdav.url')
  const webdavUsername = useSettingValue('sync.webdav.username')
  const hasConfig = !!(webdavUrl && webdavUsername)
  const selectTab = useCallback((tab: ActiveTab) => {
    if (tab === 'upload' && !hasConfig) {
      toast(global.i18n.t('webdav_upload_config_first'))
      setActiveTab('config')
      return
    }
    setActiveTab(tab)
  }, [hasConfig])

  // ---------------- 歌曲列表 ----------------
  const [loading, setLoading] = useState(false)
  const [songs, setSongs] = useState<LX.WebDAV.MusicInfo[]>([])
  const [scannedAt, setScannedAt] = useState<number | undefined>()
  const [filterPath, setFilterPath] = useState<string | null>(null)
  const [scanText, setScanText] = useState('')
  const [searchVisible, setSearchVisible] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [batchLoadingText, setBatchLoadingText] = useState('')
  const listRef = useRef<FlatList<LX.WebDAV.MusicInfo>>(null)
  const searchInputRef = useRef<TextInput>(null)
  const pendingJumpIdRef = useRef<string | null>(null)
  const webDAVListMenuRef = useRef<WebDAVListMenuType>(null)
  const metadataEditTypeRef = useRef<any>(null)
  const selectedMusicInfoRef = useRef<LX.WebDAV.MusicInfo | null>(null)

  // ---------------- 目录浏览 ----------------
  const [folderStack, setFolderStack] = useState<LX.WebDAV.DriveFolder[]>([])
  const [folders, setFolders] = useState<LX.WebDAV.DriveFolder[]>([])
  const [selectedFolder, setSelectedFolder] = useState<LX.WebDAV.DriveFolder | null>(null)
  const [folderLoading, setFolderLoading] = useState(false)
  const currentFolder = folderStack.at(-1) ?? null

  // ---------------- 上传 ----------------
  const [uploadFiles, setUploadFiles] = useState<WebDAVUploadItem[]>([])
  const [uploadPickerExpanded, setUploadPickerExpanded] = useState(false)
  const [uploadCheckedIds, setUploadCheckedIds] = useState<Set<string>>(new Set())
  const uploadTempFilesRef = useRef<Set<string>>(new Set())
  const uploadingRef = useRef(false)
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null)
  const [uploadWithLyrics, setUploadWithLyrics] = useState(true)

  // ---------------- 配置 ----------------
  const webdavPassword = useSettingValue('sync.webdav.password')
  const webdavMediaSource = useSettingValue('webdav.mediaSource')
  const [isTesting, setIsTesting] = useState(false)

  // ================= 派生 =================

  const filteredSongs = useMemo(() => {
    let list = songs
    if (filterPath) {
      list = list.filter(song => {
        const path = song.meta.remotePath
        if (!path) return false
        const lastSlashIndex = path.lastIndexOf('/')
        const folderPath = path.substring(0, lastSlashIndex) || '/'
        return folderPath === filterPath
      })
    }
    const text = searchText.trim().toLowerCase()
    if (!text) return list
    return list.filter((item) => {
      return [
        item.name,
        item.singer,
        item.meta.fileName,
        item.meta.filePath,
        item.meta.remotePath,
      ].some(value => (value ?? '').toLowerCase().includes(text))
    })
  }, [searchText, songs, filterPath])

  const songFolders = useMemo(() => {
    const foldersMap = new Map<string, { name: string, path: string, count: number }>()
    songs.forEach(song => {
      const path = song.meta.remotePath
      if (!path) return
      const lastSlashIndex = path.lastIndexOf('/')
      if (lastSlashIndex === -1) return
      const folderPath = path.substring(0, lastSlashIndex) || '/'
      const folderName = folderPath === '/' ? '根目录' : (folderPath.split('/').pop() || '未知目录')

      const existing = foldersMap.get(folderPath)
      if (existing) {
        existing.count++
      } else {
        foldersMap.set(folderPath, { name: folderName, path: folderPath, count: 1 })
      }
    })
    return Array.from(foldersMap.values()).sort((a, b) => a.path.localeCompare(b.path))
  }, [songs])

  const headerText = useMemo(() => {
    if (batchLoadingText) return batchLoadingText
    if (searchText.trim()) return `${filteredSongs.length}/${songs.length} 首`
    return `${songs.length} 首${scannedAt ? ` · ${new Date(scannedAt).toLocaleString()}` : ''}`
  }, [batchLoadingText, filteredSongs.length, scannedAt, searchText, songs.length])

  // 上传目标目录：当前选中的文件夹，无选择时为根目录
  const uploadTargetDir = useMemo(
    () => selectedFolder?.path || '/',
    [selectedFolder],
  )

  // 列数响应式（对齐 OnlineList）：iPad 横屏/分屏时双列，避免歌曲行在超宽屏上
  // 被拉得过长、左右留白；竖屏保持单列零回归。
  // numColumns 变更时 FlatList 必须重挂载（RN 不支持运行中改列数），故加 key。
  const isHorizontal = useHorizontalMode()
  const rowInfo = useMemo(() => {
    void isHorizontal
    return getRowInfo()
  }, [isHorizontal])
  const numColumns = rowInfo.rowNum ?? 1

  // ================= 歌曲/封面 =================

  const syncSongsCover = useCallback(async(songList: LX.WebDAV.MusicInfo[]) => {
    // 仅补充网盘内封面（快速直连下载到本地），不触发全平台搜索；
    // 全平台封面由播放详情页按需获取。限制并发 4，避免批量下载风暴。
    let index = 0
    const workers = Array.from({ length: 4 }, async() => {
      while (index < songList.length) {
        const i = index++
        const song = songList[i]
        if (song.meta.picUrl) continue
        try {
          const picUrl = await fetchWebDAVPic(song)
          if (picUrl) {
            songList[i] = { ...song, meta: { ...song.meta, picUrl } }
          }
        } catch {
          // ignore error
        }
      }
    })
    await Promise.all(workers)
    setSongs([...songList])
  }, [])

  const loadConfig = useCallback(async() => {
    return getWebDAVConfig().then(config => {
      setSelectedFolder(config.selectedFolder ?? null)
      const songs = config.songs ?? []
      setSongs(songs)
      setScannedAt(config.scannedAt)
      setFilterPath(config.filterPath ?? null)
      void syncSongsCover(songs)
    })
  }, [syncSongsCover])

  const handleSetFilterPath = useCallback((path: string | null) => {
    setFilterPath(path)
    void saveWebDAVFilterPath(path)
  }, [])

  // ================= 配置页动作 =================

  // 连接配置：与「设置 → 数据同步 → WebDAV 同步」共用 sync.webdav.* 同一批键，
  // 写完立刻 resetClient()，让页面内的目录浏览/扫描/下载用上新凭据。
  const handleWebdavSettingChanged = useCallback(
    (key: 'sync.webdav.url' | 'sync.webdav.username' | 'sync.webdav.password') =>
      (text: string, callback: (value: string) => void) => {
        updateSetting({ [key]: text })
        resetClient()
        callback(text)
      },
    [],
  )

  const handleWebdavMediaSourceChanged = useCallback((source: 'file' | 'online') => {
    updateSetting({ 'webdav.mediaSource': source })
    toast(source === 'file' ? '已切换为从歌曲文件获取封面歌词' : '已切换为从云端插件获取封面歌词')
  }, [])

  const handleTestConnection = useCallback(async() => {
    if (isTesting) return
    setIsTesting(true)
    toast('正在测试连接...')
    try {
      await testConnection()
      toast('连接成功！')
    } catch (error: any) {
      toast(`连接失败：${error.message}`, 'long')
    } finally {
      setIsTesting(false)
    }
  }, [isTesting])

  // ================= 目录页动作 =================

  const loadFolders = useCallback((folder: LX.WebDAV.DriveFolder | null) => {
    setFolderLoading(true)
    void listWebDAVFolders(folder)
      .then(setFolders)
      .catch((err: any) => {
        const message = err.message ?? String(err)
        toast(message, 'long')
      })
      .finally(() => {
        setFolderLoading(false)
      })
  }, [])

  const handleSelectCurrentFolder = useCallback(() => {
    setLoading(true)
    void saveWebDAVSelectedFolder(currentFolder)
      .then((config) => {
        setSelectedFolder(config.selectedFolder ?? null)
        toast(`已选择：${config.selectedFolder?.path || 'WebDAV 根目录'}`)
      })
      .catch((err: any) => {
        toast(err.message ?? String(err), 'long')
      })
      .finally(() => {
        setLoading(false)
      })
  }, [currentFolder])

  const enterFolder = useCallback((folder: LX.WebDAV.DriveFolder) => {
    setFolderStack(prev => [...prev, folder])
  }, [])

  const goBackFolder = useCallback(() => {
    setFolderStack(prev => prev.slice(0, -1))
  }, [])

  // ================= 扫描 / 刷新 =================

  const handleScan = useCallback(() => {
    if (!hasConfig) {
      toast(global.i18n.t('webdav_upload_config_first'))
      setActiveTab('config')
      return
    }
    const runScan = () => {
      setLoading(true)
      setScanText('开始扫描...')
      void scanWebDAVSongs(selectedFolder, (count, path) => {
        setScanText(`已找到 ${count} 首，正在扫描：${path}`)
      })
        .then((config) => {
          setSongs(config.songs ?? [])
          setScannedAt(config.scannedAt)
          setScanText('')
          setActiveTab('list')
          toast(`扫描完成：${config.songs.length} 首`)
        })
        .catch((err: any) => {
          const message = err.message ?? String(err)
          setScanText(message)
          toast(message, 'long')
        })
        .finally(() => {
          setLoading(false)
        })
    }
    if (!selectedFolder) {
      void confirmDialog({
        title: '扫描 WebDAV 根目录',
        message:
          '根目录扫描会递归读取所有子目录。文件夹很多时可能较慢。确定继续扫描根目录？',
        confirmButtonText: '继续扫描',
      }).then((confirmed) => {
        if (confirmed) runScan()
      })
      return
    }
    runScan()
  }, [hasConfig, selectedFolder])

  // 下拉刷新 = 重新读取**已下载到本地**文件的标签（联网扫描请用「扫描」按钮）。
  // 旧实现对所有歌曲都拿 meta.filePath 去 readMetadata —— 未下载时那是远程路径，
  // 必然读失败，却照样弹「标签加载完成」，看着像刷新了其实什么都没做。
  const handleRefresh = useCallback(() => {
    const localSongs = songs.filter(song => !!song.meta.filePath)
    if (!localSongs.length) {
      toast('没有已下载到本地的歌曲；联网扫描请点「扫描」', 'long')
      return
    }
    setLoading(true)
    setScanText(`正在读取 ${localSongs.length} 首本地文件的标签...`)
    void Promise.all(
      localSongs.map(async(song) => {
        if (!song.meta.filePath) return song
        try {
          const fileMetadata = await readMetadata(song.meta.filePath).catch(() => null)
          const picPath = await readPic(song.meta.filePath).catch(() => null)
          if (fileMetadata) {
            const updates: Record<string, any> = {}
            if (fileMetadata.albumName) updates.albumName = fileMetadata.albumName
            if (fileMetadata.name && !song.name) updates.name = fileMetadata.name
            if (fileMetadata.singer && !song.singer) updates.singer = fileMetadata.singer
            if (picPath) {
              const newPicUrl = picPath.startsWith('/') ? `file://${picPath}` : picPath
              updates.picUrl = newPicUrl
            }
            if (Object.keys(updates).length > 0) {
              await updateWebDAVMusicMeta(song.id, updates)
            }
          }
        } catch {
          // ignore
        }
        return song
      }),
    ).then(async() => {
      return getWebDAVConfig()
    }).then((config) => {
      setSongs(config.songs ?? [])
      setScanText('')
      toast(`已更新 ${localSongs.length} 首本地文件的标签`)
    }).catch((err: any) => {
      const message = err.message ?? String(err)
      setScanText(message)
      toast(message, 'long')
    }).finally(() => {
      setLoading(false)
    })
  }, [songs])

  // ================= 播放 / 菜单 =================

  const showMenu = useCallback(
    (musicInfo: LX.WebDAV.MusicInfo, index: number, position: { x: number, y: number, w: number, h: number }) => {
      webDAVListMenuRef.current?.show({ musicInfo, index }, position)
    },
    [],
  )

  const handlePlay = useCallback(
    (musicInfo: LX.WebDAV.MusicInfo) => {
      const index = songs.findIndex(item => item.id === musicInfo.id)
      if (index < 0) return
      void overwriteListMusics(LIST_IDS.TEMP, songs).then(() => {
        void playList(LIST_IDS.TEMP, index).then(() => {
          void (async() => {
            const config = await getWebDAVConfig()
            const updatedSongs = config.songs ?? []
            setSongs(updatedSongs)
            void syncSongsCover(updatedSongs)
          })()
        })
      })
    },
    [songs, syncSongsCover],
  )

  const patchSongInList = useCallback((musicId: string, patch: (song: LX.WebDAV.MusicInfo) => LX.WebDAV.MusicInfo) => {
    setSongs(prevSongs => prevSongs.map(song => (song.id === musicId ? patch(song) : song)))
  }, [])

  const handlePlayLater = useCallback((info: WebDAVSelectInfo) => {
    addTempPlayList([{ listId: null, musicInfo: info.musicInfo }])
    toast('已添加到稍后播放')
  }, [])

  const handleLoadMetadata = useCallback(async(info: WebDAVSelectInfo) => {
    const musicInfo = info.musicInfo
    if (!musicInfo.meta.filePath) {
      toast('请先下载歌曲')
      return
    }
    try {
      toast('正在读取标签...')
      const fileMetadata = await readMetadata(musicInfo.meta.filePath)
      const picPath = await readPic(musicInfo.meta.filePath).catch(() => null)

      if (!fileMetadata) {
        toast('没有找到标签信息')
        return
      }

      const updates: Record<string, any> = {}
      if (fileMetadata.albumName) updates.albumName = fileMetadata.albumName
      if (fileMetadata.name && !musicInfo.name) updates.name = fileMetadata.name
      if (fileMetadata.singer && !musicInfo.singer) updates.singer = fileMetadata.singer
      if (picPath) {
        const newPicUrl = picPath.startsWith('/') ? `file://${picPath}` : picPath
        updates.picUrl = newPicUrl
      }

      if (Object.keys(updates).length > 0) {
        await updateWebDAVMusicMeta(musicInfo.id, updates)
        patchSongInList(musicInfo.id, song => ({ ...song, ...updates, meta: { ...song.meta, ...updates } }))
        toast('标签加载成功')
      } else {
        toast('没有新的标签信息')
      }
    } catch (error: any) {
      toast(`加载标签失败：${error.message}`, 'long')
    }
  }, [patchSongInList])

  const handleDownload = useCallback((info: WebDAVSelectInfo) => {
    void handleWebDAVDownload(info.musicInfo).then((newPicUrl) => {
      if (newPicUrl) {
        patchSongInList(info.musicInfo.id, song => ({ ...song, meta: { ...song.meta, picUrl: newPicUrl } }))
      }
    })
  }, [patchSongInList])

  const handleFetchPicFromOnline = useCallback((info: WebDAVSelectInfo) => {
    void handleFetchWebDAVPicFromOnline(info.musicInfo).then((newPicUrl) => {
      patchSongInList(info.musicInfo.id, song => ({ ...song, meta: { ...song.meta, picUrl: newPicUrl } }))
    })
  }, [patchSongInList])

  const handleSpecifyPicFile = useCallback((info: WebDAVSelectInfo) => {
    void selectFile({ extTypes: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] })
      .then((res) => {
        if (!res?.path) return
        // picker 复制的临时文件长期保留（作为该歌曲的封面），不删除
        void updateWebDAVMusicMeta(info.musicInfo.id, { customPicPath: res.path })
          .then(() => {
            patchSongInList(info.musicInfo.id, song => ({ ...song, meta: { ...song.meta, customPicPath: res.path } }))
            toast('已指定封面文件')
          })
          .catch((err: any) => { toast(`保存失败：${err?.message ?? err}`, 'long') })
      })
      .catch((err: any) => {
        if (err?.code === 'picker_cancelled') return
        toast(`无法打开文件选择器：${err?.message ?? err}`, 'long')
      })
  }, [patchSongInList])

  const handleSpecifyLrcFile = useCallback((info: WebDAVSelectInfo) => {
    void selectFile({ extTypes: ['lrc'] })
      .then((res) => {
        if (!res?.path) return
        void updateWebDAVMusicMeta(info.musicInfo.id, { customLrcPath: res.path })
          .then(() => {
            patchSongInList(info.musicInfo.id, song => ({ ...song, meta: { ...song.meta, customLrcPath: res.path } }))
            toast('已指定歌词文件')
          })
          .catch((err: any) => { toast(`保存失败：${err?.message ?? err}`, 'long') })
      })
      .catch((err: any) => {
        if (err?.code === 'picker_cancelled') return
        toast(`无法打开文件选择器：${err?.message ?? err}`, 'long')
      })
  }, [patchSongInList])

  // 清除手动指定的封面/歌词，恢复自动获取（传 '' 才会走 delete 分支真正持久化清除）
  const handleClearCustomMedia = useCallback((info: WebDAVSelectInfo) => {
    void updateWebDAVMusicMeta(info.musicInfo.id, { customPicPath: '', customLrcPath: '' })
      .then(() => {
        patchSongInList(info.musicInfo.id, song => {
          const meta = { ...song.meta }
          delete meta.customPicPath
          delete meta.customLrcPath
          return { ...song, meta }
        })
        toast('已清除手动指定，恢复自动获取')
      })
      .catch((err: any) => { toast(`清除失败：${err?.message ?? err}`, 'long') })
  }, [patchSongInList])

  const handleEditMetadata = useCallback((info: WebDAVSelectInfo) => {
    const filePath = info.musicInfo.meta.filePath
    // 编辑标签只能改本地文件：未下载的歌曲 filePath 为空（旧数据里还可能是远程路径），
    // 直接弹编辑器会去读写一个根本不在本地的文件。
    if (!filePath) {
      toast('请先下载歌曲，再编辑标签')
      return
    }
    void existsFile(filePath).then((exists) => {
      if (!exists) {
        toast('本地文件不存在，请先下载', 'long')
        return
      }
      selectedMusicInfoRef.current = info.musicInfo
      metadataEditTypeRef.current?.show(filePath, info.musicInfo)
    })
  }, [])

  const handleUpdateMetadata = useCallback(() => {
    if (!selectedMusicInfoRef.current) return
    loadConfig().catch(() => {})
  }, [loadConfig])

  const handleRemove = useCallback((info: WebDAVSelectInfo) => {
    void handleWebDAVRemove(info.musicInfo).then(() => {
      setSongs(prevSongs => prevSongs.filter(song => song.id !== info.musicInfo.id))
    })
  }, [])

  // ================= 批量上传 =================

  /**
   * 批量上传：将本地音频文件逐个 PUT 到服务器目标目录。
   * - 先校验本地文件真实可读且大小 > 0（stat 失败/大小为 0 直接跳过）
   * - 超 100MB 先提醒（base64 中转内存）
   * - 先预检连通性：服务器不通/账号不对时直接报错，不走到后面逐个失败
   * - 先预检冲突（服务器已存在同名文件），有冲突时一次问清：覆盖全部 / 取消
   * - 逐个上传，失败的记下来继续传下一个，最后如实报告
   * - 全部完成后重新扫描当前目录，让新歌出现在列表里
   * 返回是否真正开始上传（供调用方决定是否清理队列）
   */
  const runWebDAVUpload = useCallback(async(
    items: WebDAVUploadItem[],
    onProgress?: (current: number, total: number, fileName: string) => void,
    withLyrics?: boolean,
  ): Promise<boolean> => {
    const validItems: WebDAVUploadItem[] = []
    const invalidNames: string[] = []
    for (const item of items) {
      try {
        const info = await stat(item.localPath)
        if (info && !info.isDirectory && info.size > 0) {
          validItems.push({ ...item, size: info.size })
        } else {
          invalidNames.push(item.fileName)
        }
      } catch {
        invalidNames.push(item.fileName)
      }
    }
    if (invalidNames.length > 0) {
      toast(`以下文件本地不可读，已跳过：${invalidNames.slice(0, 3).join('、')}${invalidNames.length > 3 ? `（等共 ${invalidNames.length} 个）` : ''}`, 'long')
    }
    if (validItems.length === 0) return false
    items = validItems
    const totalSize = items.reduce((sum, it) => sum + (it.size || 0), 0)
    // 超大文件走 base64 中转内存，100MB 以上先提醒
    if (totalSize > 100 * 1024 * 1024) {
      const confirmed = await confirmDialog({
        title: '文件较大',
        message: `本次共 ${items.length} 个文件，约 ${(totalSize / 1024 / 1024).toFixed(0)}MB。上传大文件较慢且耗内存，确定继续吗？`,
        confirmButtonText: '继续上传',
      })
      if (!confirmed) return false
    }

    // 先预检连通性：服务器不通/账号不对时直接报错，不走到后面逐个失败
    setBatchLoadingText('正在连接服务器...')
    try {
      await testConnection()
    } catch (err: any) {
      setBatchLoadingText('')
      toast(`无法连接 WebDAV 服务器：${err?.message ?? err}`, 'long')
      return false
    }

    setBatchLoadingText('正在检查服务器文件...')
    const conflicts: string[] = []
    for (const item of items) {
      // 冲突预检必须走统一目录语义（与 uploadWebDAVMusicFile 实际目标一致）
      const remotePath = joinWebDAVRemotePath(getWebDAVMusicDir(uploadTargetDir), item.fileName)
      if (await checkWebDAVRemoteExists(remotePath).catch(() => false)) {
        conflicts.push(item.fileName)
      }
    }
    if (conflicts.length > 0) {
      setBatchLoadingText('')
      const confirmed = await confirmDialog({
        title: '文件已存在',
        message: `服务器上已有 ${conflicts.length} 个同名文件${conflicts.length <= 3 ? `：${conflicts.join('、')}` : ''}，上传将覆盖它们。继续吗？`,
        confirmButtonText: '覆盖并上传',
      })
      if (!confirmed) return false
    }

    let success = 0
    const failed: string[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      setBatchLoadingText(`正在上传 ${i + 1}/${items.length}：${item.fileName}`)
      onProgress?.(i + 1, items.length, item.fileName)
      try {
        // 分阶段上报，卡在哪一步直接显示在按钮上
        await uploadWebDAVMusicFile(item, uploadTargetDir, withLyrics, (stage) => {
          setBatchLoadingText(`${stage} ${item.fileName}`)
        })
        success++
      } catch (err: any) {
        failed.push(`${item.fileName}（${err?.message ?? err}）`)
      }
    }
    setBatchLoadingText('')
    onProgress?.(items.length, items.length, '')

    if (failed.length > 0) {
      // 失败明细直接拼进 toast（long 时长），避免再弹一个对话框打断流程
      const failDetail = failed.slice(0, 3).join('；') + (failed.length > 3 ? `；等共 ${failed.length} 个` : '')
      toast(`上传完成：${success} 成功，${failed.length} 失败：${failDetail}`, 'long')
    } else {
      toast(`上传完成：${success} 个文件`)
    }

    // 重新扫描当前目录，让刚上传的歌曲出现在列表里
    if (success > 0) {
      setLoading(true)
      setScanText('正在刷新列表...')
      try {
        const config = await scanWebDAVSongs(selectedFolder, (count, path) => {
          setScanText(`已找到 ${count} 首，正在扫描：${path}`)
        })
        setSongs(config.songs ?? [])
        setScannedAt(config.scannedAt)
      } catch (err: any) {
        toast(err?.message ?? String(err), 'long')
      } finally {
        setScanText('')
        setLoading(false)
      }
    }
    return true
  }, [uploadTargetDir, selectedFolder])

  // ===== 上传 tab：队列管理 =====
  const downloadTasks = useDownloadTasks()
  // 已完成且有本地文件的下载任务才可加入上传队列
  const uploadableTasks = useMemo(
    () => downloadTasks.filter(t => t.status === 'completed' && t.filePath && t.fileName),
    [downloadTasks],
  )

  const toggleUploadCheck = useCallback((id: string) => {
    setUploadCheckedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleUploadCheckAll = useCallback(() => {
    setUploadCheckedIds(prev => {
      if (prev.size === uploadableTasks.length) return new Set<string>()
      return new Set(uploadableTasks.map(t => t.id))
    })
  }, [uploadableTasks])

  /** 从下载列表把勾选的文件加入上传队列 */
  const handleAddUploadFromDownloads = useCallback(() => {
    const items: WebDAVUploadItem[] = uploadableTasks
      .filter(t => uploadCheckedIds.has(t.id))
      .map(t => ({
        localPath: t.filePath!,
        fileName: t.fileName!,
        size: t.progress?.total || 0,
      }))
    if (items.length === 0) {
      toast('请先勾选要上传的文件')
      return
    }
    setUploadFiles(prev => {
      const existing = new Set(prev.map(f => f.localPath))
      const newItems = items.filter(it => !existing.has(it.localPath))
      return [...prev, ...newItems]
    })
    setUploadCheckedIds(new Set())
    setUploadPickerExpanded(false)
    toast(`已添加 ${items.length} 个文件到上传队列`)
  }, [uploadableTasks, uploadCheckedIds])

  /** 从文件 App 选择文件，加入上传队列（不立即上传） */
  const handleAddUploadFromFilePicker = useCallback(() => {
    void selectFile({ extTypes: ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'ape'] })
      .then((res) => {
        if (!res?.path) return
        const fileName = res.name || res.path.split('/').pop() || 'unknown'
        // 注意：picker 复制的临时文件在上传完成后删除（见 handleStartUpload）；
        // 若用户未上传就离开 tab，由 uploadTempFilesRef 的清理 effect 删除。
        uploadTempFilesRef.current.add(res.path)
        setUploadFiles(prev => {
          if (prev.some(f => f.localPath === res.path)) {
            toast('该文件已在队列中')
            return prev
          }
          return [...prev, { localPath: res.path!, fileName, size: res.size || 0 }]
        })
      })
      .catch((err: any) => {
        if (err?.code === 'picker_cancelled') return
        toast(`无法打开文件选择器：${err?.message ?? err}`, 'long')
      })
  }, [])

  const handleRemoveUploadFile = useCallback((localPath: string) => {
    setUploadFiles(prev => {
      const target = prev.find(f => f.localPath === localPath)
      // 如果是文件 App 选的临时文件，从队列移除时顺手删掉，避免 tmp 堆积
      if (target && uploadTempFilesRef.current.has(target.localPath)) {
        uploadTempFilesRef.current.delete(target.localPath)
        void unlink(target.localPath).catch(() => {})
      }
      return prev.filter(f => f.localPath !== localPath)
    })
  }, [])

  /** 手动清空上传队列（含临时文件清理） */
  const handleClearUploadQueue = useCallback(() => {
    for (const p of uploadTempFilesRef.current) {
      void unlink(p).catch(() => {})
    }
    uploadTempFilesRef.current.clear()
    setUploadFiles([])
    toast(global.i18n.t('webdav_upload_cleared'))
  }, [])

  /** 开始上传队列中的文件 */
  const handleStartUpload = useCallback(async() => {
    if (uploadFiles.length === 0) {
      toast(global.i18n.t('webdav_upload_need_files'))
      return
    }
    const totalSize = uploadFiles.reduce((sum, f) => sum + (f.size || 0), 0)
    setUploadProgress({ current: 0, total: uploadFiles.length, fileName: '', fileSize: 0, uploadedSize: 0, totalSize })
    let started = false
    uploadingRef.current = true
    try {
      started = await runWebDAVUpload(uploadFiles, (current, total, fileName) => {
        // 找到当前文件的大小，累加已上传
        const idx = current - 1
        const fileSize = idx >= 0 && idx < uploadFiles.length ? (uploadFiles[idx].size || 0) : 0
        // uploadedSize 是之前所有文件的大小之和
        const prevSize = uploadFiles.slice(0, idx).reduce((sum, f) => sum + (f.size || 0), 0)
        setUploadProgress({ current, total, fileName, fileSize, uploadedSize: prevSize, totalSize })
      }, uploadWithLyrics)
    } finally {
      uploadingRef.current = false
      setUploadProgress(null)
    }
    // 仅真正开始上传后才清理队列；取消/连接失败时保留队列，用户可手动清空或重试
    if (started) {
      for (const p of uploadTempFilesRef.current) {
        void unlink(p).catch(() => {})
      }
      uploadTempFilesRef.current.clear()
      setUploadFiles([])
    }
  }, [uploadFiles, runWebDAVUpload, uploadWithLyrics])

  const handleBatchDownload = useCallback(() => {
    if (!hasConfig) {
      toast(global.i18n.t('webdav_upload_config_first'))
      setActiveTab('config')
      return
    }
    void confirmDialog({
      title: '扫描并下载',
      message: '此操作将先扫描 WebDAV 目录，然后下载所有扫描到的歌曲。下载后的歌曲将添加到下载列表中，并自动读取音乐标签。',
      confirmButtonText: '开始扫描并下载',
    }).then((confirmed) => {
      if (!confirmed) return

      setLoading(true)
      setScanText('开始扫描...')
      void scanWebDAVSongs(selectedFolder, (count, path) => {
        setScanText(`已找到 ${count} 首，正在扫描：${path}`)
      })
        .then((config) => {
          const scannedSongs = config.songs ?? []
          setSongs(scannedSongs)
          setScannedAt(config.scannedAt)
          setScanText('')

          if (scannedSongs.length === 0) {
            toast('没有扫描到可下载的歌曲')
            return
          }

          void handleWebDAVDownloadAndImport(scannedSongs, setBatchLoadingText)
        })
        .catch((err: any) => {
          const message = err.message ?? String(err)
          setScanText(message)
          toast(message, 'long')
        })
        .finally(() => {
          setLoading(false)
        })
    })
  }, [hasConfig, selectedFolder])

  // 列表头「上传」按钮：跳上传 tab（守卫在 selectTab 里）
  const handleUpload = useCallback(() => {
    selectTab('upload')
  }, [selectTab])

  // ================= 搜索 =================

  const handleToggleSearch = useCallback(() => {
    setSearchVisible((visible) => {
      const nextVisible = !visible
      if (nextVisible) {
        requestAnimationFrame(() => {
          searchInputRef.current?.focus()
        })
      } else {
        setSearchText('')
        Keyboard.dismiss()
      }
      return nextVisible
    })
  }, [])

  const handleClearSearch = useCallback(() => {
    if (searchText) {
      setSearchText('')
      searchInputRef.current?.focus()
      return
    }
    setSearchVisible(false)
    Keyboard.dismiss()
  }, [searchText])

  // ================= 定位 =================

  const scrollToMusic = useCallback((musicId: string) => {
    let list = filteredSongs
    let index = list.findIndex(item => item.id === musicId)
    if (index < 0 && searchText) {
      setSearchText('')
      list = songs
      index = list.findIndex(item => item.id === musicId)
    }
    if (index < 0) return
    setActiveTab('list')
    requestAnimationFrame(() => {
      setTimeout(() => {
        listRef.current?.scrollToIndex({
          index,
          viewPosition: 0.3,
          animated: true,
        })
      }, searchText ? 160 : 80)
    })
  }, [filteredSongs, searchText, songs])

  // ================= effects =================

  useEffect(() => {
    loadConfig()
  }, [loadConfig])

  useEffect(() => {
    if (!hasConfig) return
    loadFolders(currentFolder)
  }, [hasConfig, currentFolder, loadFolders])

  // 离开上传 tab 时，删除文件 App 选的临时文件并同步清理队列，
  // 避免返回后队列指向已删除的文件；上传进行中时跳过清理
  useEffect(() => {
    if (activeTab !== 'upload' && !uploadingRef.current) {
      const deletedPaths = new Set(uploadTempFilesRef.current)
      for (const p of deletedPaths) {
        void unlink(p).catch(() => {})
      }
      uploadTempFilesRef.current.clear()
      if (deletedPaths.size > 0) {
        setUploadFiles(prev => prev.filter(f => !deletedPaths.has(f.localPath)))
      }
    }
  }, [activeTab])

  useEffect(() => {
    const handleWebdavPicUpdated = (musicId: string, picUrl: string) => {
      patchSongInList(musicId, song => ({ ...song, meta: { ...song.meta, picUrl } }))
    }

    global.app_event.on('webdavPicUpdated', handleWebdavPicUpdated)
    return () => {
      global.app_event.off('webdavPicUpdated', handleWebdavPicUpdated)
    }
  }, [patchSongInList])

  useEffect(() => {
    const handleJumpPosition = () => {
      const rawMusicInfo = playerState.playMusicInfo.musicInfo
      const musicInfo = rawMusicInfo && 'progress' in rawMusicInfo ? rawMusicInfo.metadata.musicInfo : rawMusicInfo
      if (!musicInfo) return
      pendingJumpIdRef.current = musicInfo.id
      scrollToMusic(musicInfo.id)
    }
    // @ts-expect-error - jumpWebDAVPosition is a custom event
    global.app_event.on('jumpWebDAVPosition', handleJumpPosition)
    return () => {
      // @ts-expect-error - jumpWebDAVPosition is a custom event
      global.app_event.off('jumpWebDAVPosition', handleJumpPosition)
    }
  }, [scrollToMusic])

  useEffect(() => {
    if (activeTab !== 'list' || !pendingJumpIdRef.current) return
    const musicId = pendingJumpIdRef.current
    pendingJumpIdRef.current = null
    scrollToMusic(musicId)
  }, [activeTab, scrollToMusic])

  // ================= 导出 =================

  return {
    // tab
    activeTab, selectTab,
    // 播放
    playMusicInfo: playMusicInfo.musicInfo,
    // 配置
    hasConfig, isTesting,
    webdavUrl, webdavUsername, webdavPassword, webdavMediaSource,
    handleWebdavSettingChanged, handleWebdavMediaSourceChanged, handleTestConnection,
    // 目录
    folderStack, folders, folderLoading, currentFolder, selectedFolder,
    enterFolder, goBackFolder, handleSelectCurrentFolder,
    songFolders, filterPath, handleSetFilterPath,
    // 列表
    loading, songs, filteredSongs, scannedAt, scanText, batchLoadingText,
    searchVisible, searchText, setSearchText,
    handleToggleSearch, handleClearSearch,
    handleScan, handleBatchDownload, handleRefresh, handleUpload,
    handlePlay, showMenu,
    listRef, searchInputRef,
    numColumns, rowWidth: rowInfo.rowWidth,
    headerText,
    // 上传
    uploadFiles, uploadPickerExpanded, setUploadPickerExpanded,
    uploadCheckedIds, toggleUploadCheck, toggleUploadCheckAll,
    uploadableTasks, uploadTargetDir,
    handleAddUploadFromDownloads, handleAddUploadFromFilePicker,
    handleRemoveUploadFile, handleClearUploadQueue, handleStartUpload,
    uploadProgress, uploadWithLyrics, setUploadWithLyrics,
    // 菜单 / 弹窗
    webDAVListMenuRef, metadataEditTypeRef, handleUpdateMetadata,
    menuHandlers: {
      onPlay: (info: WebDAVSelectInfo) => { handlePlay(info.musicInfo) },
      onPlayLater: handlePlayLater,
      onDownload: handleDownload,
      onFetchPicFromOnline: handleFetchPicFromOnline,
      onSpecifyPicFile: handleSpecifyPicFile,
      onSpecifyLrcFile: handleSpecifyLrcFile,
      onClearCustomMedia: handleClearCustomMedia,
      onEditMetadata: handleEditMetadata,
      onRemove: handleRemove,
      onLoadMetadata: handleLoadMetadata,
    },
  }
}

export type WebDAVPage = ReturnType<typeof useWebDAVPage>
