import { useState, useEffect, useCallback } from 'react'
import type { Messages, Message } from './index'
import { messages } from './index'

type TranslateValues = Record<string, string | number | boolean>

type Langs = keyof Messages

type Hook = (locale: Langs) => void

export declare interface I18n {
  locale: Langs
  fallbackLocale: Langs
  availableLocales: Langs[]
  messages: Messages
  message: Message
  setLanguage: (locale: Langs) => void
  fillMessage: (message: string, val: TranslateValues) => string
  getMessage: (key: string, val?: TranslateValues) => string
  t: (key: string, val?: TranslateValues) => string
}

let locale: Langs = 'zh_cn'

let i18n: I18n

const hookTools = {
  hooks: [] as Hook[],
  add(hook: Hook) {
    this.hooks.push(hook)
  },
  remove(hook: Hook) {
    // 低：不在数组时 indexOf 为 -1，splice(-1, 1) 会误删最后一个仍挂载
    // 组件的语言 hook（其此后切换语言不再刷新）
    const i = this.hooks.indexOf(hook)
    if (i >= 0) this.hooks.splice(i, 1)
  },
  update(locale: Parameters<Hook>[0]) {
    for (const hook of this.hooks) hook(locale)
  },
}

const useI18n = () => {
  const [, updateLocale] = useState(i18n?.locale ?? 'zh_cn')
  // console.log('hook run')
  useEffect(() => {
    const hook: Hook = (locale) => {
      updateLocale(locale)
    }
    hookTools.add(hook)
    return () => {
      hookTools.remove(hook)
    }
  }, [])

  return useCallback(
    (key: string, val?: TranslateValues): string => {
      return i18n?.getMessage(key, val) ?? ''
    },
    [],
  )
}

const setLanguage = (lang: Langs) => {
  i18n.setLanguage(lang)
}

const createI18n = (_locale: Langs = locale): I18n => {
  locale = _locale

  return (i18n = {
    locale,
    fallbackLocale: 'zh_cn',
    availableLocales: Object.keys(messages) as Langs[],
    messages,
    message: messages[locale] ?? messages.zh_cn,
    setLanguage(_locale: Langs) {
      this.locale = _locale
      this.message = messages[_locale] ?? messages[this.fallbackLocale]
      hookTools.update(_locale)
    },
    fillMessage(message: string, vals: TranslateValues): string {
      for (const [key, val] of Object.entries(vals)) {
        // 低：函数式 replacer——填入值（远程歌名/歌手名）含 $$、$& 等时，
        // 字符串式 replace 会把它们当特殊模式展开导致显示错乱
        message = message.replace(new RegExp('{' + key + '}', 'g'), () => String(val))
      }
      return message
    },
    getMessage(key: string, val?: TranslateValues): string {
      const msg = (this.message ?? {}) as Record<string, string | undefined>
      const fallback = (this.messages[this.fallbackLocale] ?? {}) as Record<string, string | undefined>
      let targetMessage = msg[key] ?? fallback[key] ?? ''
      return val ? this.fillMessage(targetMessage, val) : targetMessage
    },
    t(key: string, val?: TranslateValues): string {
      return this.getMessage(key, val)
    },
  })
}

export { setLanguage, useI18n, createI18n }
