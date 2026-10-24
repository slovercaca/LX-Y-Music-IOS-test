import { useEffect, useState } from 'react'
import { StyleSheet } from 'react-native'
import Image, { getSize, type ImageProps } from '@/components/common/Image'

export interface ScaledImageProps extends Pick<ImageProps, 'style'> {
  url: string
  width?: number
  height?: number
  maxWidth?: number
  maxHeight?: number
}

export default ({ url, width, height, maxWidth, maxHeight, style }: ScaledImageProps) => {
  const [wh, setWH] = useState({ width: 0, height: 0 })

  useEffect(() => {
    // 低：补失败回退与取消标记——此前 getSize 失败永不显示、url 切换后
    // 旧请求迟到还会用旧尺寸覆盖新图
    let cancelled = false
    getSize(url, (realWidth, realHeight) => {
      if (cancelled) return
      let w = width ?? 0
      let h = height ?? 0

      if (w && !h) {
        h = realHeight * (w / realWidth)
      } else if (!w && h) {
        w = realWidth * (h / realHeight)
      } else {
        if (maxWidth && realWidth > maxWidth) {
          w = maxWidth
          h = realHeight * (w / realWidth)

          if (maxHeight && h > maxHeight) {
            w = realWidth * (maxHeight / realHeight)
            h = maxHeight
          }
        } else if (maxHeight && realHeight > maxHeight) {
          // 2026-10-05 fix（P1-2）：用 maxHeight 而非 h（h 此时为 0），否则宽度回退 realWidth 被横向拉伸
          w = realWidth * (maxHeight / realHeight)
          h = maxHeight
        }
      }
      setWH({ width: w || realWidth, height: h || realHeight })
    }, () => {
      if (cancelled) return
      // 失败回退：用给定/上限尺寸占位显示，避免永久空白
      setWH({ width: width || maxWidth || 100, height: height || maxHeight || 100 })
    })
    return () => { cancelled = true }
  }, [height, maxHeight, maxWidth, url, width])

  return wh.width ? (
    <Image url={url} style={StyleSheet.compose({ height: wh.height, width: wh.width }, style)} />
  ) : null
}
