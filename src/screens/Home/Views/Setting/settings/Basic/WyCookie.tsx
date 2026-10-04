import { memo, useEffect } from 'react'
import { View } from 'react-native'
import InputItem, { type InputItemProps } from '../../components/InputItem'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { createStyle, toast } from '@/utils/tools'
import CookieManager from '@react-native-cookies/cookies'


const syncCookieToNative = async(cookie: string) => {
  const domain = 'https://music.163.com'
  try {
    // P0 修复：只处理 music.163.com 域的 Cookie。原来 clearAll(true) 会连带清掉
    // QQ/酷狗等其他站点的 WebView 登录态，导致用户被迫重新登录。
    // 注意 store 选择与原逻辑保持一致：set 不传 useWebKit，写的是
    // NSHTTPCookieStorage（RN fetch / NSURLSession 用）；WebKit store
    //（WebView 的登录态）不再被误删，登录态得以保留。
    const wantedNames = new Set<string>()
    const pairs: Array<{ name: string, value: string }> = []
    if (cookie) {
      for (const pair of cookie.split(';').map(p => p.trim())) {
        const idx = pair.indexOf('=')
        if (idx <= 0) continue
        const name = pair.slice(0, idx).trim()
        const value = pair.slice(idx + 1).trim()
        if (!name) continue
        wantedNames.add(name)
        pairs.push({ name, value })
      }
    }
    // 删掉该域下残留、但不在新 Cookie 串里的旧 key（用户可能粘贴了更短的串）
    const existing = await CookieManager.get(domain).catch(() => ({}))
    for (const name of Object.keys(existing ?? {})) {
      if (!wantedNames.has(name)) {
        await CookieManager.clearByName(domain, name).catch(() => {})
      }
    }
    // 写入/覆盖：set 同名同域同 path 即覆盖，无需先清
    for (const { name, value } of pairs) {
      await CookieManager.set(domain, {
        name,
        value,
        domain: '.music.163.com',
        path: '/',
      })
    }
    console.log('Native cookie synchronized successfully.')
  } catch (error) {
    console.error('Failed to sync native cookie:', error)
    toast('Cookie 同步失败，部分请求可能异常', 'long')
  }
}

export default memo(() => {
  const t = useI18n()
  const cookie = useSettingValue('common.wy_cookie')

  const setCookie = (val: string) => {
    void syncCookieToNative(val).then(() => {
      updateSetting({ 'common.wy_cookie': val })
    })
  }

  const handleChanged: InputItemProps['onChanged'] = (text, callback) => {
    callback(text)
    setCookie(text)
  }

  useEffect(() => {
    const handleCookieSet = (cookie: string) => {
      setCookie(cookie)
    };

    (global.app_event as any).on('wy-cookie-set', handleCookieSet)
    return () => {
      (global.app_event as any).off('wy-cookie-set', handleCookieSet)
    }
  }, [])

  return (
    <View style={styles.content}>
      <InputItem
        value={cookie}
        label={t('setting_basic_wy_cookie')}
        onChanged={handleChanged}
        placeholder={t('setting_basic_wy_cookie_placeholder')}
      />
    </View>
  )
})

const styles = createStyle({
  content: {
    // marginTop: 10,
  },
})
