import { memo, useEffect, useState } from 'react'
import { View, TouchableOpacity } from 'react-native'

import Section from '../components/Section'

import { createStyle, openUrl } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { designSpacing, designTypography } from '@/theme/DesignTokens'
import Text from '@/components/common/Text'
import { getVersionInfo } from '@/utils/nativeModules/utils'

// package.json 里的 version 只是打包时的快照，可能与实际安装包不一致，仅作原生读取失败时的兜底
const getFallbackVersion = (): string => {
  try {
    // RN 环境的 process 由 metro polyfill，globalData 启动时已写入 versions.app。
    // （@types/node 的 ProcessVersions 带 string 索引签名，这里已无需 @ts-expect-error 压制。）
    return process.versions?.app ?? ''
  } catch {
    return ''
  }
}

export default memo(() => {
  const theme = useTheme()
  // 当前安装包的版本号：优先读运行中的主包（CI 构建时按日期注入，如 20260926）
  const [version, setVersion] = useState(getFallbackVersion())
  useEffect(() => {
    void getVersionInfo().then((v) => {
      if (v) setVersion(v)
    })
  }, [])
  const openHomePage = () => {
    void openUrl('https://github.com/slovercaca/LX-Y-Music-IOS-test')
  }
  const openOriginRepo = () => {
    void openUrl('https://github.com/1970905901/LX-Y-Music-IOS#readme')
  }
  const openUpstreamIos = () => {
    void openUrl('https://github.com/Q-1515/lx-music-mobile/tree/ios-adaptation')
  }
  const openUpstreamDebug = () => {
    void openUrl('https://github.com/WalnutBai/lx-lxwalnut-music-mobile/tree/main-debug')
  }

  const textLinkStyle = {
    ...styles.link,
    textDecorationLine: 'underline',
    color: theme['c-primary-font'],
  } as const

  return (
    <Section sectionId="setting_about">
      <View style={styles.part}>
        <Text style={{ ...styles.text, color: theme['c-font'] }}>
          当前版本：<Text style={styles.boldText}>{version || '未知'}</Text>
        </Text>
      </View>
      <View style={styles.part}>
        <Text style={{ ...styles.text, color: theme['c-font'] }}>
          本软件是 LX-Y Music 的 iOS 二次修改版（代号 Sea），完全免费、代码开源。项目地址：
        </Text>
        <TouchableOpacity onPress={openHomePage}>
          <Text style={textLinkStyle}>https://github.com/slovercaca/LX-Y-Music-IOS-test</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.part}>
        <Text style={{ ...styles.text, color: theme['c-font'] }}>
          本版在原项目基础上调整了界面效果（液态玻璃）、WebDAV 音乐库、下载与本地文件管理、离线模式等功能，仅以个人学习与使用为目的发布。
        </Text>
      </View>
      <View style={styles.part}>
        <Text style={{ ...styles.text, color: theme['c-font'] }}>
          本项目唯一的发布地址是上面的 GitHub 仓库，其他渠道均为第三方转载，可信度请自行鉴别；本项目没有微信公众号等「官方账号」，也未在任何应用商店发布。
        </Text>
      </View>
      <View style={styles.part}>
        <Text style={{ ...styles.text, color: theme['c-font'] }}>
          若你使用过程中遇到<Text style={styles.boldText}>广告</Text>或者
          <Text style={styles.boldText}>引流</Text>
          （如需要加群、关注公众号之类才能使用或者升级）的信息，则表明你当前运行的软件是被第三方再次修改过的版本，与本项目无关。
        </Text>
      </View>
      <View style={styles.part}>
        <Text style={{ ...styles.text, color: theme['c-font'] }}>
          若在升级新版本时提示「<Text style={styles.boldText}>签名不一致</Text>
          」，说明手机上的旧版本与将要安装的新版本不是同一来源，请确认下载来源后再安装。
        </Text>
      </View>
      <View style={styles.part}>
        <Text style={styles.boldText}>致谢</Text>
        <Text style={{ ...styles.text, color: theme['c-font'] }}>
          本软件基于以下上游项目构建（依 Apache 2.0 协议署名），在此致以诚挚的感谢：
        </Text>
        <TouchableOpacity onPress={openOriginRepo}>
          <Text style={textLinkStyle}>1970905901/LX-Y-Music-IOS（原项目）</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={openUpstreamIos}>
          <Text style={textLinkStyle}>Q-1515/lx-music-mobile (ios-adaptation)</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={openUpstreamDebug}>
          <Text style={textLinkStyle}>WalnutBai/lx-lxwalnut-music-mobile (main-debug)</Text>
        </TouchableOpacity>
      </View>
    </Section>
  )
})

const styles = createStyle({
  part: {
    marginBottom: designSpacing.sm,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  text: {
    fontSize: designTypography.body,
    lineHeight: 24,
  },
  link: {
    fontSize: designTypography.body,
    lineHeight: 24,
  },
  boldText: {
    fontSize: designTypography.body,
    fontWeight: 'bold',
    lineHeight: 24,
  },
})
