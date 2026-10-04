import { useState, useRef, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react'
import { Animated, View, TouchableOpacity, StyleSheet } from 'react-native'

import Text from '@/components/common/Text'
import Button from '@/components/common/Button'
import UtilityGlass from '@/components/common/UtilityGlass'
import { useTheme } from '@/store/theme/hook'
import { useSafeAreaBottom } from '@/store/common/hook'
import { createStyle } from '@/utils/tools'
import { shadow } from '@/utils/shadow'
import { scaleSizeH } from '@/utils/pixelRatio'
import { designRadius, designSpacing } from '@/theme/DesignTokens'

export type SelectMode = 'single' | 'range'

export const MULTI_SELECT_BAR_HEIGHT = scaleSizeH(40)

export interface MultipleModeBarProps {
  onSwitchMode: (mode: SelectMode) => void
  onSelectAll: (isAll: boolean) => void
  onExitSelectMode: () => void
  onDownload: () => void
}
export interface MultipleModeBarType {
  show: () => void
  setIsSelectAll: (isAll: boolean) => void
  setSwitchMode: (mode: SelectMode) => void
  exitSelectMode: () => void
}

export default forwardRef<MultipleModeBarType, MultipleModeBarProps>(
  ({ onSelectAll, onSwitchMode, onExitSelectMode, onDownload }, ref) => {
    // const isGetDetailFailedRef = useRef(false)
    const [visible, setVisible] = useState(false)
    const [animatePlayed, setAnimatPlayed] = useState(true)
    const animFade = useRef(new Animated.Value(0)).current
    const animTranslateY = useRef(new Animated.Value(0)).current
    const [selectMode, setSelectMode] = useState<SelectMode>('single')
    const [isSelectAll, setIsSelectAll] = useState(false)
    const theme = useTheme()
    const safeAreaBottom = useSafeAreaBottom()

    useImperativeHandle(ref, () => ({
      show() {
        handleShow()
      },
      setIsSelectAll(isAll) {
        setIsSelectAll(isAll)
      },
      setSwitchMode(mode: SelectMode) {
        setSelectMode(mode)
      },
      exitSelectMode() {
        handleHide()
      },
    }))

    const handleShow = useCallback(() => {
      // console.log('show List')
      setVisible(true)
      setAnimatPlayed(false)
      requestAnimationFrame(() => {
        animTranslateY.setValue(20)

        Animated.parallel([
          Animated.timing(animFade, {
            toValue: 0.92,
            duration: 200,
            useNativeDriver: true,
          }),
          Animated.timing(animTranslateY, {
            toValue: 0,
            duration: 200,
            useNativeDriver: true,
          }),
        ]).start(() => {
          setAnimatPlayed(true)
        })
      })
    }, [animFade, animTranslateY])

    const handleHide = useCallback(() => {
      setAnimatPlayed(false)
      Animated.parallel([
        Animated.timing(animFade, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(animTranslateY, {
          toValue: 20,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start((finished) => {
        if (!finished) return
        setVisible(false)
        setAnimatPlayed(true)
      })
    }, [animFade, animTranslateY])

    const animaStyle = useMemo(
      () => ({
        ...styles.container,
        height: MULTI_SELECT_BAR_HEIGHT,
        // 悬浮在迷你播放器胶囊上方：胶囊 + tab 栏最高约到 safeAreaBottom + 150
        bottom: 160 + safeAreaBottom,
        // 背景改由内层 UtilityGlass 提供（2026-10-04 浮动工具玻璃）：
        // 纯色 backgroundColor 会挡住玻璃的折射/模糊，必须去掉。
        borderColor: theme['c-border-background'],
        opacity: animFade, // Bind opacity to animated value
        transform: [{ translateY: animTranslateY }],
      }),
      [animFade, animTranslateY, theme, safeAreaBottom],
    )

    const handleSelectAll = useCallback(() => {
      const selectAll = !isSelectAll
      setIsSelectAll(selectAll)
      onSelectAll(selectAll)
    }, [isSelectAll, onSelectAll])

    const component = useMemo(() => {
      return (
        <Animated.View style={animaStyle}>
          <UtilityGlass
            glassStyle={{ borderRadius: designRadius.lg }}
            fallbackBackgroundColor={theme['c-content-background']}
            style={styles.glassInner}
          >
          <View style={styles.switchBtn}>
            <Button
              onPress={() => {
                onSwitchMode('single')
              }}
              style={{
                ...styles.btn,
                backgroundColor:
                  selectMode == 'single' ? theme['c-button-background'] : 'rgba(0,0,0,0)',
              }}
            >
              <Text color={theme['c-button-font']}>{global.i18n.t('list_select_single')}</Text>
            </Button>
            <Button
              onPress={() => {
                onSwitchMode('range')
              }}
              style={{
                ...styles.btn,
                backgroundColor:
                  selectMode == 'range' ? theme['c-button-background'] : 'rgba(0,0,0,0)',
              }}
            >
              <Text color={theme['c-button-font']}>{global.i18n.t('list_select_range')}</Text>
            </Button>
          </View>

          <TouchableOpacity onPress={onDownload} style={styles.btn}>
            <Text color={theme['c-button-font']}>{global.i18n.t('download')}</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={handleSelectAll} style={styles.btn}>
            <Text color={theme['c-button-font']}>
              {global.i18n.t(isSelectAll ? 'list_select_unall' : 'list_select_all')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onExitSelectMode} style={styles.btn}>
            <Text color={theme['c-button-font']}>{global.i18n.t('list_select_cancel')}</Text>
          </TouchableOpacity>
          </UtilityGlass>
        </Animated.View>
      )
    }, [
      animaStyle,
      selectMode,
      theme,
      handleSelectAll,
      isSelectAll,
      onExitSelectMode,
      onSwitchMode,
      onDownload,
    ])

    return !visible && animatePlayed ? null : component
  },
)

const styles = createStyle({
  container: {
    position: 'absolute',
    left: designSpacing.md,
    right: designSpacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: designSpacing.xs,
    borderRadius: designRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    ...shadow(2),
    overflow: 'hidden',
  },
  // 内层玻璃容器：填满 Animated.View，接管横向布局（容器本身只留定位/动画/边框）
  glassInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: designSpacing.xs,
  },
  switchBtn: {
    flexDirection: 'row',
    flex: 1,
  },
  btn: {
    // flex: 1,
    paddingLeft: 18,
    paddingRight: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
