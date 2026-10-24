import { useCallback, useMemo, useRef, useImperativeHandle, forwardRef, useState } from 'react'
import { View } from 'react-native'
import { useI18n } from '@/lang'
import Menu, { type MenuType, type Position, type Menus } from '@/components/common/Menu'
import userState from '@/store/user/state'
import { Icon } from '@/components/common/Icon'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'

export interface SelectInfo {
  musicInfo: LX.Music.MusicInfo
}

const initSelectInfo = {}

export interface PlayDetailMenuProps {
  onAdd: (selectInfo: SelectInfo) => void
  onDownload: (selectInfo: SelectInfo) => void
  onDislikeMusic: (selectInfo: SelectInfo) => void
  onArtistDetail: (selectInfo: SelectInfo) => void
  onAlbumDetail: (selectInfo: SelectInfo) => void
  onSimilarSongs: (selectInfo: SelectInfo) => void
  onLike: (selectInfo: SelectInfo) => void
  onClearCache: (selectInfo: SelectInfo) => void
}

export interface PlayDetailMenuType {
  show: (selectInfo: SelectInfo, position: Position) => void
}

export type { Position }

export default forwardRef<PlayDetailMenuType, PlayDetailMenuProps>((props, ref) => {
  const t = useI18n()
  const theme = useTheme()
  const [visible, setVisible] = useState(false)
  const menuRef = useRef<MenuType>(null)
  const selectInfoRef = useRef<SelectInfo>(initSelectInfo as SelectInfo)
  // 中-11：menus 的 useMemo 此前只依赖 isLiked 等，读的却是 ref 里的歌曲——
  // isLiked 值不变时切歌不重算，菜单按上一首歌生成（源专属项缺失/残留）。
  // show() 时把当前歌曲存进 state 作为重算依据。
  const [currentSelectInfo, setCurrentSelectInfo] = useState<SelectInfo>(initSelectInfo as SelectInfo)
  const [isLiked, setIsLiked] = useState(false)

  const renderLikeLabel = useCallback((liked: boolean) => (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Icon name={liked ? 'love-filled' : 'love'} size={16} color={liked ? theme['c-liked'] : theme['c-350']} />
      <View style={{ width: 6 }} />
      <Text size={15} color={theme['c-font']}>{liked ? '取消喜欢' : '喜欢'}</Text>
    </View>
  ), [theme])

  useImperativeHandle(ref, () => ({
    show(selectInfo, position) {
      selectInfoRef.current = selectInfo
      setCurrentSelectInfo(selectInfo)
      if (selectInfo.musicInfo.source === 'wy') {
        setIsLiked(userState.wy_liked_song_ids.has(String(selectInfo.musicInfo.meta.songId)))
      } else if (selectInfo.musicInfo.source === 'tx') {
        const songId = (selectInfo.musicInfo.meta as any).id
        const songMid = (selectInfo.musicInfo.meta as any).songmid || (selectInfo.musicInfo.meta as any).strMediaMid || selectInfo.musicInfo.id
        const likeKey = songId && /^\d+$/.test(String(songId)) ? String(songId) : songMid
        setIsLiked(userState.tx_liked_song_ids.has(likeKey))
      } else if (selectInfo.musicInfo.source === 'kg') {
        setIsLiked(userState.kg_liked_song_ids.has(String((selectInfo.musicInfo.meta as any)?.hash || selectInfo.musicInfo.meta.songId)))
      }
      if (visible) {
        menuRef.current?.show(position)
      } else {
        setVisible(true)
        requestAnimationFrame(() => {
          menuRef.current?.show(position)
        })
      }
    },
  }))

  const menus = useMemo((): Menus => {
    const musicInfo = currentSelectInfo.musicInfo
    const menuItems: Array<Menus[number]> = []
    menuItems.push({ action: 'download', label: t('download') })

    if (musicInfo?.source === 'wy') {
      menuItems.push({ action: 'like', label: renderLikeLabel(isLiked) })
      menuItems.push({ action: 'artistDetail', label: t('artist_detail') })
      menuItems.push({ action: 'albumDetail', label: t('album_detail') })
      menuItems.push({ action: 'similarSongs', label: '相似歌曲' })
    }

    if (musicInfo?.source === 'tx') {
      menuItems.push({ action: 'like', label: renderLikeLabel(isLiked) })
      menuItems.push({ action: 'artistDetail', label: t('artist_detail') })
      menuItems.push({ action: 'albumDetail', label: t('album_detail') })
      menuItems.push({ action: 'similarSongs', label: '相似歌曲' })
    }

    if (musicInfo?.source === 'kg') {
      menuItems.push({ action: 'like', label: renderLikeLabel(isLiked) })
      menuItems.push({ action: 'artistDetail', label: t('artist_detail') })
      menuItems.push({ action: 'albumDetail', label: t('album_detail') })
    }

    menuItems.push({ action: 'clearCache', label: t('clear_music_cache') })

    return menuItems
  }, [t, isLiked, renderLikeLabel, currentSelectInfo])

  const handleMenuPress = ({ action }: (typeof menus)[number]) => {
    const selectInfo = selectInfoRef.current
    switch (action) {
      case 'like':
        props.onLike(selectInfo)
        break
      case 'download':
        props.onDownload(selectInfo)
        break
      case 'artistDetail':
        props.onArtistDetail(selectInfo)
        break
      case 'albumDetail':
        props.onAlbumDetail(selectInfo)
        break
      case 'similarSongs':
        props.onSimilarSongs(selectInfo)
        break
      case 'clearCache':
        props.onClearCache(selectInfo)
        break
      default:
        break
    }
  }

  return visible ? <Menu ref={menuRef} menus={menus} onPress={handleMenuPress} /> : null
})
