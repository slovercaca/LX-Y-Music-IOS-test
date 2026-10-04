import { useRef, useState, forwardRef, useImperativeHandle, useCallback } from 'react'
import { View } from 'react-native'
import List, { type ListProps, type ListType, type Status, type RowInfoType } from './List'
import ListMenu, { type ListMenuType, type Position, type SelectInfo } from './ListMenu'
import ListMusicMultiAdd, {
  type MusicMultiAddModalType as ListAddMultiType,
} from '@/components/MusicMultiAddModal'
import ListMusicAdd, {
  type MusicAddModalType as ListMusicAddType,
} from '@/components/MusicAddModal'
import MultiSelectTopBar, { type SelectMode } from '@/components/common/MultiSelectTopBar'
import {
  handleDislikeMusic,
  handlePlay,
  handlePlayLater,
  handleShowArtistDetail,
  handleShowAlbumDetail,
  handleLikeMusic,
  handleTxLikeMusic,
  handleKgLikeMusic,
} from './listAction'
import { handleClearMusicCache } from '@/screens/Home/Views/Mylist/MusicList/listAction'
import { createStyle, toast, confirmDialog } from '@/utils/tools'
import wyApi from '@/utils/musicSdk/wy/user'
import txUserApi from '@/utils/musicSdk/tx/user'
import { removeSongsFromPlaylist as removeKgSongsFromPlaylist, getPlaylistSongs as getKgPlaylistSongs } from '@/utils/musicSdk/kg/utils/api'
import { batchDownload, downloadMusic } from '@/core/download'
import { useI18n } from '@/lang'
import { removeWyLikedSong, updateWySubscribedPlaylistTrackCount } from '@/store/user/action.ts'
import { clearListDetailCache } from '@/core/songlist.ts'
import { removePlayHistoryItems } from '@/core/player/playHistory'
import commonState from '@/store/common/state'
import { useWySubscribedPlaylists } from '@/store/user/hook.ts'
import type { SubscribedPlaylistInfo } from '@/store/user/state'
import { useSettingValue } from '@/store/setting/hook.ts'
import SimilarSongsModal, { type SimilarSongsModalType } from '@/components/SimilarSongsModal'

export interface OnlineListProps {
  onRefresh: ListProps['onRefresh']
  onLoadMore: ListProps['onLoadMore']
  onPlayList?: ListProps['onPlayList']
  progressViewOffset?: ListProps['progressViewOffset']
  ListHeaderComponent?: ListProps['ListHeaderComponent']
  ListFooterComponent?: ListProps['ListFooterComponent']
  checkHomePagerIdle?: boolean
  rowType?: RowInfoType
  listId?: string
  playingId?: string | null
  forcePlayList?: boolean
  onListUpdate?: ListProps['onListUpdate']
  isCreator?: boolean
  componentId?: string
}

export interface OnlineListType {
  setList: (list: LX.Music.MusicInfoOnline[], isAppend?: boolean, showSource?: boolean) => void
  setStatus: (val: Status) => void
  getList: () => LX.Music.MusicInfoOnline[]
  scrollToInfo: (info: LX.Music.MusicInfoOnline) => void
}

export default forwardRef<OnlineListType, OnlineListProps>(
  (
    {
      onRefresh,
      onLoadMore,
      onPlayList,
      progressViewOffset,
      ListHeaderComponent,
      ListFooterComponent,
      checkHomePagerIdle = false,
      rowType,
      listId,
      playingId,
      forcePlayList,
      onListUpdate,
      isCreator = false,
      componentId: componentId_raw,
    },
    ref,
  ) => {
    const listRef = useRef<ListType>(null)
    const listMusicAddRef = useRef<ListMusicAddType>(null)
    const listMusicMultiAddRef = useRef<ListAddMultiType>(null)
    const listMenuRef = useRef<ListMenuType>(null)

    // 2026-10-04 Bug7：多选状态改由 state 驱动（原 MultipleModeBar 悬浮窗已移除，
    // 改为顶部 MultiSelectTopBar）
    const [isMultiSelect, setIsMultiSelect] = useState(false)
    const [selectMode, setSelectMode] = useState<SelectMode>('single')
    const [isSelectAll, setIsSelectAll] = useState(false)

    const similarSongsModalRef = useRef<SimilarSongsModalType>(null)
    const t = useI18n()
    const subscribedPlaylists = useWySubscribedPlaylists()
    const kgCookie = useSettingValue('common.kg_cookie')

    useImperativeHandle(ref, () => ({
      setList(list, isAppend = false, showSource = false) {
        listRef.current?.setList(list, isAppend, showSource)
        setIsSelectAll(false)
      },
      setStatus(val) {
        listRef.current?.setStatus(val)
      },
      getList() {
        return listRef.current?.getList() ?? []
      },
      scrollToInfo(info) {
        listRef.current?.scrollToInfo(info)
      },
    }))

    const hancelMultiSelect = () => {
      setIsMultiSelect(true)
      setSelectMode('single')
      setIsSelectAll(false)
      listRef.current?.setIsMultiSelectMode(true)
      listRef.current?.setSelectMode('single')
    }

    const hancelSwitchSelectMode = (mode: SelectMode) => {
      setSelectMode(mode)
      listRef.current?.setSelectMode(mode)
    }

    const hancelExitSelect = useCallback(() => {
      setIsMultiSelect(false)
      listRef.current?.setIsMultiSelectMode(false)
    }, [])

    const handleTopBarSelectAll = useCallback((isAll: boolean) => {
      setIsSelectAll(isAll)
      listRef.current?.selectAll(isAll)
    }, [])

    const handleBatchDownload = useCallback(() => {
      const selectedList = listRef.current?.getSelectedList() ?? []
      if (!selectedList.length) return
      void batchDownload(selectedList)
      hancelExitSelect()
    }, [hancelExitSelect])


    const showMenu = (musicInfo: LX.Music.MusicInfoOnline, index: number, position: Position) => {
      listMenuRef.current?.show(
        {
          musicInfo,
          index,
          single: false,
          selectedList: listRef.current!.getSelectedList(),
        },
        position,
      )
    }

    const handleAddMusic = (info: SelectInfo) => {
      if (info.selectedList.length) {
        listMusicMultiAddRef.current?.show({
          selectedList: info.selectedList,
          listId: '',
          isMove: false,
        })
      } else {
        listMusicAddRef.current?.show({ musicInfo: info.musicInfo, listId: '', isMove: false })
      }
    }

    const handleShowArtist = (info: SelectInfo) => {
      const componentId = componentId_raw ?? commonState.componentIds[commonState.componentIds.length - 1]?.id
      void handleShowArtistDetail(componentId, info.musicInfo)
    }

    const handleShowAlbum = (info: SelectInfo) => {
      const componentId = componentId_raw ?? commonState.componentIds[commonState.componentIds.length - 1]?.id
      handleShowAlbumDetail(componentId, info.musicInfo)
    }
    const handleMoveMusic = (info: SelectInfo) => {
      if (info.selectedList.length) {
        listMusicMultiAddRef.current?.show({ selectedList: info.selectedList, listId: listId!, isMove: true })
      } else {
        listMusicAddRef.current?.show({ musicInfo: info.musicInfo, listId: listId!, isMove: true })
      }
    }

    const handleRemoveMusic = useCallback(async(info: SelectInfo) => {
      if (!listId) return

      const musicInfos = info.selectedList.length ? info.selectedList : [info.musicInfo]

      // P0 修复：从在线歌单移除是直接写平台远端的操作，不可逆，必须先二次确认。
      // 原来点菜单里的「移除」就直接调平台接口，误触即丢歌。
      const confirmed = await confirmDialog({
        message: `确定从歌单中移除选中的 ${musicInfos.length} 首歌曲吗？此操作将同步到平台，不可撤销。`,
      })
      if (!confirmed) return

      if (listId.startsWith('wy__')) {
        const playlistId = listId.replace('wy__', '')
        const sourcePlaylist = subscribedPlaylists.find(p => String(p.id) === playlistId) as (SubscribedPlaylistInfo & { creator?: { nickname?: string } }) | undefined
        const songIds = musicInfos.map(m => m.meta.songId)
        wyApi.manipulatePlaylistTracks('del', playlistId, songIds).then(() => {
          if (sourcePlaylist?.name === sourcePlaylist?.creator?.nickname + '喜欢的音乐') {
            songIds.forEach(removeWyLikedSong)
          }
          toast(t('list_edit_action_tip_remove_success'))
          updateWySubscribedPlaylistTrackCount(playlistId, -songIds.length)
          clearListDetailCache('wy', playlistId)
          global.app_event.playlist_updated({ source: 'wy', listId: playlistId })
          hancelExitSelect()
        }).catch((err: Error) => {
          toast('移除失败: ' + err.message)
        })
      } else if (listId.startsWith('tx__')) {
        const playlistId = listId.replace('tx__', '')
        const songMids = musicInfos.map(m => String(m.meta.songId || m.id))
        txUserApi.removeSongFromPlaylist(playlistId, songMids).then(() => {
          toast(t('list_edit_action_tip_remove_success'))
          clearListDetailCache('tx', playlistId)
          global.app_event.playlist_updated({ source: 'tx', listId: playlistId })
          hancelExitSelect()
        }).catch(err => {
          toast('移除失败: ' + err.message)
        })
      } else if (listId.startsWith('kg__')) {
        if (!kgCookie) {
          toast('请先登录酷狗音乐，Cookie可能已失效')
          return
        }
        const playlistId = listId.replace('kg__', '')
        const numericListId = (() => {
          const parts = playlistId.split('_')
          return parts.length >= 4 ? Number(parts[3]) : Number(playlistId)
        })()
        if (!numericListId || isNaN(numericListId)) {
          toast('无法获取歌单ID')
          return
        }
        getKgPlaylistSongs(kgCookie, playlistId, 1, 500).then(async songsResult => {
          if (!songsResult.success || !songsResult.data?.list) {
            toast('获取歌单歌曲失败')
            return
          }
          const hashToFileId = new Map<string, number>()
          for (const song of songsResult.data.list) {
            if (song.songmid && song.fileId) hashToFileId.set(song.songmid.toLowerCase(), song.fileId)
          }
          const selectedHashes = musicInfos.map(m => {
            const meta = m.meta as any
            return (meta?.songmid || meta?.songId || m.id || '').toString().toLowerCase()
          }).filter(h => h)
          console.log('[KuGou] 歌单歌曲 hash 列表:', [...hashToFileId.keys()].slice(0, 5))
          console.log('[KuGou] 选中歌曲 hash:', selectedHashes.slice(0, 5))
          const fileids = selectedHashes.map(h => hashToFileId.get(h) || 0).filter(id => id > 0)
          if (fileids.length === 0) {
            toast('找不到对应的歌曲')
            return
          }
          return removeKgSongsFromPlaylist(kgCookie, numericListId, fileids)
        }).then(result => {
          if (!result) return
          if (result.success) {
            toast(t('list_edit_action_tip_remove_success'))
            clearListDetailCache('kg', playlistId)
            global.app_event.playlist_updated({ source: 'kg', listId: playlistId })
            hancelExitSelect()
          } else {
            toast('移除失败: ' + result.message)
          }
        }).catch(err => {
          toast('移除失败: ' + err.message)
        })
      } else if (listId === 'play_history') {
        // 播放历史不是平台歌单：走本地历史删除。
        // 此前这里没有分支，菜单里的「移除」点了没有任何反应（用户反馈「无法移除」）。
        // 行上带 playHistoryId（唯一一条）；没有时按歌曲 id 移除该歌的全部历史条目。
        const entryIds = musicInfos
          .map(m => (m as any).playHistoryId as string | undefined)
          .filter((id): id is string => !!id)
        const musicIds = musicInfos.map(m => m.id)
        void removePlayHistoryItems({ entryIds, musicIds })
          .then((removed) => {
            toast(removed ? t('list_edit_action_tip_remove_success') : '未找到可移除的历史记录')
            if (removed) hancelExitSelect()
          })
          .catch((err: Error) => {
            toast('移除失败: ' + err.message)
          })
      } else {
        toast('不支持的操作')
      }
    }, [listId, hancelExitSelect, t, subscribedPlaylists, kgCookie])

    return (
      <View style={styles.container}>
        <View style={{ flex: 1 }}>
          {/* 2026-10-04 Bug7：多选操作栏改到列表顶部（原悬浮窗已移除） */}
          <MultiSelectTopBar
            visible={isMultiSelect}
            selectMode={selectMode}
            isSelectAll={isSelectAll}
            onSwitchMode={hancelSwitchSelectMode}
            onSelectAll={handleTopBarSelectAll}
            onExitSelectMode={hancelExitSelect}
            onDownload={handleBatchDownload}
          />
          <List
            ref={listRef}
            listId={listId}
            onShowMenu={showMenu}
            onMuiltSelectMode={hancelMultiSelect}
            onSelectAll={(isAll) => setIsSelectAll(isAll)}
            onRefresh={onRefresh}
            onLoadMore={onLoadMore}
            onPlayList={onPlayList}
            progressViewOffset={progressViewOffset}
            ListHeaderComponent={ListHeaderComponent}
            ListFooterComponent={ListFooterComponent}
            checkHomePagerIdle={checkHomePagerIdle}
            rowType={rowType}
            playingId={playingId}
            forcePlayList={forcePlayList}
            onListUpdate={onListUpdate}
          />

        </View>
        <ListMusicAdd
          ref={listMusicAddRef}
          onAdded={hancelExitSelect}
        />
        <ListMusicMultiAdd
          ref={listMusicMultiAddRef}
          onAdded={hancelExitSelect}
        />
        <ListMenu
          ref={listMenuRef}
          listId={listId}
          isCreator={isCreator}
          onPlay={(info) => {
            handlePlay(info.musicInfo)
          }}
          onPlayLater={(info) => {
            hancelExitSelect()
            handlePlayLater(info.musicInfo, info.selectedList, hancelExitSelect)
          }}
          onAdd={handleAddMusic}
          onMove={handleMoveMusic}
          onRemove={handleRemoveMusic}
          onArtistDetail={handleShowArtist}
          onAlbumDetail={handleShowAlbum}
          onSimilarSongs={(info) => {
            similarSongsModalRef.current?.show(info.musicInfo)
          }}
          onDislikeMusic={(info) => {
            void handleDislikeMusic(info.musicInfo, listId)
          }}
          onDownload={(info) => { downloadMusic(info.musicInfo) }}
          onLike={(info) => {
            if (info.musicInfo.source === 'wy') {
              handleLikeMusic(info.musicInfo)
            } else if (info.musicInfo.source === 'tx') {
              handleTxLikeMusic(info.musicInfo)
            } else if (info.musicInfo.source === 'kg') {
              handleKgLikeMusic(info.musicInfo)
            }
          }}
          onClearCache={(info) => {
            void handleClearMusicCache(info.musicInfo)
          }}
        />
        <SimilarSongsModal ref={similarSongsModalRef} />
        {}
      </View>
    )
  },
)

const styles = createStyle({
  container: {
    flex: 1,
    overflow: 'hidden',
  },
  list: {
    flex: 1,
  },
  exitMultipleModeBtn: {
    height: 40,
  },
})
