// Patch dependency sources after install when upstream packages need local integration fixes.

const fs = require('node:fs')
const path = require('node:path')

const rootPath = __dirname
const equalizerAudioMixSwiftSource = fs.readFileSync(path.join(rootPath, 'patches/ios/LXEqualizerAudioMix.swift'), 'utf8')
const sharedIRKernelSource = fs.readFileSync(path.join(rootPath, 'ios/LxMusicMobile/LXSharedIRConvolutionKernel.hpp'), 'utf8')
const sharedIRBridgeHeaderSource = fs.readFileSync(path.join(rootPath, 'patches/ios/LXSharedIRConvolutionBridge.h'), 'utf8')
const sharedIRBridgeSource = fs.readFileSync(path.join(rootPath, 'patches/ios/LXSharedIRConvolutionBridge.mm'), 'utf8')

/**
 * @typedef {{ from: string, to: string, alreadyApplied?: string|RegExp }} PatchChange
 * alreadyApplied（F-A2）：「已应用」的独立判定（子串或正则，不用 /g 标志）。
 * 下游 pair 可能改写本 pair 的 `to`（#1 插入 import AVFoundation、#2 把
 * equalizer* 迁移为 soundEffect*、regex 步重写整函数），此时 from 与 to 都不
 * 存在，但补丁实际已生效；本判定让二次 npm install 能认出已应用状态而跳过，
 * 恢复幂等性。判定串必须满足：在 pristine 树与本 pair 在 RUN 1 执行时均不存
 * 在，只在已应用（含下游改写）后出现。
 * @typedef {{ filePath: string, changes: PatchChange[] }} PatchTarget
 */

/** @type {PatchTarget[]} */
const patchTargets = [
  {
    filePath: 'node_modules/react-native-track-player/ios/RNTrackPlayer/RNTrackPlayer.swift',
    changes: [
      {
        from: `import Foundation
import MediaPlayer
import SwiftAudioEx

@objc(RNTrackPlayer)
public class RNTrackPlayer: RCTEventEmitter {
`,
        to: `import Foundation
import MediaPlayer
import SwiftAudioEx

private let lxTrackPlayerLifecycleNotification = Notification.Name("LXTrackPlayerLifecycle")

@objc(RNTrackPlayer)
public class RNTrackPlayer: RCTEventEmitter {
`,
        // F-A2：#1 pair 0 随后插入 import AVFoundation，改写本 pair 的 to。
        alreadyApplied: 'lxTrackPlayerLifecycleNotification',
      },
      {
        from: `    private var hasInitialized = false
    private let player = QueuedAudioPlayer()

    // MARK: - Lifecycle Methods
`,
        to: `    private var hasInitialized = false
    private let player = QueuedAudioPlayer()

    private func lifecycleStateName(_ state: AVPlayerWrapperState) -> String {
        switch state {
        case .idle: return "idle"
        case .ready: return "ready"
        case .playing: return "playing"
        case .paused: return "paused"
        case .loading: return "loading"
        default: return "unknown"
        }
    }

    private func postLifecycleEvent(_ event: String, state: AVPlayerWrapperState? = nil, position: Double? = nil, rate: Float? = nil, extra: [String: Any] = [:]) {
        var userInfo = extra
        let lifecycleState = state ?? player.playerState
        userInfo["event"] = event
        userInfo["state"] = lifecycleStateName(lifecycleState)
        userInfo["position"] = position ?? player.currentTime
        userInfo["rate"] = rate ?? player.rate
        userInfo["track"] = player.currentIndex

        NotificationCenter.default.post(name: lxTrackPlayerLifecycleNotification, object: self, userInfo: userInfo)
    }

    // MARK: - Lifecycle Methods
`,
        // F-A2：#1 pair 1 随后在 player 声明与本函数之间插入 equalizer 声明
        // （#2 又迁移为 soundEffect*），改写本 pair 的 to；函数定义本身仍在。
        alreadyApplied: 'private func postLifecycleEvent(',
      },
      {
        from: `    @objc(destroy)
    public func destroy() {
        print("Destroying player")
        self.player.stop()
        self.player.nowPlayingInfoController.clear()
        try? AVAudioSession.sharedInstance().setActive(false)
        hasInitialized = false
    }
`,
        to: `    @objc(destroy)
    public func destroy() {
        print("Destroying player")
        self.player.stop()
        self.player.nowPlayingInfoController.clear()
        postLifecycleEvent("destroy", state: .idle, position: 0, rate: 0)
        try? AVAudioSession.sharedInstance().setActive(false)
        hasInitialized = false
    }
`,
        // F-A2：#1 pair 4 随后在 destroy 内插入 equalizer 清理行（#2 又迁移为
        // soundEffect*），改写本 pair 的 to；本 pair 的调用行本身仍在。
        alreadyApplied: 'postLifecycleEvent("destroy", state: .idle, position: 0, rate: 0)',
      },
      {
        from: `    @objc(reset:rejecter:)
    public func reset(resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        print("Resetting player.")
        player.stop()
        resolve(NSNull())
        DispatchQueue.main.async {
            UIApplication.shared.endReceivingRemoteControlEvents();
        }
    }
`,
        to: `    @objc(reset:rejecter:)
    public func reset(resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        print("Resetting player.")
        player.stop()
        postLifecycleEvent("reset", state: .idle, position: 0, rate: 0)
        resolve(NSNull())
        DispatchQueue.main.async {
            UIApplication.shared.endReceivingRemoteControlEvents();
        }
    }
`,
        // F-A2：#1 pair 5 随后在 reset 内插入 equalizer 清理行（#2 又迁移为
        // soundEffect*），改写本 pair 的 to；本 pair 的调用行本身仍在。
        alreadyApplied: 'postLifecycleEvent("reset", state: .idle, position: 0, rate: 0)',
      },
      {
        from: `    @objc(seekTo:resolver:rejecter:)
    public func seek(to time: Double, resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        print("Seeking to \\(time) seconds")
        player.seek(to: time)
        resolve(NSNull())
    }
`,
        to: `    @objc(seekTo:resolver:rejecter:)
    public func seek(to time: Double, resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        print("Seeking to \\(time) seconds")
        player.seek(to: time)
        postLifecycleEvent("seek", position: time)
        resolve(NSNull())
    }
`,
      },
      {
        from: `    @objc(stop:rejecter:)
    public func stop(resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        print("Stopping playback")
        player.stop()
        resolve(NSNull())
    }
`,
        to: `    @objc(stop:rejecter:)
    public func stop(resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        print("Stopping playback")
        player.stop()
        postLifecycleEvent("stop", state: .idle, position: 0, rate: 0)
        resolve(NSNull())
    }
`,
      },
      {
        from: `    func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {
        sendEvent(withName: "playback-state", body: ["state": state.rawValue])
    }
`,
        to: `    func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {
        sendEvent(withName: "playback-state", body: ["state": state.rawValue])
        postLifecycleEvent("state", state: state)
    }
`,
        // F-A2：#1 pair 7 与 regex 步随后重写整个函数体，改写本 pair 的 to；
        // regex 版仍保留本 pair 的 postLifecycleEvent 调用行。
        alreadyApplied: 'postLifecycleEvent("state", state: state)',
      },
      {
        from: `    func handleAudioPlayerFailed(error: Error?) {
        sendEvent(withName: "playback-error", body: ["error": error?.localizedDescription])
    }
`,
        to: `    func handleAudioPlayerFailed(error: Error?) {
        sendEvent(withName: "playback-error", body: ["error": error?.localizedDescription])
        postLifecycleEvent("error", extra: ["error": error?.localizedDescription ?? ""])
    }
`,
      },
      {
        from: `        var capabilitiesStr = options["capabilities"] as? [String] ?? []
        if (capabilitiesStr.contains("play") && capabilitiesStr.contains("pause")) {
            capabilitiesStr.append("togglePlayPause");
        }
        let capabilities = capabilitiesStr.compactMap { Capability(rawValue: $0) }
`,
        to: `        let capabilitiesStr = options["capabilities"] as? [String] ?? []
        let capabilities = capabilitiesStr.compactMap { Capability(rawValue: $0) }
`,
      },
    ],
  },
  {
    filePath: 'node_modules/react-native-track-player/ios/RNTrackPlayer/RNTrackPlayer.swift',
    changes: [
      {
        from: `import Foundation
import MediaPlayer
import SwiftAudioEx

private let lxTrackPlayerLifecycleNotification = Notification.Name("LXTrackPlayerLifecycle")
`,
        to: `import Foundation
import AVFoundation
import MediaPlayer
import SwiftAudioEx

private let lxTrackPlayerLifecycleNotification = Notification.Name("LXTrackPlayerLifecycle")
`,
      },
      {
        from: `    private var hasInitialized = false
    private let player = QueuedAudioPlayer()

    private func lifecycleStateName(_ state: AVPlayerWrapperState) -> String {
`,
        to: `    private var hasInitialized = false
    private let player = QueuedAudioPlayer()
    private var equalizerEnabled = false
    private var equalizerGains = LXEqualizerAudioMixController.normalizeGains([])
    private var equalizerTapProcessor: LXEqualizerAudioMixController?
    private weak var equalizedPlayerItem: AVPlayerItem?

    private func lifecycleStateName(_ state: AVPlayerWrapperState) -> String {
`,
        // F-A2：#2 pair 0 随后把 equalizer* 声明迁移为 soundEffect*，改写本
        // pair 的 to；迁移后形态（soundEffectConfig）或未迁移形态任一存在即
        // 已应用。
        alreadyApplied: /soundEffectConfig|equalizerEnabled/,
      },
      {
        from: `    deinit {
        reset(resolve: { _ in }, reject: { _, _, _  in })
    }
`,
        to: `    deinit {
        NotificationCenter.default.removeObserver(self, name: lxSoundEffectConfigNotification, object: nil)
        reset(resolve: { _ in }, reject: { _, _, _  in })
    }
`,
      },
      {
        from: `        setupInterruptionHandling();

        // configure if player waits to play
`,
        to: `        setupInterruptionHandling();
        NotificationCenter.default.addObserver(self,
                                               selector: #selector(handleSoundEffectConfigChanged),
                                               name: lxSoundEffectConfigNotification,
                                               object: nil)

        // configure if player waits to play
`,
      },
      {
        from: `    @objc(destroy)
    public func destroy() {
        print("Destroying player")
        self.player.stop()
        self.player.nowPlayingInfoController.clear()
        postLifecycleEvent("destroy", state: .idle, position: 0, rate: 0)
        try? AVAudioSession.sharedInstance().setActive(false)
        hasInitialized = false
    }
`,
        to: `    @objc(destroy)
    public func destroy() {
        print("Destroying player")
        self.player.stop()
        equalizedPlayerItem = nil
        equalizerTapProcessor = nil
        self.player.nowPlayingInfoController.clear()
        postLifecycleEvent("destroy", state: .idle, position: 0, rate: 0)
        try? AVAudioSession.sharedInstance().setActive(false)
        hasInitialized = false
    }
`,
        // F-A2：#2 pair 1 随后把本 pair 的清理行迁移为 soundEffect* 形态
        // （soundEffectPlayerItem?.audioMix = nil），改写本 pair 的 to。
        alreadyApplied: 'soundEffectPlayerItem?.audioMix = nil',
      },
      {
        from: `    @objc(reset:rejecter:)
    public func reset(resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        print("Resetting player.")
        player.stop()
        postLifecycleEvent("reset", state: .idle, position: 0, rate: 0)
        resolve(NSNull())
        DispatchQueue.main.async {
            UIApplication.shared.endReceivingRemoteControlEvents();
        }
    }
`,
        to: `    @objc(reset:rejecter:)
    public func reset(resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        print("Resetting player.")
        player.stop()
        equalizedPlayerItem = nil
        equalizerTapProcessor = nil
        postLifecycleEvent("reset", state: .idle, position: 0, rate: 0)
        resolve(NSNull())
        DispatchQueue.main.async {
            UIApplication.shared.endReceivingRemoteControlEvents();
        }
    }
`,
        // F-A2：#2 pair 2 随后把本 pair 的清理行迁移为 soundEffect* 形态
        // （soundEffectPlayerItem?.audioMix = nil），改写本 pair 的 to。
        alreadyApplied: 'soundEffectPlayerItem?.audioMix = nil',
      },
      {
        from: `    @objc(updateNowPlayingMetadata:resolver:rejecter:)
    public func updateNowPlayingMetadata(metadata: [String: Any], resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        Metadata.update(for: player, with: metadata)
    }

    // MARK: - QueuedAudioPlayer Event Handlers
`,
        to: `    @objc(updateNowPlayingMetadata:resolver:rejecter:)
    public func updateNowPlayingMetadata(metadata: [String: Any], resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        Metadata.update(for: player, with: metadata)
    }

    @objc private func handleSoundEffectConfigChanged(_ notification: Notification) {
        applySoundEffectConfig(notification.userInfo)
        refreshEqualizerAudioMix()
    }

    private func applySoundEffectConfig(_ userInfo: [AnyHashable: Any]?) {
        equalizerEnabled = userInfo?["enabled"] as? Bool ?? false
        let inputGains = userInfo?["gains"] as? [NSNumber] ?? []
        equalizerGains = LXEqualizerAudioMixController.normalizeGains(inputGains.map { $0.floatValue })
        equalizerTapProcessor?.updateConfig(enabled: equalizerEnabled, gains: equalizerGains)
    }

    private func refreshEqualizerAudioMix() {
        guard let currentItem = player.currentPlayerItem else {
            equalizedPlayerItem = nil
            equalizerTapProcessor = nil
            return
        }

        if equalizedPlayerItem === currentItem, let processor = equalizerTapProcessor {
            processor.updateConfig(enabled: equalizerEnabled, gains: equalizerGains)
            return
        }

        guard equalizerEnabled else {
            equalizedPlayerItem = nil
            equalizerTapProcessor = nil
            return
        }

        let processor = LXEqualizerAudioMixController(enabled: equalizerEnabled, gains: equalizerGains)
        guard let audioMix = processor.makeAudioMix(for: currentItem.asset) else {
            equalizedPlayerItem = nil
            equalizerTapProcessor = nil
            return
        }

        currentItem.audioMix = audioMix
        equalizedPlayerItem = currentItem
        equalizerTapProcessor = processor
    }

    // MARK: - QueuedAudioPlayer Event Handlers
`,
        // F-A2：#2 pair 3 随后把本 pair 的三个函数整体替换为 soundEffectConfig
        // 版（refreshSoundEffectAudioMix），改写本 pair 的 to。
        alreadyApplied: 'refreshSoundEffectAudioMix',
      },
      {
        from: `    func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {
        sendEvent(withName: "playback-state", body: ["state": state.rawValue])
        postLifecycleEvent("state", state: state)
    }
`,
        to: `    func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {
        refreshEqualizerAudioMix()
        sendEvent(withName: "playback-state", body: ["state": state.rawValue])
        postLifecycleEvent("state", state: state)
    }
`,
        // F-A2：regex 步随后重写整个函数体（refreshSoundEffectAudioMixOnMainThread），
        // 改写本 pair 的 to。
        alreadyApplied: 'refreshSoundEffectAudioMixOnMainThread',
      },
      {
        from: `    func handleAudioPlayerQueueIndexChange(previousIndex: Int?, nextIndex: Int?) {
        var dictionary: [String: Any] = [ "position": player.currentTime ]
`,
        to: `    func handleAudioPlayerQueueIndexChange(previousIndex: Int?, nextIndex: Int?) {
        refreshEqualizerAudioMix()
        var dictionary: [String: Any] = [ "position": player.currentTime ]
`,
        // F-A2：regex 步随后重写本函数开头（refreshSoundEffectAudioMixOnMainThread），
        // 改写本 pair 的 to。
        alreadyApplied: 'refreshSoundEffectAudioMixOnMainThread',
      },
    ],
  },
  {
    filePath: 'node_modules/react-native-track-player/ios/RNTrackPlayer/RNTrackPlayer.swift',
    changes: [
      {
        from: `    private var hasInitialized = false
    private let player = QueuedAudioPlayer()
    private var equalizerEnabled = false
    private var equalizerGains = LXEqualizerAudioMixController.normalizeGains([])
    private var equalizerTapProcessor: LXEqualizerAudioMixController?
    private weak var equalizedPlayerItem: AVPlayerItem?
`,
        to: `    private var hasInitialized = false
    private let player = QueuedAudioPlayer()
    private var soundEffectConfig = LXSoundEffectConfiguration()
    private var soundEffectTapProcessor: LXEqualizerAudioMixController?
    private weak var soundEffectPlayerItem: AVPlayerItem?
`,
      },
      {
        from: `        self.player.stop()
        equalizedPlayerItem = nil
        equalizerTapProcessor = nil
        self.player.nowPlayingInfoController.clear()
`,
        to: `        self.player.stop()
        soundEffectPlayerItem?.audioMix = nil
        soundEffectPlayerItem = nil
        soundEffectTapProcessor = nil
        self.player.nowPlayingInfoController.clear()
`,
      },
      {
        from: `        player.stop()
        equalizedPlayerItem = nil
        equalizerTapProcessor = nil
        postLifecycleEvent("reset", state: .idle, position: 0, rate: 0)
`,
        to: `        player.stop()
        soundEffectPlayerItem?.audioMix = nil
        soundEffectPlayerItem = nil
        soundEffectTapProcessor = nil
        postLifecycleEvent("reset", state: .idle, position: 0, rate: 0)
`,
      },
      {
        from: `    @objc private func handleSoundEffectConfigChanged(_ notification: Notification) {
        applySoundEffectConfig(notification.userInfo)
        refreshEqualizerAudioMix()
    }

    private func applySoundEffectConfig(_ userInfo: [AnyHashable: Any]?) {
        equalizerEnabled = userInfo?["enabled"] as? Bool ?? false
        let inputGains = userInfo?["gains"] as? [NSNumber] ?? []
        equalizerGains = LXEqualizerAudioMixController.normalizeGains(inputGains.map { $0.floatValue })
        equalizerTapProcessor?.updateConfig(enabled: equalizerEnabled, gains: equalizerGains)
    }

    private func refreshEqualizerAudioMix() {
        guard let currentItem = player.currentPlayerItem else {
            equalizedPlayerItem = nil
            equalizerTapProcessor = nil
            return
        }

        if equalizedPlayerItem === currentItem, let processor = equalizerTapProcessor {
            processor.updateConfig(enabled: equalizerEnabled, gains: equalizerGains)
            return
        }

        guard equalizerEnabled else {
            equalizedPlayerItem = nil
            equalizerTapProcessor = nil
            return
        }

        let processor = LXEqualizerAudioMixController(enabled: equalizerEnabled, gains: equalizerGains)
        guard let audioMix = processor.makeAudioMix(for: currentItem.asset) else {
            equalizedPlayerItem = nil
            equalizerTapProcessor = nil
            return
        }

        currentItem.audioMix = audioMix
        equalizedPlayerItem = currentItem
        equalizerTapProcessor = processor
    }
`,
        to: `    @objc private func handleSoundEffectConfigChanged(_ notification: Notification) {
        let nextConfig = LXSoundEffectConfiguration.fromUserInfo(notification.userInfo)
        if Thread.isMainThread {
            soundEffectConfig = nextConfig
            refreshSoundEffectAudioMix()
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.soundEffectConfig = nextConfig
            self?.refreshSoundEffectAudioMix()
        }
    }

    private func refreshSoundEffectAudioMixOnMainThread() {
        if Thread.isMainThread {
            refreshSoundEffectAudioMix()
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.refreshSoundEffectAudioMix()
        }
    }

    private func refreshSoundEffectAudioMix() {
        guard let currentItem = player.currentPlayerItem else {
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        if soundEffectPlayerItem !== currentItem {
            soundEffectPlayerItem?.audioMix = nil
        }

        if let processor = soundEffectTapProcessor, soundEffectPlayerItem === currentItem {
            processor.updateConfig(soundEffectConfig)
            if soundEffectConfig.isActive {
                if currentItem.audioMix == nil, let audioMix = processor.makeAudioMix(for: currentItem.asset) {
                    currentItem.audioMix = audioMix
                }
            } else {
                currentItem.audioMix = nil
                soundEffectTapProcessor = nil
                soundEffectPlayerItem = nil
            }
            return
        }

        guard soundEffectConfig.isActive else {
            currentItem.audioMix = nil
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        let processor = LXEqualizerAudioMixController(config: soundEffectConfig)
        guard let audioMix = processor.makeAudioMix(for: currentItem.asset) else {
            currentItem.audioMix = nil
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        currentItem.audioMix = audioMix
        soundEffectPlayerItem = currentItem
        soundEffectTapProcessor = processor
    }
`,
      },
      {
        from: `    @objc private func handleSoundEffectConfigChanged(_ notification: Notification) {
        soundEffectConfig = LXSoundEffectConfiguration.fromUserInfo(notification.userInfo)
        refreshSoundEffectAudioMix()
    }

    private func refreshSoundEffectAudioMix() {
        guard let currentItem = player.currentPlayerItem else {
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        if soundEffectPlayerItem !== currentItem {
            soundEffectPlayerItem?.audioMix = nil
        }

        if let processor = soundEffectTapProcessor, soundEffectPlayerItem === currentItem {
            processor.updateConfig(soundEffectConfig)
            if soundEffectConfig.isActive {
                if currentItem.audioMix == nil, let audioMix = processor.makeAudioMix(for: currentItem.asset) {
                    currentItem.audioMix = audioMix
                }
            } else {
                currentItem.audioMix = nil
                soundEffectTapProcessor = nil
                soundEffectPlayerItem = nil
            }
            return
        }

        guard soundEffectConfig.isActive else {
            currentItem.audioMix = nil
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        let processor = LXEqualizerAudioMixController(config: soundEffectConfig)
        guard let audioMix = processor.makeAudioMix(for: currentItem.asset) else {
            currentItem.audioMix = nil
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        currentItem.audioMix = audioMix
        soundEffectPlayerItem = currentItem
        soundEffectTapProcessor = processor
    }
`,
        to: `    @objc private func handleSoundEffectConfigChanged(_ notification: Notification) {
        let nextConfig = LXSoundEffectConfiguration.fromUserInfo(notification.userInfo)
        if Thread.isMainThread {
            soundEffectConfig = nextConfig
            refreshSoundEffectAudioMix()
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.soundEffectConfig = nextConfig
            self?.refreshSoundEffectAudioMix()
        }
    }

    private func refreshSoundEffectAudioMixOnMainThread() {
        if Thread.isMainThread {
            refreshSoundEffectAudioMix()
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.refreshSoundEffectAudioMix()
        }
    }

    private func refreshSoundEffectAudioMix() {
        guard let currentItem = player.currentPlayerItem else {
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        if soundEffectPlayerItem !== currentItem {
            soundEffectPlayerItem?.audioMix = nil
        }

        if let processor = soundEffectTapProcessor, soundEffectPlayerItem === currentItem {
            processor.updateConfig(soundEffectConfig)
            if soundEffectConfig.isActive {
                if currentItem.audioMix == nil, let audioMix = processor.makeAudioMix(for: currentItem.asset) {
                    currentItem.audioMix = audioMix
                }
            } else {
                currentItem.audioMix = nil
                soundEffectTapProcessor = nil
                soundEffectPlayerItem = nil
            }
            return
        }

        guard soundEffectConfig.isActive else {
            currentItem.audioMix = nil
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        let processor = LXEqualizerAudioMixController(config: soundEffectConfig)
        guard let audioMix = processor.makeAudioMix(for: currentItem.asset) else {
            currentItem.audioMix = nil
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        currentItem.audioMix = audioMix
        soundEffectPlayerItem = currentItem
        soundEffectTapProcessor = processor
    }
`,
      },
      {
        from: `    func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {
        refreshEqualizerAudioMix()
        sendEvent(withName: "playback-state", body: ["state": state.rawValue])
        postLifecycleEvent("state", state: state)
    }
`,
        to: `    func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {
        refreshSoundEffectAudioMixOnMainThread()
        sendEvent(withName: "playback-state", body: ["state": state.rawValue])
        postLifecycleEvent("state", state: state)
    }
`,
      },
      {
        from: `    func handleAudioPlayerQueueIndexChange(previousIndex: Int?, nextIndex: Int?) {
        refreshEqualizerAudioMix()
        var dictionary: [String: Any] = [ "position": player.currentTime ]
`,
        to: `    func handleAudioPlayerQueueIndexChange(previousIndex: Int?, nextIndex: Int?) {
        refreshSoundEffectAudioMixOnMainThread()
        var dictionary: [String: Any] = [ "position": player.currentTime ]
`,
      },
      {
        from: `    func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {
        refreshSoundEffectAudioMix()
        sendEvent(withName: "playback-state", body: ["state": state.rawValue])
        postLifecycleEvent("state", state: state)
    }
`,
        to: `    func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {
        refreshSoundEffectAudioMixOnMainThread()
        sendEvent(withName: "playback-state", body: ["state": state.rawValue])
        postLifecycleEvent("state", state: state)
    }
`,
      },
      {
        from: `    func handleAudioPlayerQueueIndexChange(previousIndex: Int?, nextIndex: Int?) {
        refreshSoundEffectAudioMix()
        var dictionary: [String: Any] = [ "position": player.currentTime ]
`,
        to: `    func handleAudioPlayerQueueIndexChange(previousIndex: Int?, nextIndex: Int?) {
        refreshSoundEffectAudioMixOnMainThread()
        var dictionary: [String: Any] = [ "position": player.currentTime ]
`,
      },
    ],
  },
  {
    filePath: 'node_modules/react-native-track-player/ios/RNTrackPlayer/RNTrackPlayer.swift',
    changes: [
      {
        // mixWithOthers 需要 .default 路由策略才能生效：longFormAudio 是“独占式长音频”策略，
        // 会忽略混音选项，导致“关闭其他应用播放时自动暂停”设置下音乐仍被系统中断。
        // 仅在未请求混音时沿用 longFormAudio（保留长音频路由）。
        from: `        // Progressively opt into AVAudioSession policies for background audio
        // and AirPlay 2.
        if #available(iOS 13.0, *) {
            try? AVAudioSession.sharedInstance().setCategory(sessionCategory, mode: sessionCategoryMode, policy: sessionCategory == .ambient ? .default : .longFormAudio, options: sessionCategoryOptions)
        } else if #available(iOS 11.0, *) {
            try? AVAudioSession.sharedInstance().setCategory(sessionCategory, mode: sessionCategoryMode, policy: sessionCategory == .ambient ? .default : .longForm, options: sessionCategoryOptions)
        } else {
            try? AVAudioSession.sharedInstance().setCategory(sessionCategory, mode: sessionCategoryMode, options: sessionCategoryOptions)
        }`,
        to: `        // mixWithOthers 需要 .default 路由策略才能生效：longFormAudio 是“独占式长音频”策略，
        // 会忽略混音选项，导致“关闭其他应用播放时自动暂停”设置下音乐仍被系统中断。
        // 仅在未请求混音时沿用 longFormAudio（保留长音频路由）。
        let useLongFormAudioPolicy = sessionCategory != .ambient && !sessionCategoryOptions.contains(.mixWithOthers)
        // Progressively opt into AVAudioSession policies for background audio
        // and AirPlay 2.
        if #available(iOS 13.0, *) {
            try? AVAudioSession.sharedInstance().setCategory(sessionCategory, mode: sessionCategoryMode, policy: useLongFormAudioPolicy ? .longFormAudio : .default, options: sessionCategoryOptions)
        } else if #available(iOS 11.0, *) {
            try? AVAudioSession.sharedInstance().setCategory(sessionCategory, mode: sessionCategoryMode, policy: useLongFormAudioPolicy ? .longForm : .default, options: sessionCategoryOptions)
        } else {
            try? AVAudioSession.sharedInstance().setCategory(sessionCategory, mode: sessionCategoryMode, options: sessionCategoryOptions)
        }`,
      },
      {
        from: `        player.event.queueIndex.addListener(self, handleAudioPlayerQueueIndexChange)
    }
`,
        to: `        player.event.queueIndex.addListener(self, handleAudioPlayerQueueIndexChange)
        // ≈ HTMLMediaElement 的 seeked：AVPlayer seek completion（引擎真正到达落点，
        // 无论是否经历缓冲）。发起时的 "seek" lifecycle 事件带请求目标；本事件带引擎
        // 真实落点，控制中心歌词时钟据此精确重锚，并转发 JS 触发歌词重锚。
        player.event.seek.addListener(self, handleAudioPlayerSeekCompleted)
    }
`,
      },
      {
        from: '    func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {',
        to: `    // ≈ HTMLMediaElement 的 seeked：seek completion 回调（SeekEventData = (seconds: Int, didFinish: Bool)）。
    // 同时发 lifecycle 通知（控制中心歌词时钟重锚到真实落点）与 JS 事件（歌词重锚触发）。
    private func handleAudioPlayerSeekCompleted(_ data: (seconds: Int, didFinish: Bool)) {
        postLifecycleEvent("seeked", position: Double(data.seconds))
        sendEvent(withName: "player-seeked", body: ["position": Double(data.seconds), "finished": data.didFinish])
    }

    func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {`,
      },
      {
        from: `            "playback-queue-ended",
            "playback-state",`,
        to: `            "playback-queue-ended",
            "playback-state",
            "player-seeked",`,
      },
      {
        // iOS「中断结束」通知不带 AVAudioSessionInterruptionOptionKey 时，旧实现直接 return ——
        // 「中断结束」这件事根本不会通知 JS，于是永远没有恢复播放的时机（车机蓝牙下高德
        // 播报结束、音乐不恢复的成因之一，2026-10-03 用户反馈）。缺省按「无 shouldResume」
        // （值 0）处理，事件照发，是否恢复由 JS 侧 plugins/player/service.ts 判断。
        from: `        else if type == .ended {
            guard let optionsValue =
                    userInfo[AVAudioSessionInterruptionOptionKey] as? UInt else {
                return
            }
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)`,
        to: `        else if type == .ended {
            // 缺省 0 = 无 shouldResume：事件照发，是否恢复交给 JS 判断（见 dependencies-patch.js）
            let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)`,
      },
    ],
  },
  {
    filePath: 'node_modules/react-native-track-player/react-native-track-player.podspec',
    changes: [
      {
        from: '  s.source_files = "ios/**/*.{h,m,swift}"',
        to: '  s.source_files = "ios/**/*.{h,m,mm,swift}"',
      },
    ],
  },
  {
    filePath: 'node_modules/react-native-track-player/ios/RNTrackPlayer/Support/RNTrackPlayer-Bridging-Header.h',
    changes: [
      {
        from: `#import <React/RCTConvert.h>
`,
        to: `#import <React/RCTConvert.h>
#import "LXSharedIRConvolutionBridge.h"
`,
      },
    ],
  },
]

const patchFile = async({ filePath, changes }) => {
  const resolvedPath = path.join(rootPath, filePath)
  console.log(`Patching ${filePath}`)

  const file = await fs.promises.readFile(resolvedPath, 'utf8')
  const eol = file.includes('\r\n') ? '\r\n' : '\n'
  let normalizedFile = file.replace(/\r\n/g, '\n')
  const originalFile = normalizedFile

  for (const { from, to, alreadyApplied } of changes) {
    if (normalizedFile.includes(to)) continue
    // F-A2：下游已改写容忍——本 pair 的 `to` 可能已被下游 pair 改写（如 #1 插入
    // import AVFoundation、#2 迁移 equalizer*→soundEffect*、regex 步重写整函数），
    // 此时 from 与 to 都不存在，但补丁实际已生效；alreadyApplied 命中即跳过，
    // 恢复已打补丁树上二次 npm install 的幂等性（6-8① 抛错口径不变：无判定命
    // 中且 from 不存在时仍抛错）。
    if (alreadyApplied != null && (typeof alreadyApplied === 'string'
      ? normalizedFile.includes(alreadyApplied)
      : alreadyApplied.test(normalizedFile))) continue
    // 6-8①：锚点未命中不再静默跳过，打日志并抛错（与 patchFileByRegex 口径对齐），
    // 避免上游漂移后整组补丁静默丢失功能；调用方 IIFE 会把失败记为 exitCode 1。
    if (!normalizedFile.includes(from)) {
      console.error(`Patch anchor not found in ${filePath}: ${from.slice(0, 120)}`)
      throw new Error(`Patch anchor not found in ${filePath}`)
    }
    normalizedFile = normalizedFile.replace(from, to)
  }

  if (normalizedFile != originalFile) await fs.promises.writeFile(resolvedPath, normalizedFile.replace(/\n/g, eol))
}

const walkFiles = async(dirPath, visitor) => {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) await walkFiles(entryPath, visitor)
    else await visitor(entryPath)
  }
}

const findFile = async(dirPath, fileName) => {
  let matchedPath = null
  await walkFiles(dirPath, async(filePath) => {
    if (matchedPath || path.basename(filePath) != fileName) return
    matchedPath = filePath
  })
  return matchedPath
}

const patchFileByRegex = async({ filePath, pattern, replacement }) => {
  const resolvedPath = path.join(rootPath, filePath)
  console.log(`Patching ${filePath}`)

  const file = await fs.promises.readFile(resolvedPath, 'utf8')
  const eol = file.includes('\r\n') ? '\r\n' : '\n'
  const normalizedFile = file.replace(/\r\n/g, '\n')
  if (normalizedFile.includes(replacement.trim())) return
  const nextFile = normalizedFile.replace(pattern, replacement)

  if (nextFile == normalizedFile) throw new Error('Patch pattern not found')
  if (nextFile != normalizedFile) await fs.promises.writeFile(resolvedPath, nextFile.replace(/\n/g, eol))
}

const ensureFileContent = async({ filePath, content }) => {
  const resolvedPath = path.join(rootPath, filePath)
  console.log(`Ensuring ${filePath}`)

  await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true })
  const file = await fs.promises.readFile(resolvedPath, 'utf8').catch(() => '')
  const eol = file.includes('\r\n') ? '\r\n' : '\n'
  const normalizedFile = file.replace(/\r\n/g, '\n')
  const normalizedContent = content.replace(/\r\n/g, '\n')

  if (normalizedFile == normalizedContent) return
  await fs.promises.writeFile(resolvedPath, normalizedContent.replace(/\n/g, eol))
}

// 6-8③：patchSwiftAudioSeek 已删除——其目标 AVPlayerWrapper.swift 在
// react-native-track-player 树内根本不存在（来自 SwiftAudioEx pod），
// 该函数每次都走 "not found" 提前返回，是 no-op。
// F-A1：Podfile 的 lx_patch_swift_audio_seek 同样从未生效——其正则要求不存
// 在的 seek(by:)，且替换体 Double/Int 类型错、引用不存在的
// timeToSeekToAfterLoading，已一并删除；seek 精度补丁目前不存在，seek 走
// 上游 SwiftAudioEx 0.14.7 默认 seek(to:)。

const patchTrackPlayerSoundEffectRefresh = async() => {
  const filePath = 'node_modules/react-native-track-player/ios/RNTrackPlayer/RNTrackPlayer.swift'

  await patchFileByRegex({
    filePath,
    pattern: /@objc private func handleSoundEffectConfigChanged\(_ notification: Notification\) \{[\s\S]*?\n\s{4}\/\/ MARK: - QueuedAudioPlayer Event Handlers/,
    replacement: `@objc private func handleSoundEffectConfigChanged(_ notification: Notification) {
        let nextConfig = LXSoundEffectConfiguration.fromUserInfo(notification.userInfo)
        if Thread.isMainThread {
            soundEffectConfig = nextConfig
            refreshSoundEffectAudioMix()
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.soundEffectConfig = nextConfig
            self?.refreshSoundEffectAudioMix()
        }
    }

    private func refreshSoundEffectAudioMixOnMainThread() {
        if Thread.isMainThread {
            refreshSoundEffectAudioMix()
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.refreshSoundEffectAudioMix()
        }
    }

    private func refreshSoundEffectAudioMix() {
        guard let currentItem = player.currentPlayerItem else {
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        if soundEffectPlayerItem !== currentItem {
            soundEffectPlayerItem?.audioMix = nil
        }

        if let processor = soundEffectTapProcessor, soundEffectPlayerItem === currentItem {
            processor.updateConfig(soundEffectConfig)
            if soundEffectConfig.isActive {
                if currentItem.audioMix == nil, let audioMix = processor.makeAudioMix(for: currentItem.asset) {
                    currentItem.audioMix = audioMix
                }
            } else {
                currentItem.audioMix = nil
                soundEffectTapProcessor = nil
                soundEffectPlayerItem = nil
            }
            return
        }

        guard soundEffectConfig.isActive else {
            currentItem.audioMix = nil
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        let processor = LXEqualizerAudioMixController(config: soundEffectConfig)
        guard let audioMix = processor.makeAudioMix(for: currentItem.asset) else {
            currentItem.audioMix = nil
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        currentItem.audioMix = audioMix
        soundEffectPlayerItem = currentItem
        soundEffectTapProcessor = processor
    }

    // MARK: - QueuedAudioPlayer Event Handlers`,
  })

  await patchFileByRegex({
    filePath,
    pattern: /func handleAudioPlayerStateChange\(state: AVPlayerWrapperState\) \{[\s\S]*?\n\s{4}\}/,
    replacement: `func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {
        refreshSoundEffectAudioMixOnMainThread()
        sendEvent(withName: "playback-state", body: ["state": state.rawValue])
        postLifecycleEvent("state", state: state)
    }`,
  })

  await patchFileByRegex({
    filePath,
    pattern: /func handleAudioPlayerQueueIndexChange\(previousIndex: Int\?, nextIndex: Int\?\) \{[\s\S]*?\n\s{8}var dictionary: \[String: Any\] = \[ "position": player.currentTime \]/,
    replacement: `func handleAudioPlayerQueueIndexChange(previousIndex: Int?, nextIndex: Int?) {
        refreshSoundEffectAudioMixOnMainThread()
        var dictionary: [String: Any] = [ "position": player.currentTime ]`,
  })
}

;(async() => {
  for (const target of patchTargets) {
    try {
      await patchFile(target)
    } catch (err) {
      console.error(`Patch ${target.filePath} failed: ${err.message}`)
      // 6-8②：任一步失败即记 exitCode 1（postinstall 失败不再静默过 CI），
      // 其余步骤仍继续跑完（尽力而为），最终以非零码退出。
      process.exitCode = 1
    }
  }
  // 6-8③/F-A1：patchSwiftAudioSeek 与 Podfile 的 lx_patch_swift_audio_seek 均已
  // 删除（见上），seek 走上游 SwiftAudioEx 0.14.7 默认 seek(to:)。
  try {
    await patchTrackPlayerSoundEffectRefresh()
  } catch (err) {
    console.error(`Patch TrackPlayer sound effect refresh failed: ${err.message}`)
    process.exitCode = 1
  }
  try {
    await ensureFileContent({
      filePath: 'node_modules/react-native-track-player/ios/RNTrackPlayer/LXEqualizerAudioMix.swift',
      content: equalizerAudioMixSwiftSource,
    })
  } catch (err) {
    console.error(`Ensure LXEqualizerAudioMix.swift failed: ${err.message}`)
    process.exitCode = 1
  }
  try {
    await ensureFileContent({
      filePath: 'node_modules/react-native-track-player/ios/RNTrackPlayer/LXSharedIRConvolutionKernel.hpp',
      content: sharedIRKernelSource,
    })
    await ensureFileContent({
      filePath: 'node_modules/react-native-track-player/ios/RNTrackPlayer/LXSharedIRConvolutionBridge.h',
      content: sharedIRBridgeHeaderSource,
    })
    await ensureFileContent({
      filePath: 'node_modules/react-native-track-player/ios/RNTrackPlayer/LXSharedIRConvolutionBridge.mm',
      content: sharedIRBridgeSource,
    })
  } catch (err) {
    console.error(`Ensure shared IR bridge failed: ${err.message}`)
    process.exitCode = 1
  }
  // 6-8②：失败时尾行如实报错，不再一律打印 finished。
  if (process.exitCode) {
    console.error('\nDependencies patch finished with errors.\n')
  } else {
    console.log('\nDependencies patch finished.\n')
  }
})()
