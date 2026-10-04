import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react'
import { View, TouchableOpacity } from 'react-native'

import Modal, { type ModalType } from './Modal'
import GlassSurface from './GlassSurface'
import { Icon } from '@/components/common/Icon'
import { useKeyboard, useHorizontalMode } from '@/utils/hooks'
import { createStyle } from '@/utils/tools'
import { shadow } from '@/utils/shadow'
import { useTheme } from '@/store/theme/hook'
import Text from './Text'
import { useStatusbarHeight, useSafeAreaBottom } from '@/store/common/hook'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'

const styles = createStyle({
  centeredView: {
    flex: 1,
    // justifyContent: 'flex-end',
    // alignItems: 'center',
  },
  modalView: {
    // iOS 浮层阴影（仅 iPhone/iPad）
    ...shadow(6),
    flexGrow: 0,
    flexShrink: 1,
  },
  header: {
    flex: 0,
    flexDirection: 'row',
    borderTopLeftRadius: designRadius.lg,
    borderTopRightRadius: designRadius.lg,
  },
  title: {
    flex: 1,
    paddingLeft: designSpacing.md,
    paddingRight: designSpacing.xl,
    paddingTop: designSpacing.sm,
    paddingBottom: designSpacing.sm,
    fontWeight: '600',
  },
  closeBtn: {
    position: 'absolute',
    right: 0,
    // borderTopRightRadius: 8,
    flexGrow: 0,
    flexShrink: 0,
    height: 36,
    width: 36,
    justifyContent: 'center',
    alignItems: 'center',
    // backgroundColor: '#eee',
  },
})

export interface PopupProps {
  onHide?: () => void
  keyHide?: boolean
  bgHide?: boolean
  closeBtn?: boolean
  position?: 'top' | 'left' | 'right' | 'bottom'
  title?: string
  children: React.ReactNode
}

export interface PopupType {
  setVisible: (visible: boolean) => void
}

export default forwardRef<PopupType, PopupProps>(
  (
    {
      onHide = () => {},
      keyHide = true,
      bgHide = true,
      closeBtn = true,
      position = 'bottom',
      title = '',
      children,
    }: PopupProps,
    ref,
  ) => {
    const theme = useTheme()
    const { keyboardShown, keyboardHeight } = useKeyboard()
    const statusBarHeight = useStatusbarHeight()
    const isHorizontal = useHorizontalMode()
    const safeAreaBottom = useSafeAreaBottom()

    const modalRef = useRef<ModalType>(null)

    useImperativeHandle(ref, () => ({
      setVisible(visible: boolean) {
        modalRef.current?.setVisible(visible)
      },
    }))

    const closeBtnComponent = useMemo(
      () =>
        closeBtn ? (
          <TouchableOpacity
            style={styles.closeBtn}
            onPress={() => modalRef.current?.setVisible(false)}
          >
            <Icon name="close" style={{ color: theme['c-font-label'] }} size={12} />
          </TouchableOpacity>
        ) : null,
      [closeBtn, theme],
    )

    const [centeredViewStyle, modalViewStyle] = useMemo(() => {
      switch (position) {
        case 'top':
          return [
            {
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              top: 0,
              justifyContent: 'flex-start',
            },
            {
              width: '100%',
              maxWidth: isHorizontal ? 760 : undefined,
              alignSelf: isHorizontal ? 'center' : undefined,
              maxHeight: '78%',
              minHeight: '20%',
              // backgroundColor: 'white',
            },
          ] as const
        case 'left':
          return [
            {
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              top: 0,
              flexDirection: 'row',
              justifyContent: 'flex-start',
            },
            {
              minWidth: isHorizontal ? undefined : '45%',
              width: isHorizontal ? 420 : undefined,
              maxWidth: isHorizontal ? undefined : '78%',
              height: '100%',
              paddingTop: statusBarHeight,
              // backgroundColor: 'white',
            },
          ] as const
        case 'right':
          return [
            {
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              top: 0,
              flexDirection: 'row',
              justifyContent: 'flex-end',
            },
            {
              minWidth: isHorizontal ? undefined : '45%',
              width: isHorizontal ? 420 : undefined,
              maxWidth: isHorizontal ? undefined : '78%',
              height: '100%',
              paddingTop: statusBarHeight,
              // backgroundColor: 'white',
            },
          ] as const
        case 'bottom':
        default:
          return [
            {
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              top: 0,
              justifyContent: 'flex-end',
            },
            {
              width: '100%',
              maxWidth: isHorizontal ? 760 : undefined,
              alignSelf: isHorizontal ? 'center' : undefined,
              maxHeight: '78%',
              minHeight: '20%',
              // backgroundColor: 'white',
              borderTopLeftRadius: designRadius.lg,
              borderTopRightRadius: designRadius.lg,
            },
          ] as const
      }
    }, [position, statusBarHeight, isHorizontal])

    return (
      <Modal
        onHide={onHide}
        keyHide={keyHide}
        bgHide={bgHide}
        bgColor="rgba(50,50,50,.2)"
        ref={modalRef}
      >
        <View
          style={{
            ...styles.centeredView,
            ...centeredViewStyle,
            paddingBottom: keyboardShown ? keyboardHeight : position === 'bottom' ? safeAreaBottom : 0,
          }}
          pointerEvents="box-none"
        >
          <GlassSurface
            glassStyle={
              position === 'bottom'
                ? {
                    borderTopLeftRadius: designRadius.lg,
                    borderTopRightRadius: designRadius.lg,
                    // 底部安全区延伸（2026-10-04 全局玻璃）：玻璃 bottom 取负值直接画到
                    // 屏幕底边，一块玻璃无缝覆盖面板 + 安全区，替代原来的纯色延伸子视图
                    // （已删除——纯色会挡住玻璃）。键盘弹起时面板被顶上去，不延伸
                    // （与原来一致）。
                    bottom: !keyboardShown && safeAreaBottom > 0 ? -safeAreaBottom : 0,
                  }
                : undefined
            }
            style={{
              ...styles.modalView,
              ...modalViewStyle,
            }}
            onStartShouldSetResponder={() => true}
          >
            <View style={styles.header}>
              <Text size={designTypography.body} style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              {closeBtnComponent}
            </View>
            {children}
          </GlassSurface>
        </View>
      </Modal>
    )
  },
)
