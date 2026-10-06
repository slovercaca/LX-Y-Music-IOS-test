import { useRef, useImperativeHandle, forwardRef, useState, useCallback } from 'react'
import { useI18n } from '@/lang'
import Menu, { type Menus, type MenuType, type Position } from '@/components/common/Menu'

export interface SelectInfo {
  musicInfo: LX.WebDAV.MusicInfo
  index: number
}

export interface WebDAVListMenuProps {
  onPlay: (selectInfo: SelectInfo) => void
  onPlayLater: (selectInfo: SelectInfo) => void
  onDownload: (selectInfo: SelectInfo) => void
  onFetchPicFromOnline: (selectInfo: SelectInfo) => void
  onSpecifyPicFile: (selectInfo: SelectInfo) => void
  onSpecifyLrcFile: (selectInfo: SelectInfo) => void
  onClearCustomMedia: (selectInfo: SelectInfo) => void
  onEditMetadata: (selectInfo: SelectInfo) => void
  onRemove: (selectInfo: SelectInfo) => void
  onLoadMetadata: (selectInfo: SelectInfo) => void
}
export interface WebDAVListMenuType {
  show: (selectInfo: SelectInfo, position: Position) => void
}

export type { Position }

export default forwardRef<WebDAVListMenuType, WebDAVListMenuProps>((props, ref) => {
  const t = useI18n()
  const [visible, setVisible] = useState(false)
  const menuRef = useRef<MenuType>(null)
  const [selectInfo, setSelectInfo] = useState<SelectInfo | null>(null)
  const [menus, setMenus] = useState<Menus>([])

  // P1-18：show() 时同步构建菜单，不依赖 useEffect 异步重建，
  // 避免快速点两首歌时第二次菜单内容滞后一次。
  const buildMenus = useCallback((info: SelectInfo): Menus => {
    const menu: Array<Menus[number]> = []
    menu.push({ action: 'playLater', label: t('play_later') })
    menu.push({ action: 'download', label: '下载' })
    menu.push({ action: 'fetchPicFromOnline', label: '在线封面' })
    menu.push({ action: 'specifyPicFile', label: '指定封面文件' })
    menu.push({ action: 'specifyLrcFile', label: '指定歌词文件' })
    // 已手动指定时，允许清除恢复自动获取
    if (info.musicInfo.meta.customPicPath || info.musicInfo.meta.customLrcPath) {
      menu.push({ action: 'clearCustomMedia', label: '清除手动指定' })
    }
    menu.push({ action: 'loadMetadata', label: '加载标签' })
    menu.push({ action: 'editMetadata', label: t('edit_metadata') })
    menu.push({ action: 'remove', label: t('delete') })
    return menu
  }, [t])

  useImperativeHandle(ref, () => ({
    show(info, position) {
      setSelectInfo(info)
      setMenus(buildMenus(info))
      if (visible) {
        menuRef.current?.show(position)
      } else {
        setVisible(true)
        requestAnimationFrame(() => {
          menuRef.current?.show(position)
        })
      }
    },
  }), [visible, buildMenus])

  const handleMenuPress = ({ action }: (typeof menus)[number]) => {
    const info = selectInfo
    if (!info) return
    switch (action) {
      case 'play': props.onPlay(info); break
      case 'playLater': props.onPlayLater(info); break
      case 'download': props.onDownload(info); break
      case 'fetchPicFromOnline': props.onFetchPicFromOnline(info); break
      case 'specifyPicFile': props.onSpecifyPicFile(info); break
      case 'specifyLrcFile': props.onSpecifyLrcFile(info); break
      case 'clearCustomMedia': props.onClearCustomMedia(info); break
      case 'loadMetadata': props.onLoadMetadata(info); break
      case 'editMetadata': props.onEditMetadata(info); break
      case 'remove': props.onRemove(info); break
      default:
        break
    }
  }

  return visible ? <Menu ref={menuRef} menus={menus} onPress={handleMenuPress} /> : null
})
