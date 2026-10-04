import CookieManager from '@react-native-cookies/cookies'

const normalizeDomain = (domain: string) => domain.toLowerCase().replace(/^\./, '')

/** cookie domain 是否属于目标域（含子域），如 .ptlogin2.qq.com 属于 qq.com */
const isSubDomainOf = (cookieDomain: string, targetDomain: string) => {
  const d = normalizeDomain(cookieDomain)
  const t = normalizeDomain(targetDomain)
  return d === t || d.endsWith(`.${t}`)
}

/**
 * 按域名清理 Cookie（替代无差别的 clearAll）。
 *
 * 背景：@react-native-cookies/cookies 在 iOS 有两个独立的存储——
 * WKHTTPCookieStore（WebView 登录态实际所在，useWebKit=true）与
 * NSHTTPCookieStorage（RN fetch / NSURLSession 用，useWebKit=false）。
 * 原来退出登录时调 clearAll() 不带参数，只清掉了 NSHTTPCookieStorage，
 * WebView 里其实还登着；同时又误删了其他站点的原生 Cookie。
 *
 * 这里两个 store 都扫一遍，只删属于 targetDomain（含子域）的 Cookie，
 * 其他站点的登录态不受影响。
 */
export const clearDomainCookies = async(targetDomain: string): Promise<void> => {
  for (const useWebKit of [true, false]) {
    let all: Record<string, { name: string, domain?: string }>
    try {
      all = await CookieManager.getAll(useWebKit)
    } catch {
      continue
    }
    for (const cookie of Object.values(all ?? {})) {
      if (!cookie || !isSubDomainOf(cookie.domain ?? '', targetDomain)) continue
      // clearByName(url, name)：只删该 URL 归属站点的同名 Cookie（v6.2.1+ 起按 URL 限定），
      // 用 cookie 自身的 domain 组 URL，保证子域 Cookie 也能命中。
      const host = normalizeDomain(cookie.domain ?? '')
      if (!host) continue
      await CookieManager.clearByName(`https://${host}`, cookie.name, useWebKit).catch(() => {})
    }
  }
}
