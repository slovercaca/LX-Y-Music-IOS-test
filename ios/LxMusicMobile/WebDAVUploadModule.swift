//
//  WebDAVUploadModule.swift
//  LX-Y Music
//
//  WebDAV 文件上传原生模块（Test-v2）。
//
//  为什么需要原生模块：
//  - RN 的 XHR+Blob 在 iOS 上频繁触发 NSDictionary nil 崩溃，JS 层无法根治
//  - webdav 库的 putFileContents 无进度回调、无 abort、大文件占内存
//  - RNFS.uploadFiles 是 multipart，不适用于 WebDAV raw PUT
//
//  本模块用 URLSession.uploadTask(with:fromFile:) 实现：
//  - 流式上传：文件不进内存，支持大文件
//  - 真实字节进度：URLSessionTaskDelegate 回调
//  - 可中断：task.cancel()
//  - Raw PUT：body 为文件原始字节，非 multipart
//
//  性能设计：
//  - 全模块共享一个 URLSession（连接复用、TLS 会话复用、HTTP/2）
//  - 单一 delegate 按 taskIdentifier 路由进度，避免每任务建 session 的开销
//  - delegateQueue 用串行 OperationQueue，进度事件有序不丢

import Foundation
import React

@objc(WebDAVUploadModule)
class WebDAVUploadModule: RCTEventEmitter {

  // MARK: - 共享 Session

  // 线程安全的 session 初始化（lazy var 非线程安全，并发上传会崩）
  private var _session: URLSession?
  private var _delegate: SharedUploadDelegate?
  private let sessionLock = NSLock()

  private var session: URLSession {
    sessionLock.lock()
    defer { sessionLock.unlock() }
    if let s = _session { return s }
    let delegate = SharedUploadDelegate(module: self)
    _delegate = delegate
    let config = URLSessionConfiguration.default
    // 连接复用与性能调优
    config.httpMaximumConnectionsPerHost = 6          // 与 JS 并发上限对齐
    config.timeoutIntervalForRequest = 60             // 单次请求 60s 无数据则超时
    config.timeoutIntervalForResource = 600           // 整个任务 10 分钟
    // waitsForConnectivity = false：断网时立即失败（走 JS 自动重试），
    // 而不是静默等待。静默等待期间无进度上报，会被 15s 看门狗误杀，
    // 不如快速失败让重试逻辑接管。
    config.waitsForConnectivity = false
    config.allowsCellularAccess = true               // 允许蜂窝（用户可在系统设置中限制）
    // HTTP/2 默认开启；TCP keepalive 由系统管理
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1             // 进度回调串行，有序
    queue.name = "com.lxy.WebDAVUploadDelegate"
    let s = URLSession(configuration: config, delegate: delegate, delegateQueue: queue)
    _session = s
    return s
  }

  // 任务表：uploadId -> 上下文（含 task、resolver、rejecter）
  private var contexts: [String: UploadContext] = [:]
  // taskIdentifier -> uploadId（delegate 路由用，与 contexts 同一把 lock 保护）
  // 注意：SharedUploadDelegate 回调在 delegate 串行队列，uploadFile 在 RN 线程，
  // 必须加锁，否则 Swift Dictionary 并发读写会崩溃
  private var taskIdMap: [Int: String] = [:]
  private let lock = NSLock()

  override static func requiresMainQueueSetup() -> Bool {
    return false
  }

  override func supportedEvents() -> [String]! {
    return ["WebDAVUploadProgress"]
  }

  // MARK: - 上传

  /// 发起上传（单字典传参，避免多参数桥接越界）
  @objc(uploadFile:resolver:rejecter:)
  func uploadFile(
    _ options: [String: Any],
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    // 1. 参数校验
    guard let uploadId = options["uploadId"] as? String, !uploadId.isEmpty else {
      reject("E_INVALID_ID", "uploadId 不能为空", nil)
      return
    }
    guard let urlString = options["url"] as? String,
          let url = URL(string: urlString) else {
      reject("E_INVALID_URL", "上传地址非法", nil)
      return
    }
    guard let filePath = options["filePath"] as? String else {
      reject("E_INVALID_PATH", "本地路径非法", nil)
      return
    }
    let headers = options["headers"] as? [String: String] ?? [:]
    let method = (options["method"] as? String) ?? "PUT"

    let fileURL = URL(fileURLWithPath: filePath)
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: filePath, isDirectory: &isDir),
          !isDir.boolValue else {
      reject("E_FILE_NOT_FOUND", "本地文件不存在或为目录", nil)
      return
    }

    // 2. 防重入：同一 uploadId 不允许重复发起
    lock.lock()
    if contexts[uploadId] != nil {
      lock.unlock()
      reject("E_DUPLICATE_ID", "uploadId 已存在", nil)
      return
    }
    lock.unlock()

    // 3. 构造请求
    var request = URLRequest(url: url)
    request.httpMethod = method.isEmpty ? "PUT" : method.uppercased()
    // 禁用缓存，避免复用过期缓存的响应
    request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData

    // 请求头：过滤空 key/value（防 NSInvalidArgumentException）
    for (key, value) in headers {
      let k = key.trimmingCharacters(in: .whitespaces)
      let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
      if !k.isEmpty && !v.isEmpty {
        request.setValue(v, forHTTPHeaderField: k)
      }
    }

    // 强制关闭连接复用：NAS/家宽的 keep-alive 连接常被服务器端提前关闭，
    // 复用这种半死连接会导致 "The network connection was lost" (-1005)。
    // 上传是低频操作，不复用连接的开销可接受，换来稳定性。
    // 若调用方已显式设置 Connection 头，则尊重调用方。
    if request.value(forHTTPHeaderField: "Connection") == nil {
      request.setValue("close", forHTTPHeaderField: "Connection")
    }

    // Content-Type 兜底：JS 未传时按扩展名推断（与 webdav 库行为对齐）
    if request.value(forHTTPHeaderField: "Content-Type") == nil {
      if let mime = mimeType(for: fileURL.pathExtension) {
        request.setValue(mime, forHTTPHeaderField: "Content-Type")
      }
    }

    // 4. 创建上传任务
    // 分块上传：若指定 startOffset/endOffset，只读该范围（断点续传/分块）
    // 用 uploadTask(with:from:) 传 Data；整文件用 uploadTask(with:fromFile:) 流式（省内存）
    // 注意：JS 数字桥接为 NSNumber，需用 int64Value 取值（直接 as? Int64 可能失败）
    let task: URLSessionUploadTask
    let startOffset: Int64?
    let endOffset: Int64?
    if let startNum = options["startOffset"] as? NSNumber,
       let endNum = options["endOffset"] as? NSNumber {
      startOffset = startNum.int64Value
      endOffset = endNum.int64Value
    } else {
      startOffset = nil
      endOffset = nil
    }
    if let start = startOffset, let end = endOffset, end > start {
      // 读取指定范围到内存（块大小可控，如 5MB）
      do {
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(start))
        let chunkLength = Int(end - start)
        let chunkData = handle.readData(ofLength: chunkLength)
        guard chunkData.count > 0 else {
          reject("E_CHUNK_EMPTY", "分块数据为空", nil)
          return
        }
        task = session.uploadTask(with: request, from: chunkData)
      } catch {
        reject("E_CHUNK_READ", "读取分块失败：\(error.localizedDescription)", nil)
        return
      }
    } else {
      // 整文件流式上传（不进内存）
      // 注意：uploadTask(with:fromFile:) 会自动设置 Content-Length
      task = session.uploadTask(with: request, fromFile: fileURL)
    }

    // 5. 保存上下文
    let ctx = UploadContext(
      task: task,
      resolver: resolve,
      rejecter: reject,
      uploadId: uploadId
    )
    lock.lock()
    contexts[uploadId] = ctx
    // taskIdentifier -> uploadId 映射（delegate 路由用，同 lock 保护）
    taskIdMap[task.taskIdentifier] = uploadId
    lock.unlock()

    task.resume()
  }

  // MARK: - 取消

  /// 取消指定上传
  @objc(cancelUpload:resolver:rejecter:)
  func cancelUpload(
    _ uploadId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    lock.lock()
    let ctx = contexts[uploadId]
    lock.unlock()

    if let ctx = ctx {
      ctx.cancelledByUser = true
      ctx.task.cancel()
      resolve(true)
    } else {
      resolve(false)  // 已完成或不存在，视为成功
    }
  }

  // MARK: - 内部：完成处理（delegate 回调）

  fileprivate func handleCompletion(uploadId: String, error: Error?) {
    lock.lock()
    guard let ctx = contexts.removeValue(forKey: uploadId) else {
      lock.unlock()
      return
    }
    // 清理 task 映射（同 lock 保护）
    taskIdMap.removeValue(forKey: ctx.task.taskIdentifier)
    lock.unlock()

    if let nsError = error as NSError? {
      // 用户取消
      if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
        ctx.rejecter("E_CANCELLED", "上传已取消", nil)
      } else {
        // 网络错误：透出 code，便于 JS 区分重试策略
        ctx.rejecter("E_NETWORK", nsError.localizedDescription, nsError)
      }
      return
    }

    // 无 error 但 response 异常（理论上不会走到，由 delegate 的 didComplete 保证）
    ctx.rejecter("E_NO_RESPONSE", "无服务器响应", nil)
  }

  fileprivate func handleResponse(uploadId: String, response: URLResponse?) {
    lock.lock()
    guard let ctx = contexts[uploadId] else {
      lock.unlock()
      return
    }
    lock.unlock()

    guard let httpResponse = response as? HTTPURLResponse else {
      // 非 HTTP 响应：等待 didComplete 的 error 处理
      return
    }

    let statusCode = httpResponse.statusCode
    if (200..<300).contains(statusCode) {
      // 成功：从 contexts 移除（didComplete 也会调，但已移除则忽略）
      lock.lock()
      contexts.removeValue(forKey: uploadId)
      taskIdMap.removeValue(forKey: ctx.task.taskIdentifier)
      lock.unlock()
      ctx.resolver(["statusCode": statusCode])
    } else {
      // HTTP 错误：reject，code 带状态码便于 JS 做 409 特殊处理
      lock.lock()
      contexts.removeValue(forKey: uploadId)
      taskIdMap.removeValue(forKey: ctx.task.taskIdentifier)
      lock.unlock()
      ctx.rejecter("E_HTTP_\(statusCode)", "上传失败（HTTP \(statusCode)）", nil)
    }
  }

  fileprivate func handleProgress(uploadId: String, sent: Int64, total: Int64) {
    sendEvent(withName: "WebDAVUploadProgress", body: [
      "uploadId": uploadId,
      "totalBytesSent": sent,
      "totalBytesExpectedToSend": total,
    ])
  }

  /// 线程安全查询：taskIdentifier -> uploadId（供 delegate 调用）
  fileprivate func uploadId(for taskIdentifier: Int) -> String? {
    lock.lock()
    defer { lock.unlock() }
    return taskIdMap[taskIdentifier]
  }

  // MARK: - MIME 推断

  private func mimeType(for ext: String) -> String? {
    switch ext.lowercased() {
    case "mp3": return "audio/mpeg"
    case "flac": return "audio/flac"
    case "wav": return "audio/wav"
    case "m4a": return "audio/mp4"
    case "aac": return "audio/aac"
    case "ogg", "oga": return "audio/ogg"
    case "opus": return "audio/opus"
    case "wma": return "audio/x-ms-wma"
    case "ape": return "audio/ape"
    case "lrc": return "text/plain"
    default: return nil
    }
  }
}

// MARK: - UploadContext

private class UploadContext {
  let task: URLSessionUploadTask
  let resolver: RCTPromiseResolveBlock
  let rejecter: RCTPromiseRejectBlock
  let uploadId: String
  var cancelledByUser = false

  init(task: URLSessionUploadTask,
       resolver: @escaping RCTPromiseResolveBlock,
       rejecter: @escaping RCTPromiseRejectBlock,
       uploadId: String) {
    self.task = task
    self.resolver = resolver
    self.rejecter = rejecter
    self.uploadId = uploadId
  }
}

// MARK: - SharedUploadDelegate

/// 共享 delegate：按 taskIdentifier 路由到对应的 uploadId
/// 注意：通过 module.uploadId(for:) 查询（内部加锁），不自己存 map
private class SharedUploadDelegate: NSObject, URLSessionTaskDelegate, URLSessionDataDelegate {

  weak var module: WebDAVUploadModule?

  init(module: WebDAVUploadModule) {
    self.module = module
    super.init()
  }

  // 上传进度
  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didSendBodyData bytesSent: Int64,
    totalBytesSent: Int64,
    totalBytesExpectedToSend: Int64
  ) {
    guard let uploadId = module?.uploadId(for: task.taskIdentifier) else { return }
    module?.handleProgress(uploadId: uploadId, sent: totalBytesSent, total: totalBytesExpectedToSend)
  }

  // 收到响应头（可提前拿到 statusCode）
  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    // 允许继续，由 didComplete 统一处理
    completionHandler(.allow)
  }

  // 任务完成（含 HTTP 响应处理）
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let uploadId = module?.uploadId(for: task.taskIdentifier) else { return }

    if let error = error {
      module?.handleCompletion(uploadId: uploadId, error: error)
    } else {
      // 无 error：检查 HTTP 状态码
      module?.handleResponse(uploadId: uploadId, response: task.response)
    }
  }
}
