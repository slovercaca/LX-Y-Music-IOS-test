import { useRef, forwardRef, useImperativeHandle, useEffect } from 'react'
import Button from '@/components/common/Button'
import { useTheme } from '@/store/theme/hook'
import Modal, { type ModalType } from './Modal'
import { type ListInfoItem, type Source } from '@/store/songlist/state'
import { createStyle } from '@/utils/tools'
import { SvgIcon } from '@/components/common/Icon'
import { designRadius, designSpacing } from '@/theme/DesignTokens'

// export interface OpenListProps {
//   onTagChange: (name: string, id: string) => void
// }

interface OpenListProps {
  onOpenDetail: (item: ListInfoItem) => void
  /** 是否响应深链导入的全局事件（默认 true）。「我的歌单」页的实例应关掉：
   * 两个实例都订阅会一次弹两个叠加弹窗（高-8） */
  listenImportEvent?: boolean
}
export interface OpenListType {
  setInfo: (source: Source) => void
}


export default forwardRef<OpenListType, OpenListProps>(({ onOpenDetail, listenImportEvent = true }, ref) => {
  const theme = useTheme()
  const modalRef = useRef<ModalType>(null)
  const songlistInfoRef = useRef<{ source: Source }>({ source: 'kw' })

  useImperativeHandle(ref, () => ({
    setInfo(source) {
      songlistInfoRef.current.source = source
    },
  }))

  useEffect(() => {
    // 高-8：只有歌单广场页的实例响应深链导入事件（深链本就切到该页），
    // 「我的歌单」页实例只保留自己的 + 按钮，避免双弹窗叠加
    if (!listenImportEvent) return
    const handleOpenModal = (source: Source) => {
      songlistInfoRef.current.source = source
      modalRef.current?.show(source)
    }
    (global.app_event as any).on('_openSonglistModal', handleOpenModal)
    return () => {
      (global.app_event as any).off('_openSonglistModal', handleOpenModal)
    }
  }, [listenImportEvent])

  const handleOpenSonglist = (id: string) => {
    // console.log(id, songlistInfoRef.current.source)
    // navigations.pushSonglistDetailScreen(commonState.componentIds.home!, {
    //   play_count: undefined,
    //   id,
    //   author: '',
    //   name: '',
    //   img: undefined,
    //   desc: undefined,
    //   source: songlistInfoRef.current.source,
    // })
    onOpenDetail({
      play_count: undefined,
      id,
      author: '',
      name: '',
      img: undefined,
      desc: undefined,
      source: songlistInfoRef.current.source,
    })
  }

  // const handleSourceChange: ModalProps['onSourceChange'] = (source) => {
  //   songlistInfoRef.current.source = source
  // }

  return (
    <>
      <Button
        style={{ ...styles.button, backgroundColor: theme['c-button-background'] }}
        onPress={() => modalRef.current?.show(songlistInfoRef.current.source)}
      >
        <SvgIcon name="plus" size={20} color={theme['c-primary']} />
      </Button>
      <Modal ref={modalRef} onOpenId={handleOpenSonglist} />
    </>
  )
})

const styles = createStyle({
  button: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: designSpacing.sm,
    borderRadius: designRadius.pill,
  },
})
