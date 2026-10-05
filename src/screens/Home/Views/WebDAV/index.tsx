import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FlatList,
  Keyboard,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
  type ListRenderItem,
} from 'react-native'
import Text from '@/components/common/Text'
import Button from '@/components/common/Button'
import CheckBox from '@/components/common/CheckBox'
import Image from '@/components/common/Image'
import { Icon } from '@/components/common/Icon'
import { SvgIcon } from '@/components/common/SvgIcon'
import { useTheme } from '@/store/theme/hook'
import { confirmDialog, createStyle, toast, getRowInfo } from '@/utils/tools'
import { LIST_IDS, LIST_ITEM_HEIGHT } from '@/config/constant'
import { scaleSizeH } from '@/utils/pixelRatio'
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
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'
import { useBottomOverlayInset } from '@/store/common/hook'
import PageTopInset from '@/components/common/PageTopInset'
import WebDAVListMenu, { type WebDAVListMenuType, type SelectInfo as WebDAVSelectInfo } from './WebDAVListMenu'
import WebDAVProfiles from '@/components/common/WebDAVProfiles'
import WebDAVDownloadPath from './components/WebDAVDownloadPath'
import MetadataEditModal from '@/components/MetadataEditModal'
import {
  handleWebDAVDownload,
  handleFetchWebDAVPicFromOnline,
  handleWebDAVRemove,
  handleWebDAVDownloadAndImport,
} from './WebDAVListAction'
import { readMetadata, readPic } from '@/utils/localMediaMetadata'
import { useSettingValue } from '@/store/setting/hook'
import { testConnection, resetClient } from '@/utils/webdav'
import { existsFile, selectFile, stat, unlink } from '@/utils/fs'
import InputItem from '@/screens/Home/Views/Setting/components/InputItem'
import { updateSetting } from '@/core/common'

type ActiveTab = 'config' | 'list' | 'folders' | 'upload'
const ITEM_HEIGHT = scaleSizeH(LIST_ITEM_HEIGHT)

/** 上传 tab 用：格式化文件大小 */
const formatUploadSize = (size?: number) => {
  if (!size) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

const TabButton = ({ label, tab, activeTab, onPress }: {
  label: string
  tab: ActiveTab
  activeTab: ActiveTab
  onPress: () => void
}) => {
  const theme = useTheme()
  return (
    <TouchableOpacity
      style={{
        ...styles.tab,
        backgroundColor: activeTab === tab ? theme['c-primary'] : theme['c-primary-light-900-alpha-300'],
        borderColor: activeTab === tab ? theme['c-primary'] : theme['c-border-background'],
      }}
      onPress={onPress}
    >
      <Text
        style={{
          ...styles.tabText,
          color: activeTab === tab ? theme['c-primary-light-1000'] : theme['c-font-label'],
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  )
}

const formatTime = (time?: number) => {
  if (!time) return ''
  return new Date(time).toLocaleString()
}

const formatBriefTime = (time?: number) => {
  if (!time) return ''
  const date = new Date(time)
  const pad = (num: number) => String(num).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const formatSize = (size?: number) => {
  if (!size) return ''
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
}

const getFolderName = (folder?: LX.WebDAV.DriveFolder | null) => folder?.path || 'WebDAV 根目录'

const SongItem = memo(
  ({
    item,
    index,
    isPlaying,
    rowWidth = '100%',
    onPress,
    onShowMenu,
  }: {
    item: LX.WebDAV.MusicInfo
    index: number
    isPlaying: boolean
    /** 横屏多列时每列宽度（如 '50%'），竖屏为 '100%' */
    rowWidth?: `${number}%`
    onPress: (musicInfo: LX.WebDAV.MusicInfo) => void
    onShowMenu: (
      item: LX.WebDAV.MusicInfo,
      index: number,
      position: { x: number, y: number, w: number, h: number }
    ) => void
  }) => {
    const theme = useTheme()
    const moreButtonRef = useRef<TouchableOpacity>(null)
    // 没有歌手时退回展示远程路径（filePath 只表示本地已下载文件，未下载时为空）
    const subText = item.singer || item.meta.remotePath || item.meta.filePath || ''
    const sizeText = formatSize(item.meta.size)
    const timeText = formatBriefTime(item.meta.lastModifiedTime)
    const detailText = [sizeText, timeText].filter(Boolean).join(' · ')

    const handleShowMenu = () => {
      if (moreButtonRef.current?.measure) {
        moreButtonRef.current.measure((fx, fy, width, height, px, py) => {
          onShowMenu(item, index, {
            x: Math.ceil(px),
            y: Math.ceil(py),
            w: Math.ceil(width),
            h: Math.ceil(height),
          })
        })
      }
    }

    return (
      <View
        style={{
          ...styles.songItem,
          width: rowWidth,
          backgroundColor: isPlaying
            ? theme['c-primary-background-hover']
            : theme['c-content-background'],
          borderColor: isPlaying
            ? theme['c-primary-background-active']
            : theme['c-border-background'],
        }}
      >
        <TouchableOpacity style={styles.songItemLeft} onPress={() => { onPress(item) }}>
          <View style={styles.sn}>
            {item.meta.picUrl ? (
              <Image url={item.meta.picUrl} style={styles.albumArt} cache={false} />
            ) : (
              <View style={styles.albumArtPlaceholder} />
            )}
          </View>
          <View style={styles.itemInfo}>
            <Text
              size={designTypography.body}
              style={styles.songTitle}
              color={isPlaying ? theme['c-primary-font'] : theme['c-font']}
              numberOfLines={1}
            >
              {item.name || item.meta.fileName}
            </Text>
            <View style={styles.listItemSingle}>
              <Text
                style={styles.listItemSingleText}
                size={designTypography.caption}
                color={isPlaying ? theme['c-primary-alpha-200'] : theme['c-500']}
                numberOfLines={1}
              >
                {subText}
              </Text>
            </View>
            {detailText ? (
              <Text
                size={designTypography.caption}
                color={isPlaying ? theme['c-primary-alpha-200'] : theme['c-500']}
                numberOfLines={1}
              >
                {detailText}
              </Text>
            ) : null}
          </View>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleShowMenu} ref={moreButtonRef} style={styles.moreButton}>
          <Icon name="dots-vertical" style={{ color: theme['c-350'] }} size={17} />
        </TouchableOpacity>
      </View>
    )
  },
)

export default memo(() => {
  const theme = useTheme()
  const playMusicInfo = usePlayMusicInfo()
  const [activeTab, setActiveTab] = useState<ActiveTab>('list')
  const [loading, setLoading] = useState(false)
  const [folderStack, setFolderStack] = useState<LX.WebDAV.DriveFolder[]>([])
  const [folders, setFolders] = useState<LX.WebDAV.DriveFolder[]>([])
  const [selectedFolder, setSelectedFolder] = useState<LX.WebDAV.DriveFolder | null>(null)
  const [songs, setSongs] = useState<LX.WebDAV.MusicInfo[]>([])
  const [scannedAt, setScannedAt] = useState<number | undefined>()
  const [filterPath, setFilterPath] = useState<string | null>(null)
  const [folderLoading, setFolderLoading] = useState(false)
  const [scanText, setScanText] = useState('')
  const [searchVisible, setSearchVisible] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [batchLoadingText, setBatchLoadingText] = useState('')
  const listRef = useRef<FlatList<LX.WebDAV.MusicInfo>>(null)
  const searchInputRef = useRef<TextInput>(null)
  const pendingJumpIdRef = useRef<string | null>(null)
  const webDAVListMenuRef = useRef<WebDAVListMenuType>(null)
  // 上传 tab 状态（2026-10-04：上传改为独立 tab 界面，不再用悬浮窗）
  const [uploadFiles, setUploadFiles] = useState<WebDAVUploadItem[]>([])
  const [uploadPickerExpanded, setUploadPickerExpanded] = useState(false)
  const [uploadCheckedIds, setUploadCheckedIds] = useState<Set<string>>(new Set())
  // 2026-10-04 bugfix：文件 App 选的临时文件（/tmp/）若用户未上传就离开 tab，
  // 需要清理，避免 tmp 堆积。用 ref 跟踪，避免闭包过期。
  const uploadTempFilesRef = useRef<Set<string>>(new Set())
  // 2026-10-05 fix（Bug-4）：上传进行中标记，tab 切换清理时跳过
  const uploadingRef = useRef(false)
  // 2026-10-04：上传进度（进度条用，含文件大小）
  const [uploadProgress, setUploadProgress] = useState<{
    current: number
    total: number
    fileName: string
    fileSize: number
    uploadedSize: number
    totalSize: number
  } | null>(null)
  // 2026-10-04：上传时是否同时上传歌词（.lrc）
  const [uploadWithLyrics, setUploadWithLyrics] = useState(true)
  useEffect(() => {
    // 2026-10-05 fix（P1-6）：离开上传 tab 时，删除临时文件并同步清理队列，
    // 避免返回后队列指向已删除的文件
    // 2026-10-05 fix（Bug-4）：上传进行中时跳过清理，避免删掉正在传的文件
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
  const metadataEditTypeRef = useRef<any>(null)
  const selectedMusicInfoRef = useRef<LX.WebDAV.MusicInfo | null>(null)

  const currentFolder = folderStack.at(-1) ?? null

  // 连接配置（与「设置 → 数据同步 → WebDAV 同步」写的是同一批键，两边永远同源）。
  // 必须是响应式的：此前用 useMemo(..., []) 只在挂载时算一次 —— 用户先在设置里填好
  // 再回到本页，页面仍认定「未配置」，扫描/下载/目录按钮永远灰着（本页不能用的主因之一）。
  const webdavUrl = useSettingValue('sync.webdav.url')
  const webdavUsername = useSettingValue('sync.webdav.username')
  const webdavPassword = useSettingValue('sync.webdav.password')
  const webdavMediaSource = useSettingValue('webdav.mediaSource')
  const hasConfig = !!(webdavUrl && webdavUsername)
  const [isTesting, setIsTesting] = useState(false)

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

  // 2026-10-04：封面歌词来源切换
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
        } catch (e) {
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

  const showMenu = useCallback(
    (musicInfo: LX.WebDAV.MusicInfo, index: number, position: { x: number, y: number, w: number, h: number }) => {
      webDAVListMenuRef.current?.show(
        { musicInfo, index },
        position,
      )
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

  const handlePlayLater = useCallback((info: WebDAVSelectInfo) => {
    const musicInfo = info.musicInfo
    addTempPlayList([{
      listId: null,
      musicInfo,
    }])
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
        setSongs(prevSongs => prevSongs.map(song =>
          song.id === musicInfo.id
            ? { ...song, ...updates, meta: { ...song.meta, ...updates } }
            : song,
        ))
        toast('标签加载成功')
      } else {
        toast('没有新的标签信息')
      }
    } catch (error: any) {
      toast(`加载标签失败：${error.message}`, 'long')
    }
  }, [])

  const handleDownload = useCallback((info: WebDAVSelectInfo) => {
    void handleWebDAVDownload(info.musicInfo).then((newPicUrl) => {
      if (newPicUrl) {
        setSongs(prevSongs => prevSongs.map(song =>
          song.id === info.musicInfo.id
            ? { ...song, meta: { ...song.meta, picUrl: newPicUrl } }
            : song,
        ))
      }
    })
  }, [])

  const handleFetchPicFromOnline = useCallback((info: WebDAVSelectInfo) => {
    void handleFetchWebDAVPicFromOnline(info.musicInfo).then((newPicUrl) => {
      setSongs(prevSongs => prevSongs.map(song =>
        song.id === info.musicInfo.id
          ? { ...song, meta: { ...song.meta, picUrl: newPicUrl } }
          : song,
      ))
    })
  }, [])

  // 2026-10-04：手动指定封面文件（每首歌单独配置）
  const handleSpecifyPicFile = useCallback((info: WebDAVSelectInfo) => {
    void selectFile({ extTypes: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] })
      .then((res) => {
        if (!res?.path) return
        // picker 复制的临时文件长期保留（作为该歌曲的封面），不删除
        void updateWebDAVMusicMeta(info.musicInfo.id, { customPicPath: res.path })
          .then(() => {
            setSongs(prevSongs => prevSongs.map(song =>
              song.id === info.musicInfo.id
                ? { ...song, meta: { ...song.meta, customPicPath: res.path } }
                : song,
            ))
            toast('已指定封面文件')
          })
          .catch((err: any) => { toast(`保存失败：${err?.message ?? err}`, 'long') })
      })
      .catch((err: any) => {
        if (err?.code === 'picker_cancelled') return
        toast(`无法打开文件选择器：${err?.message ?? err}`, 'long')
      })
  }, [])

  // 2026-10-04：手动指定歌词文件（每首歌单独配置）
  const handleSpecifyLrcFile = useCallback((info: WebDAVSelectInfo) => {
    void selectFile({ extTypes: ['lrc'] })
      .then((res) => {
        if (!res?.path) return
        void updateWebDAVMusicMeta(info.musicInfo.id, { customLrcPath: res.path })
          .then(() => {
            setSongs(prevSongs => prevSongs.map(song =>
              song.id === info.musicInfo.id
                ? { ...song, meta: { ...song.meta, customLrcPath: res.path } }
                : song,
            ))
            toast('已指定歌词文件')
          })
          .catch((err: any) => { toast(`保存失败：${err?.message ?? err}`, 'long') })
      })
      .catch((err: any) => {
        if (err?.code === 'picker_cancelled') return
        toast(`无法打开文件选择器：${err?.message ?? err}`, 'long')
      })
  }, [])

  // 2026-10-04：清除手动指定的封面/歌词，恢复自动获取
  const handleClearCustomMedia = useCallback((info: WebDAVSelectInfo) => {
    // 2026-10-05 fix（P1-2）：传 '' 而非 undefined——drive.ts 里 undefined 会被跳过，
    // '' 才会走 delete 分支真正持久化清除
    void updateWebDAVMusicMeta(info.musicInfo.id, { customPicPath: '', customLrcPath: '' })
      .then(() => {
        setSongs(prevSongs => prevSongs.map(song => {
          if (song.id !== info.musicInfo.id) return song
          const meta = { ...song.meta }
          delete meta.customPicPath
          delete meta.customLrcPath
          return { ...song, meta }
        }))
        toast('已清除手动指定，恢复自动获取')
      })
      .catch((err: any) => { toast(`清除失败：${err?.message ?? err}`, 'long') })
  }, [])

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

  // 上传目标目录：当前选中的文件夹，无选择时为根目录
  const uploadTargetDir = useMemo(
    () => selectedFolder?.path || '/',
    [selectedFolder],
  )

  /**
   * 批量上传：将本地音频文件逐个 PUT 到服务器目标目录。
   * - 先预检冲突（服务器已存在同名文件），有冲突时一次问清：覆盖全部 / 取消
   * - 逐个上传，失败的记下来继续传下一个，最后如实报告
   * - 全部完成后重新扫描当前目录，让新歌出现在列表里
   */
  const runWebDAVUpload = useCallback(async(
    items: WebDAVUploadItem[],
    onProgress?: (current: number, total: number, fileName: string) => void,
    withLyrics?: boolean,
  ): Promise<boolean> => {
    // 2026-10-05 fix（P1-5）：返回是否真正开始上传，供调用方决定是否清理队列
    // 2026-10-05：先校验本地文件真实可读且大小 > 0（stat 失败/大小为 0 直接跳过，
    // 不再让 uploadBinaryFile 吞掉错误变成 size 0 的无效上传）
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
      // 2026-10-05：冲突预检必须走统一目录语义（与 uploadWebDAVMusicFile 实际目标一致）
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
      // 2026-10-04：进度回调（上传 tab 的进度条用）
      onProgress?.(i + 1, items.length, item.fileName)
      try {
        // 2026-10-05：分阶段上报，卡在哪一步直接显示在按钮上
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
    // 2026-10-05 fix（P1-5）：返回 true 表示真正开始了上传
    return true
  }, [uploadTargetDir, selectedFolder])

  // ===== 上传 tab（2026-10-04）：独立界面，不再用悬浮窗 =====
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
    // 2026-10-05 fix（P1-5）：仅真正开始上传后才清理队列；
    // 取消/连接失败时保留队列，用户可手动清空或重试
    if (started) {
      for (const p of uploadTempFilesRef.current) {
        void unlink(p).catch(() => {})
      }
      uploadTempFilesRef.current.clear()
      setUploadFiles([])
    }
  }, [uploadFiles, runWebDAVUpload, uploadWithLyrics])

  const handleUpload = useCallback(() => {
    if (!hasConfig) {
      toast(global.i18n.t('webdav_upload_config_first'))
      setActiveTab('config')
      return
    }
    // 2026-10-04：上传改为独立 tab 界面，不再弹悬浮窗
    setActiveTab('upload')
  }, [hasConfig])

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

  useEffect(() => {
    loadConfig()
  }, [loadConfig])

  useEffect(() => {
    if (!hasConfig) return
    loadFolders(currentFolder)
  }, [hasConfig, currentFolder, loadFolders])

  useEffect(() => {
    const handleWebdavPicUpdated = (musicId: string, picUrl: string) => {
      setSongs(prevSongs => prevSongs.map(song =>
        song.id === musicId
          ? { ...song, meta: { ...song.meta, picUrl } }
          : song,
      ))
    }

    global.app_event.on('webdavPicUpdated', handleWebdavPicUpdated)
    return () => {
      global.app_event.off('webdavPicUpdated', handleWebdavPicUpdated)
    }
  }, [])

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

  const handleSelectCurrentFolder = useCallback(() => {
    setLoading(true)
    void saveWebDAVSelectedFolder(currentFolder)
      .then((config) => {
        setSelectedFolder(config.selectedFolder ?? null)
        toast(`已选择：${getFolderName(config.selectedFolder)}`)
      })
      .catch((err: any) => {
        toast(err.message ?? String(err), 'long')
      })
      .finally(() => {
        setLoading(false)
      })
  }, [currentFolder])

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

  // 列数响应式（对齐 OnlineList）：iPad 横屏/分屏时双列，避免歌曲行在超宽屏上
  // 被拉得过长、左右留白；竖屏保持单列零回归。
  // numColumns 变更时 FlatList 必须重挂载（RN 不支持运行中改列数），故加 key。
  const isHorizontal = useHorizontalMode()
  // 底部悬浮层（迷你播放器 + 底部 Tab + 安全区）统一避让高度
  const bottomInset = useBottomOverlayInset()
  const rowInfo = useMemo(() => {
    void isHorizontal
    return getRowInfo()
  }, [isHorizontal])
  const numColumns = rowInfo.rowNum ?? 1

  const renderSong: ListRenderItem<LX.WebDAV.MusicInfo> = useCallback(
    ({ item, index }) => (
      <SongItem
        item={item}
        index={index}
        isPlaying={playMusicInfo.musicInfo?.id === item.id}
        rowWidth={rowInfo.rowWidth}
        onPress={handlePlay}
        onShowMenu={showMenu}
      />
    ),
    [handlePlay, showMenu, playMusicInfo.musicInfo?.id, rowInfo.rowWidth],
  )

  const headerText = useMemo(() => {
    if (batchLoadingText) return batchLoadingText
    if (searchText.trim()) return `${filteredSongs.length}/${songs.length} 首`
    return `${songs.length} 首${scannedAt ? ` · ${formatTime(scannedAt)}` : ''}`
  }, [batchLoadingText, filteredSongs.length, scannedAt, searchText, songs.length])

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

  const renderTabsHeader = () => (
    <>
      <PageTopInset />
      <View style={{ ...styles.tabs, borderBottomColor: theme['c-border-background'] }}>
        <TabButton label="列表" tab="list" activeTab={activeTab} onPress={() => { setActiveTab('list') }} />
        <TabButton label="目录" tab="folders" activeTab={activeTab} onPress={() => { setActiveTab('folders') }} />
        <TabButton label={global.i18n.t('webdav_upload_tab')} tab="upload" activeTab={activeTab} onPress={() => {
          // 2026-10-04 bugfix：未配置时跳配置页，避免上传 tab 内操作失败
          if (!hasConfig) {
            toast(global.i18n.t('webdav_upload_config_first'))
            setActiveTab('config')
            return
          }
          setActiveTab('upload')
        }} />
        <TabButton label="配置" tab="config" activeTab={activeTab} onPress={() => { setActiveTab('config') }} />
      </View>
    </>
  )

  const renderConfig = () => (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      onScrollBeginDrag={Keyboard.dismiss}
      style={styles.scroll}
      contentContainerStyle={styles.content}
    >
      {renderTabsHeader()}
      {/* 服务器配置：一键切换/保存/编辑/删除。下面的手工输入区保留，
          首次配置、临时服务器仍走那里。 */}
      <WebDAVProfiles />
      {/* 连接配置就地可改：与「设置 → 数据同步 → WebDAV 同步」共用同一批设置键
          （sync.webdav.*），不再像旧版那样只给一句「请在设置中配置」把人赶去别的页面。
          注：输入项本身已是卡片（InputItem 自带边框/底色），这里不再套一层 panel，避免双层边框。 */}
      <View style={styles.section}>
        <Text style={styles.label}>连接</Text>
        <Text size={12} color={theme['c-font-label']} style={styles.sectionTip}>
          与「设置 → 数据同步 → WebDAV 同步」是同一份配置，两边改哪边都生效。
        </Text>
      </View>
      <InputItem
        label="服务器地址"
        value={webdavUrl}
        onChanged={handleWebdavSettingChanged('sync.webdav.url')}
        placeholder="https://example.com/webdav"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <InputItem
        label="用户名"
        value={webdavUsername}
        onChanged={handleWebdavSettingChanged('sync.webdav.username')}
        placeholder="请输入用户名"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <InputItem
        label="密码"
        value={webdavPassword}
        onChanged={handleWebdavSettingChanged('sync.webdav.password')}
        placeholder="请输入密码"
        secureTextEntry
      />
      <View style={styles.buttonRow}>
        <Button
          style={{ ...styles.button, backgroundColor: theme['c-button-background'] }}
          disabled={!hasConfig || isTesting}
          onPress={handleTestConnection}
        >
          <Text color={theme['c-button-font']}>{isTesting ? '测试中...' : '测试连接'}</Text>
        </Button>
      </View>
      <Text color={hasConfig ? theme['c-primary-font'] : theme['c-font-label']} style={styles.meta}>
        {hasConfig ? '已配置：可直接浏览目录、扫描歌曲' : '未配置：填好服务器地址与用户名后即可使用'}
      </Text>

      <WebDAVDownloadPath />

      {/* 封面歌词来源（2026-10-04）：歌曲文件 = 同目录/内嵌（默认）；云端插件 = 在线匹配优先 */}
      <View style={{ ...styles.panel, borderColor: theme['c-border-background'] }}>
        <Text style={styles.label}>封面歌词来源</Text>
        <View style={styles.mediaSourceRow}>
          <Button
            style={{
              ...styles.mediaSourceButton,
              backgroundColor: webdavMediaSource === 'file' ? theme['c-primary'] : theme['c-primary-light-900-alpha-300'],
            }}
            onPress={() => { handleWebdavMediaSourceChanged('file') }}
          >
            <Text color={webdavMediaSource === 'file' ? theme['c-primary-light-1000'] : theme['c-font']}>
              歌曲文件
            </Text>
          </Button>
          <Button
            style={{
              ...styles.mediaSourceButton,
              marginLeft: designSpacing.sm,
              backgroundColor: webdavMediaSource === 'online' ? theme['c-primary'] : theme['c-primary-light-900-alpha-300'],
            }}
            onPress={() => { handleWebdavMediaSourceChanged('online') }}
          >
            <Text color={webdavMediaSource === 'online' ? theme['c-primary-light-1000'] : theme['c-font']}>
              云端插件
            </Text>
          </Button>
        </View>
        <Text size={12} color={theme['c-font-label']} style={styles.meta}>
          {webdavMediaSource === 'file'
            ? '从歌曲文件获取：同目录同名封面/歌词、音频内嵌标签。'
            : '从云端插件获取：按歌名/歌手在线匹配封面歌词，失败时回退到歌曲文件。'}
          {'\n'}也可在歌曲菜单里手动指定单个歌曲的封面/歌词文件（优先级最高）。
        </Text>
      </View>

      <View style={{ ...styles.panel, borderColor: theme['c-border-background'] }}>
        <Text style={styles.label}>扫描范围</Text>
        <Text color={theme['c-font-label']} style={styles.meta}>
          {getFolderName(selectedFolder)}
        </Text>
        <Text size={12} color={theme['c-font-label']} style={styles.meta}>
          到「目录」页浏览服务器目录并选择；不选则扫描整个根目录。
        </Text>
      </View>
    </ScrollView>
  )

  const renderFolders = () => (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={styles.scroll}
      contentContainerStyle={styles.content}
    >
      {renderTabsHeader()}
      {/* 服务器目录：浏览并选择「扫描范围」。旧版把这块藏在「配置」页里，
          与这里「已扫描歌曲的目录」分属两页、两个名字，是用户说的「割裂」来源之一。 */}
      <View style={{ ...styles.panel, borderColor: theme['c-border-background'] }}>
        <Text style={styles.label}>服务器目录</Text>
        <Text color={theme['c-font-label']} style={styles.meta}>
          当前：{getFolderName(currentFolder)}
        </Text>
        <Text color={theme['c-font-label']} style={styles.meta}>
          扫描范围：{getFolderName(selectedFolder)}
        </Text>
        <View style={styles.buttonRow}>
          <Button
            style={{ ...styles.button, backgroundColor: theme['c-button-background'] }}
            disabled={!hasConfig || folderLoading || !folderStack.length}
            onPress={() => { setFolderStack(prev => prev.slice(0, -1)) }}
          >
            <Text color={theme['c-button-font']}>返回上级</Text>
          </Button>
          <Button
            style={{ ...styles.button, backgroundColor: theme['c-button-background'] }}
            disabled={!hasConfig || loading}
            onPress={handleSelectCurrentFolder}
          >
            <Text color={theme['c-button-font']}>选择当前目录</Text>
          </Button>
        </View>

        {folderLoading ? (
          <Text style={styles.tip} color={theme['c-font-label']}>
            正在读取目录...
          </Text>
        ) : folders.length ? (
          folders.map(folder => (
            <TouchableOpacity
              key={folder.id}
              style={{ ...styles.folderItem, borderBottomColor: theme['c-border-background'] }}
              onPress={() => { setFolderStack(prev => [...prev, folder]) }}
            >
              <Text numberOfLines={1}>{folder.name}</Text>
              <Text size={11} color={theme['c-font-label']} numberOfLines={1}>
                {folder.path}
              </Text>
            </TouchableOpacity>
          ))
        ) : (
          <Text style={styles.tip} color={theme['c-font-label']}>
            {hasConfig ? '当前目录没有子目录。' : '请先在「配置」里填写服务器地址与用户名。'}
          </Text>
        )}
      </View>

      {/* 已扫描歌曲按目录分组：点一行就把歌曲列表筛到该目录 */}
      <View style={{ ...styles.panel, borderColor: theme['c-border-background'] }}>
        <Text style={styles.label}>已扫描歌曲的目录</Text>
        <TouchableOpacity
          style={{ ...styles.folderItem, borderBottomColor: theme['c-border-background'] }}
          onPress={() => {
            handleSetFilterPath(null)
            setActiveTab('list')
          }}
        >
          <View style={styles.folderItemInfo}>
            <SvgIcon name="music-list" size={18} color={theme['c-primary-font']} style={{ marginRight: 10 }} />
            <View style={{ flex: 1 }}>
              <Text>全部歌曲</Text>
            </View>
            <Text size={12} color={theme['c-font-label']}>{songs.length} 首</Text>
          </View>
        </TouchableOpacity>
        {songFolders.length ? (
          songFolders.map(folder => (
            <TouchableOpacity
              key={folder.path}
              style={{ ...styles.folderItem, borderBottomColor: theme['c-border-background'] }}
              onPress={() => {
                handleSetFilterPath(folder.path)
                setActiveTab('list')
              }}
            >
              <View style={styles.folderItemInfo}>
                <SvgIcon name="folder" size={18} color={theme['c-primary-font']} style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1}>{folder.name}</Text>
                  <Text size={11} color={theme['c-font-label']} numberOfLines={1}>
                    {folder.path}
                  </Text>
                </View>
                <Text size={12} color={theme['c-font-label']}>{folder.count} 首</Text>
              </View>
            </TouchableOpacity>
          ))
        ) : (
          <View style={styles.empty}>
            <Text color={theme['c-font-label']}>还没有扫描到包含音乐的文件夹</Text>
          </View>
        )}
      </View>
    </ScrollView>
  )

  const renderUpload = () => {
    const totalSize = uploadFiles.reduce((sum, f) => sum + (f.size || 0), 0)
    return (
      <View style={styles.uploadPage}>
        <ScrollView
          style={styles.uploadScroll}
          contentContainerStyle={styles.uploadContent}
          keyboardShouldPersistTaps="handled"
        >
          {renderTabsHeader()}
          {/* 上传目标目录 */}
          <View style={styles.uploadSection}>
            <Text size={designTypography.caption} color={theme['c-font-label']}>上传目标目录</Text>
            <Text size={designTypography.body} color={theme['c-font']} numberOfLines={2} style={styles.uploadTargetPath}>
              {getWebDAVMusicDir(uploadTargetDir)}
            </Text>
          </View>

          {/* 来源选择：大按钮（2026-10-04 修复按钮尺寸问题：旧按钮 paddingVertical 仅 6，
              触摸目标过小且三按钮宽度不一；新按钮统一 48pt 高、等宽并排） */}
          <View style={styles.uploadSourceRow}>
            <Button
              style={[styles.uploadSourceButton, { backgroundColor: theme['c-button-background'] }]}
              onPress={() => { setUploadPickerExpanded(v => !v) }}
            >
              <Text color={theme['c-button-font']}>{global.i18n.t('webdav_upload_from_downloads')}</Text>
            </Button>
            <Button
              style={[styles.uploadSourceButton, { backgroundColor: theme['c-button-background'], marginLeft: designSpacing.md }]}
              onPress={handleAddUploadFromFilePicker}
            >
              <Text color={theme['c-button-font']}>{global.i18n.t('webdav_upload_from_files')}</Text>
            </Button>
          </View>

          {/* 下载列表（展开时内嵌选择，不再用悬浮窗） */}
          {uploadPickerExpanded ? (
            <View style={styles.uploadSection}>
              <View style={styles.uploadRowHeader}>
                <Text size={designTypography.body} color={theme['c-font']}>{global.i18n.t('webdav_upload_downloaded_files')}</Text>
                <TouchableOpacity onPress={toggleUploadCheckAll} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text size={designTypography.caption} color={theme['c-primary']}>
                    {uploadCheckedIds.size === uploadableTasks.length && uploadableTasks.length > 0 ? '取消全选' : '全选'}
                  </Text>
                </TouchableOpacity>
              </View>
              {uploadableTasks.length === 0 ? (
                <Text size={designTypography.caption} color={theme['c-font-label']} style={styles.uploadEmptyText}>
                  没有已完成的下载任务
                </Text>
              ) : (
                uploadableTasks.map(task => {
                  const checked = uploadCheckedIds.has(task.id)
                  return (
                    <TouchableOpacity
                      key={task.id}
                      style={styles.uploadTaskRow}
                      activeOpacity={0.7}
                      onPress={() => { toggleUploadCheck(task.id) }}
                    >
                      <CheckBox check={checked} onChange={() => { toggleUploadCheck(task.id) }} />
                      <View style={styles.uploadTaskInfo}>
                        <Text size={designTypography.body} color={theme['c-font']} numberOfLines={1}>
                          {task.fileName}
                        </Text>
                        <Text size={designTypography.caption} color={theme['c-font-label']}>
                          {formatUploadSize(task.progress?.total)}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  )
                })
              )}
              <Button
                style={[styles.uploadAddButton, { backgroundColor: theme['c-primary-light-900-alpha-300'] }]}
                onPress={handleAddUploadFromDownloads}
              >
                <Text color={theme['c-primary']}>添加所选（{uploadCheckedIds.size}）</Text>
              </Button>
            </View>
          ) : null}

          {/* 待上传队列 */}
          <View style={styles.uploadSection}>
            <View style={styles.uploadQueueHeader}>
              <Text size={designTypography.body} color={theme['c-font']} style={styles.uploadSectionTitle}>
                待上传（{uploadFiles.length}）
              </Text>
              {uploadFiles.length > 0 ? (
                <TouchableOpacity
                  onPress={() => {
                    // 2026-10-05（P1-5）：手动清空队列（含临时文件清理）
                    for (const p of uploadTempFilesRef.current) {
                      void unlink(p).catch(() => {})
                    }
                    uploadTempFilesRef.current.clear()
                    setUploadFiles([])
                    toast(global.i18n.t('webdav_upload_cleared'))
                  }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text size={designTypography.caption} color={theme['c-primary']}>{global.i18n.t('webdav_upload_clear')}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            {/* 2026-10-04：上传时是否同时上传歌词 */}
            <TouchableOpacity
              style={styles.uploadLyricsRow}
              activeOpacity={0.7}
              onPress={() => { setUploadWithLyrics(v => !v) }}
            >
              <CheckBox check={uploadWithLyrics} onChange={setUploadWithLyrics} />
              <Text size={designTypography.body} color={theme['c-font']} style={styles.uploadLyricsLabel}>
                同时上传歌词（.lrc）
              </Text>
            </TouchableOpacity>
            <Text size={designTypography.caption} color={theme['c-font-label']} style={styles.uploadLyricsTip}>
              勾选后，上传歌曲时会自动查找同名歌词文件，一并上传到 lrc/ 目录
            </Text>
            {uploadFiles.length === 0 ? (
              <Text size={designTypography.caption} color={theme['c-font-label']} style={styles.uploadEmptyText}>
                还没有添加文件，用上面的按钮选择要上传的音频
              </Text>
            ) : (
              uploadFiles.map(f => (
                <View key={f.localPath} style={styles.uploadFileRow}>
                  <View style={styles.uploadTaskInfo}>
                    <Text size={designTypography.body} color={theme['c-font']} numberOfLines={1}>
                      {f.fileName}
                    </Text>
                    <Text size={designTypography.caption} color={theme['c-font-label']}>
                      {formatUploadSize(f.size)}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => { handleRemoveUploadFile(f.localPath) }}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={styles.uploadRemoveBtn}
                  >
                    <Icon name="close" size={16} color={theme['c-font-label']} />
                  </TouchableOpacity>
                </View>
              ))
            )}
          </View>
        </ScrollView>

        {/* 底部：进度条 + 大上传按钮（固定在内容区底部，不与 tab 栏重叠） */}
        {/* 2026-10-05 fix：paddingBottom 加大到 100，确保按钮在悬浮 tab 栏上方 */}
        <View style={[styles.uploadFooter, { paddingBottom: 100 }]}>
          {uploadProgress ? (
            <View style={styles.uploadProgressWrap}>
              <View style={styles.uploadProgressHeader}>
                <Text size={designTypography.caption} color={theme['c-font']} numberOfLines={1} style={styles.uploadProgressText}>
                  {uploadProgress.fileName
                    ? `正在上传：${uploadProgress.fileName}（${formatUploadSize(uploadProgress.fileSize)}）`
                    : '上传完成'}
                </Text>
                <Text size={designTypography.caption} color={theme['c-font-label']}>
                  {uploadProgress.current}/{uploadProgress.total} · {formatUploadSize(uploadProgress.uploadedSize)}/{formatUploadSize(uploadProgress.totalSize)}
                </Text>
              </View>
              <View style={[styles.uploadProgressTrack, { backgroundColor: theme['c-primary-light-900-alpha-300'] }]}>
                <View
                  style={[
                    styles.uploadProgressBar,
                    {
                      backgroundColor: theme['c-primary'],
                      width: `${uploadProgress.total > 0 ? (uploadProgress.current / uploadProgress.total) * 100 : 0}%`,
                    },
                  ]}
                />
              </View>
            </View>
          ) : null}
          <Button
            style={[styles.uploadStartButton, { backgroundColor: theme['c-primary'] }]}
            disabled={uploadFiles.length === 0 || loading || !!batchLoadingText}
            onPress={() => { void handleStartUpload() }}
          >
            <Text color={theme['c-primary-light-1000']}>
              {batchLoadingText || `开始上传${uploadFiles.length > 0 ? `（${uploadFiles.length} 个，${formatUploadSize(totalSize)}）` : ''}`}
            </Text>
          </Button>
        </View>
      </View>
    )
  }

  const renderList = () => (
    <View style={styles.listPage}>
      <FlatList
        key={`cols-${numColumns}`}
        ref={listRef}
        data={filteredSongs}
        ListHeaderComponent={
          <>
            {renderTabsHeader()}
            <View style={{ ...styles.listHeader, borderBottomColor: theme['c-border-background'] }}>
              <View style={styles.listHeaderText}>
          {searchVisible ? (
            <TextInput
              ref={searchInputRef}
              value={searchText}
              placeholder="搜索歌曲或歌手"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onChangeText={setSearchText}
              placeholderTextColor={theme['c-font-label']}
              selectionColor={theme['c-primary-light-100-alpha-300']}
              style={{
                ...styles.searchInput,
                color: theme['c-font'],
                borderColor: theme['c-border-background'],
              }}
            />
          ) : (
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text numberOfLines={1} style={{ flex: 1 }}>
                  {filterPath ? `文件夹：${filterPath.split('/').pop() || '根目录'}` : `已选择：${getFolderName(selectedFolder)}`}
                </Text>
                {filterPath ? (
                  <TouchableOpacity onPress={() => { handleSetFilterPath(null) }} style={{ marginLeft: 8 }}>
                    <Icon name="close" size={12} color={theme['c-primary-font']} />
                  </TouchableOpacity>
                ) : null}
              </View>
              <Text size={11} color={theme['c-font-label']} numberOfLines={1}>
                {!hasConfig ? '未配置 WebDAV：请到「配置」页填写服务器地址与用户名' : (scanText || headerText)}
              </Text>
            </View>
          )}
              </View>
              <TouchableOpacity style={styles.headerIconButton} onPress={handleToggleSearch}>
                <Icon name="search-2" size={16} color={searchVisible ? theme['c-primary-font'] : theme['c-font-label']} />
              </TouchableOpacity>
              {searchVisible ? (
                <TouchableOpacity style={styles.headerIconButton} onPress={handleClearSearch}>
                  <Icon name="close" size={13} color={theme['c-font-label']} />
                </TouchableOpacity>
              ) : null}
              <Button
                style={{ ...styles.scanButton, backgroundColor: theme['c-button-background'] }}
                disabled={loading || !!batchLoadingText}
                onPress={handleScan}
              >
                <Text color={theme['c-button-font']}>扫描</Text>
              </Button>
              <Button
                style={{ ...styles.scanButton, backgroundColor: theme['c-primary-background-hover'], marginLeft: 8 }}
                disabled={loading || !!batchLoadingText}
                onPress={handleBatchDownload}
              >
                <Text color={theme['c-primary-font']}>扫描并下载</Text>
              </Button>
              <Button
                style={{ ...styles.scanButton, backgroundColor: theme['c-button-background'], marginLeft: 8 }}
                disabled={loading || !!batchLoadingText}
                onPress={handleUpload}
              >
                <Text color={theme['c-button-font']}>上传</Text>
              </Button>
            </View>
          </>
        }
        contentContainerStyle={{ paddingBottom: bottomInset }}
        numColumns={numColumns}
        renderItem={renderSong}
        keyExtractor={item => item.id}
        style={{ flex: 1 }}
        // 限制渲染窗口 + 离屏行视图摘除（iOS 滚动掉帧主杠杆；getItemLayout 固定行高下回挂安全）
        initialNumToRender={20}
        windowSize={5}
        maxToRenderPerBatch={10}
        removeClippedSubviews={true}
        updateCellsBatchingPeriod={50}
        getItemLayout={(data, index) => ({
          length: ITEM_HEIGHT,
          offset: ITEM_HEIGHT * Math.floor(index / numColumns),
          index,
        })}
        onScrollToIndexFailed={(info) => {
          listRef.current?.scrollToOffset({
            offset: Math.max(0, info.averageItemLength * info.index),
            animated: true,
          })
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text color={theme['c-font-label']}>
              {!hasConfig
                ? '未配置 WebDAV：请到「配置」页填写服务器地址与用户名'
                : searchText.trim()
                  ? '没有匹配的歌曲'
                  : '还没有扫描到歌曲，点右上角「扫描」'}
            </Text>
          </View>
        }
        refreshControl={
          <RefreshControl
            colors={[theme['c-primary']]}
            refreshing={loading}
            onRefresh={handleRefresh}
          />
        }
      />
    </View>
  )

  return (
    <View style={styles.container}>
      {activeTab === 'config' ? renderConfig() : activeTab === 'folders' ? renderFolders() : activeTab === 'upload' ? renderUpload() : renderList()}
      <WebDAVListMenu
        ref={webDAVListMenuRef}
        onPlay={(info) => { handlePlay(info.musicInfo) }}
        onPlayLater={handlePlayLater}
        onDownload={handleDownload}
        onFetchPicFromOnline={handleFetchPicFromOnline}
        onSpecifyPicFile={handleSpecifyPicFile}
        onSpecifyLrcFile={handleSpecifyLrcFile}
        onClearCustomMedia={handleClearCustomMedia}
        onEditMetadata={handleEditMetadata}
        onRemove={handleRemove}
        onLoadMetadata={handleLoadMetadata}
      />
      <MetadataEditModal ref={metadataEditTypeRef} onUpdate={handleUpdateMetadata} />
    </View>
  )
})

const styles = createStyle({
  container: {
    flex: 1,
  },
  // ===== 上传 tab（2026-10-04）：独立界面，大按钮修复旧按钮尺寸问题 =====
  uploadPage: {
    flex: 1,
  },
  uploadScroll: {
    flex: 1,
  },
  uploadContent: {
    paddingBottom: designSpacing.lg,
  },
  uploadSection: {
    paddingHorizontal: designSpacing.lg,
    paddingVertical: designSpacing.md,
  },
  uploadTargetPath: {
    marginTop: designSpacing.xs,
  },
  uploadSourceRow: {
    flexDirection: 'row',
    paddingHorizontal: designSpacing.lg,
    paddingVertical: designSpacing.sm,
  },
  // 来源按钮：等宽并排、48pt 高，保证触摸目标（旧按钮 paddingVertical 仅 6）
  uploadSourceButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: designRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  uploadRowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: designSpacing.sm,
  },
  uploadTaskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: designSpacing.sm,
  },
  uploadTaskInfo: {
    flex: 1,
    marginLeft: designSpacing.sm,
  },
  uploadFileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: designSpacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  uploadRemoveBtn: {
    padding: designSpacing.sm,
  },
  uploadSectionTitle: {
    marginBottom: designSpacing.sm,
    fontWeight: '600',
  },
  // 2026-10-05（P1-5）：待上传队列标题行（含清空按钮）
  uploadQueueHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: designSpacing.sm,
  },
  // 上传歌词选项（2026-10-04）
  uploadLyricsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: designSpacing.sm,
  },
  uploadLyricsLabel: {
    marginLeft: designSpacing.sm,
  },
  uploadLyricsTip: {
    marginBottom: designSpacing.sm,
  },
  uploadEmptyText: {
    paddingVertical: designSpacing.md,
  },
  uploadAddButton: {
    marginTop: designSpacing.md,
    minHeight: 44,
    borderRadius: designRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  uploadFooter: {
    paddingHorizontal: designSpacing.lg,
    paddingVertical: designSpacing.md,
  },
  // 底部上传按钮：全宽、52pt 高，大触摸目标
  uploadStartButton: {
    minHeight: 52,
    borderRadius: designRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 上传进度条（2026-10-04）
  uploadProgressWrap: {
    marginBottom: designSpacing.md,
  },
  uploadProgressHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: designSpacing.xs,
  },
  uploadProgressText: {
    flex: 1,
    marginRight: designSpacing.sm,
  },
  uploadProgressTrack: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  uploadProgressBar: {
    height: 6,
    borderRadius: 3,
  },
  // 封面歌词来源选择（2026-10-04）
  mediaSourceRow: {
    flexDirection: 'row',
    marginTop: designSpacing.sm,
    marginBottom: designSpacing.sm,
  },
  mediaSourceButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: designRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabs: {
    flexDirection: 'row',
    height: 44,
    paddingHorizontal: designSpacing.md,
    alignItems: 'center',
    gap: designSpacing.xs,
  },
  tab: {
    height: 32,
    paddingHorizontal: designSpacing.sm,
    borderWidth: 1,
    borderRadius: designRadius.pill,
    justifyContent: 'center',
  },
  tabText: {
    fontSize: designTypography.caption,
    fontWeight: '600',
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 12,
  },
  panel: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 4,
    padding: 10,
    marginBottom: 10,
  },
  label: {
    marginBottom: 6,
  },
  // 说明型小节（不套 panel）：InputItem 自带卡片边框，外层再画框会成双层容器
  section: {
    marginBottom: designSpacing.xs,
  },
  sectionTip: {
    marginTop: 2,
    marginBottom: designSpacing.sm,
  },
  meta: {
    marginTop: 5,
  },
  tip: {
    marginTop: 6,
    lineHeight: 18,
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 12,
  },
  button: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    marginRight: 10,
    marginBottom: 8,
  },
  folderItem: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 9,
  },
  folderItemInfo: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  listPage: {
    flex: 1,
  },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  listHeaderText: {
    flex: 1,
    paddingRight: 8,
  },
  searchInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 4,
    height: 34,
    paddingHorizontal: 8,
    paddingVertical: 0,
    fontSize: 13,
  },
  headerIconButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanButton: {
    paddingHorizontal: 12,
    // 2026-10-04 修复按钮尺寸：旧 paddingVertical 仅 6，触摸目标过小；
    // 统一最小高度 36，保证可点且三按钮视觉一致。
    minHeight: 36,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 4,
  },
  songItem: {
    height: ITEM_HEIGHT,
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'center',
    paddingLeft: designSpacing.sm,
    paddingRight: designSpacing.sm,
    marginBottom: designSpacing.sm,
    borderWidth: 1,
    borderRadius: designRadius.lg,
  },
  songItemLeft: {
    flex: 1,
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  sn: {
    width: 74,
    justifyContent: 'center',
    alignItems: 'center',
    paddingLeft: designSpacing.xs,
    paddingRight: designSpacing.xs,
  },
  albumArtPlaceholder: {
    width: 54,
    height: 54,
    borderRadius: designRadius.md,
    backgroundColor: 'rgba(0,0,0,0.08)',
  },
  albumArt: {
    width: 54,
    height: 54,
    borderRadius: designRadius.md,
  },
  itemInfo: {
    flexGrow: 1,
    flexShrink: 1,
    paddingRight: 2,
  },
  listItemSingle: {
    paddingTop: 3,
    flexDirection: 'row',
  },
  listItemSingleText: {
    flexGrow: 0,
    flexShrink: 1,
    fontWeight: '400',
  },
  songTitle: {
    fontWeight: '600',
  },
  moreButton: {
    height: '80%',
    paddingLeft: designSpacing.sm,
    paddingRight: designSpacing.sm,
    justifyContent: 'center',
  },
  empty: {
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
