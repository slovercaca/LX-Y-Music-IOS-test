import { Alert } from 'react-native'
// import { exitApp } from '@/utils/common'
import { setJSExceptionHandler, setNativeExceptionHandler } from 'react-native-exception-handler'
import { log } from '@/utils/log'
import { toast } from './tools'

const errorHandler = (e: Error, isFatal: boolean) => {
  const excludedErrors = [
    'Failed to construct \'Response\'',
  ]
  if (isFatal) {
    if (excludedErrors.some((excludedError) => e.message.includes(excludedError))) {
      toast('应用遇到了错误，如果你有固定的重现方式，请截图并在 GitHub 反馈（并附上刚才你进行了什么操作，以及“设置-错误日志”的内容）')
    } else {
      Alert.alert(
        '💥Unexpected error occurred💥',
        `
  应用出 bug 了😭，以下是错误异常信息。请截图并在 GitHub 反馈（并附上刚才你进行了什么操作，以及附上“设置-错误日志”的内容）。现在应用可能会出现异常，若出现异常请尝试强制结束应用后重新启动！

  Error:
  ${isFatal ? 'Fatal:' : ''} ${e.name} ${e.message}

  Stack:
  ${e.stack ?? '(no stack)'}
  `,
        [{
          text: '关闭 (Close)',
          onPress: () => {
            // exitApp()
          },
        }],
      )
    }
  }
  // 2026-10-24：此前只记 e.stack，异常无 stack 时日志就是裸的
  // “时间 + ERROR”一行，真错丢失。改记 name + message + stack，
  // 三者全空时也给占位和类型，绝不打空日志。
  log.error(`[JSException] name=${e?.name ?? 'unknown'} message=${e?.message ?? '(no message)'} stack=${e?.stack ?? '(no stack)'}`)
}

if (process.env.NODE_ENV !== 'development') {
  setJSExceptionHandler(errorHandler)

  setNativeExceptionHandler((errorString) => {
    log.error(`[NativeException] ${errorString || '(empty native error string)'}`)
    console.log('+++++', errorString, '+++++')
  }, false)
}
