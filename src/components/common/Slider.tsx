import { memo } from 'react'

import Slider, { type SliderProps as _SliderProps } from '@react-native-community/slider'
import { createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'

export type SliderProps = Pick<
_SliderProps,
| 'value'
| 'minimumValue'
| 'maximumValue'
| 'onSlidingStart'
| 'onSlidingComplete'
| 'onValueChange'
| 'step'
>

export default memo(
  ({
    value,
    minimumValue,
    maximumValue,
    onSlidingStart,
    onSlidingComplete,
    onValueChange,
    step,
  }: SliderProps) => {
    const theme = useTheme()

    const handleValueChange = (value: number) => {
      // 低：此前不传 minimumValue 时回调被整体吞掉（现行调用方都传了才没暴露）
      if (onValueChange) onValueChange(minimumValue != null ? Math.max(value, minimumValue) : value)
    }

    return (
      <Slider
        value={value}
        style={styles.slider}
        minimumValue={minimumValue}
        maximumValue={maximumValue}
        minimumTrackTintColor={theme['c-primary-alpha-500']}
        maximumTrackTintColor={theme['c-primary-alpha-500']}
        thumbTintColor={theme['c-primary']}
        onSlidingStart={onSlidingStart}
        onSlidingComplete={onSlidingComplete}
        onValueChange={handleValueChange}
        step={step}
      />
    )
  },
)

const styles = createStyle({
  slider: {
    flexShrink: 0,
    flexGrow: 1,
    // width: '100%',
    // maxWidth: 300,
    height: 40,
    // backgroundColor: '#eee',
  },
})
