import AVFoundation
import MediaToolbox
import Accelerate

let lxSoundEffectConfigNotification = Notification.Name("LXSoundEffectConfigDidChangeNotification")
let lxSoundEffectBandFrequencies: [Float] = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

private struct LXBiquadCoefficients {
    var b0: Float
    var b1: Float
    var b2: Float
    var a1: Float
    var a2: Float

    static let bypass = LXBiquadCoefficients(b0: 1, b1: 0, b2: 0, a1: 0, a2: 0)

    var isBypass: Bool {
        b0 == 1 && b1 == 0 && b2 == 0 && a1 == 0 && a2 == 0
    }
}

private struct LXBiquadState {
    var z1: Float = 0
    var z2: Float = 0
}

private final class LXPhaseVocoderPitchShifter {
    private struct ChannelState {
        var inputBuffer: [Float]
        var outputBuffer: [Float]
        var hopInput: [Float]
        var outputQueue: [Float]
    }

    // 6-2: hop 处理 scratch，init 时按 blockSize 预分配、逐 hop 复用；
    // processHop 逐声道顺序执行（且调用方 processFrame 全程持 tap 锁），单份 scratch 足够，
    // 实时线程不再逐 hop 分配 4096 浮点数组。
    private struct HopScratch {
        var windowed: [Float]
        var spectrumImag: [Float]
        var shiftedReal: [Float]
        var shiftedImag: [Float]
        var magnitudes: [Float]
    }

    private let blockSize: Int
    private let hopSize: Int
    private let overlapCount: Float
    private let channelCount: Int
    private let fftSetup: FFTSetup
    private let log2n: vDSP_Length
    private let hannWindow: [Float]
    private var channels: [ChannelState]
    private var hopScratch: HopScratch
    private var hopFill = 0
    private var outputReadIndex = 0
    private var timeCursor = 0

    init?(channelCount: Int, blockSize: Int = 4096, hopSize: Int = 128) {
        guard blockSize > hopSize, blockSize % hopSize == 0 else { return nil }

        let log2Value = Int(log2(Double(blockSize)))
        guard (1 << log2Value) == blockSize else { return nil }
        guard let setup = vDSP_create_fftsetup(vDSP_Length(log2Value), FFTRadix(kFFTRadix2)) else { return nil }

        self.blockSize = blockSize
        self.hopSize = hopSize
        self.overlapCount = Float(blockSize / hopSize)
        self.channelCount = max(channelCount, 1)
        self.fftSetup = setup
        self.log2n = vDSP_Length(log2Value)
        self.hannWindow = LXPhaseVocoderPitchShifter.makeHannWindow(length: blockSize)
        self.channels = Array(
            repeating: ChannelState(
                inputBuffer: Array(repeating: 0, count: blockSize),
                outputBuffer: Array(repeating: 0, count: blockSize),
                hopInput: Array(repeating: 0, count: hopSize),
                outputQueue: Array(repeating: 0, count: hopSize)
            ),
            count: self.channelCount
        )
        // 6-2: hop scratch 预分配（magnitudes 只需半谱 +1 项）。
        self.hopScratch = HopScratch(
            windowed: Array(repeating: 0, count: blockSize),
            spectrumImag: Array(repeating: 0, count: blockSize),
            shiftedReal: Array(repeating: 0, count: blockSize),
            shiftedImag: Array(repeating: 0, count: blockSize),
            magnitudes: Array(repeating: 0, count: blockSize / 2 + 1)
        )
    }

    deinit {
        vDSP_destroy_fftsetup(fftSetup)
    }

    func processFrame(_ samples: inout [Float], activeChannels: Int, pitchFactor: Float) {
        let usedChannels = min(activeChannels, channelCount)
        guard usedChannels > 0 else { return }

        for channel in 0..<usedChannels {
            channels[channel].hopInput[hopFill] = samples[channel]
        }
        hopFill += 1

        if outputReadIndex < hopSize {
            for channel in 0..<usedChannels {
                samples[channel] = channels[channel].outputQueue[outputReadIndex]
            }
            outputReadIndex += 1
        } else {
            for channel in 0..<usedChannels {
                samples[channel] = 0
            }
        }

        if hopFill >= hopSize {
            processHop(pitchFactor: pitchFactor, usedChannels: usedChannels)
            hopFill = 0
            outputReadIndex = 0
            timeCursor += hopSize
        }
    }

    private func processHop(pitchFactor: Float, usedChannels: Int) {
        // 6-2: 全程复用 init 预分配的 hopScratch，不再逐 hop 分配 4096 浮点数组；
        // 各声道顺序处理，单份 scratch 足够（调用方 processFrame 全程持 tap 锁）。
        // 逐项对照原实现：数值语义逐行等价（移位/加窗/正逆变换/缩放/累加/输出移位）。
        for channel in 0..<usedChannels {
            // 输入移位：原地前移（源下标恒大于目标下标，无重叠问题），尾部填入本 hop 采样。
            for index in 0..<(blockSize - hopSize) {
                channels[channel].inputBuffer[index] = channels[channel].inputBuffer[index + hopSize]
            }
            for index in 0..<hopSize {
                channels[channel].inputBuffer[blockSize - hopSize + index] = channels[channel].hopInput[index]
            }

            // 加窗：拷入 scratch 后原地加窗；加窗后的缓冲即正变换的实部输入。
            for index in 0..<blockSize {
                hopScratch.windowed[index] = channels[channel].inputBuffer[index]
            }
            applyWindow(&hopScratch.windowed)

            for index in 0..<blockSize {
                hopScratch.spectrumImag[index] = 0
            }
            performFFT(real: &hopScratch.windowed, imag: &hopScratch.spectrumImag, direction: FFTDirection(FFT_FORWARD))

            for index in 0..<blockSize {
                hopScratch.shiftedReal[index] = 0
                hopScratch.shiftedImag[index] = 0
            }
            shiftSpectrum(real: hopScratch.windowed, imag: hopScratch.spectrumImag, intoReal: &hopScratch.shiftedReal, intoImag: &hopScratch.shiftedImag, pitchFactor: pitchFactor)
            completeSpectrum(real: &hopScratch.shiftedReal, imag: &hopScratch.shiftedImag)

            performFFT(real: &hopScratch.shiftedReal, imag: &hopScratch.shiftedImag, direction: FFTDirection(FFT_INVERSE))
            // 逆变换缩放 + 加窗：原地完成，不再经 map 新建 timeDomain 数组。
            for index in 0..<blockSize {
                hopScratch.shiftedReal[index] /= Float(blockSize)
            }
            applyWindow(&hopScratch.shiftedReal)

            for index in 0..<blockSize {
                channels[channel].outputBuffer[index] += hopScratch.shiftedReal[index] / overlapCount
            }
            for index in 0..<hopSize {
                channels[channel].outputQueue[index] = channels[channel].outputBuffer[index]
            }
            // 输出移位：原地前移后尾部清零（与原 replaceSubrange + repeatElement(0) 等价）。
            for index in 0..<(blockSize - hopSize) {
                channels[channel].outputBuffer[index] = channels[channel].outputBuffer[index + hopSize]
            }
            for index in (blockSize - hopSize)..<blockSize {
                channels[channel].outputBuffer[index] = 0
            }
        }
    }

    private func shiftSpectrum(real: [Float], imag: [Float], intoReal shiftedReal: inout [Float], intoImag shiftedImag: inout [Float], pitchFactor: Float) {
        let halfCount = blockSize / 2
        guard halfCount > 2 else { return }

        // 6-2: 幅值写进预分配的 magnitudes scratch，不再逐 hop 新建数组。
        computeMagnitudes(real: real, imag: imag, count: halfCount + 1, into: &hopScratch.magnitudes)
        let peaks = findPeaks(in: hopScratch.magnitudes)

        for (peakIndex, currentPeak) in peaks.enumerated() {
            let shiftedPeak = Int(round(Float(currentPeak) * pitchFactor))
            if shiftedPeak > halfCount { break }

            let startIndex: Int
            if peakIndex > 0 {
                startIndex = currentPeak - Int(floor(Double(currentPeak - peaks[peakIndex - 1]) / 2.0))
            } else {
                startIndex = 0
            }

            let endIndex: Int
            if peakIndex < peaks.count - 1 {
                endIndex = currentPeak + Int(ceil(Double(peaks[peakIndex + 1] - currentPeak) / 2.0))
            } else {
                endIndex = halfCount + 1
            }

            for offset in (startIndex - currentPeak)..<(endIndex - currentPeak) {
                let binIndex = currentPeak + offset
                let shiftedIndex = shiftedPeak + offset
                if shiftedIndex < 0 || shiftedIndex > halfCount || binIndex < 0 || binIndex > halfCount { continue }

                let omegaDelta = 2 * Float.pi * Float(shiftedIndex - binIndex) / Float(blockSize)
                let phase = omegaDelta * Float(timeCursor)
                let phaseShiftReal = cos(phase)
                let phaseShiftImag = sin(phase)
                let valueReal = real[binIndex]
                let valueImag = imag[binIndex]

                let shiftedValueReal = valueReal * phaseShiftReal - valueImag * phaseShiftImag
                let shiftedValueImag = valueReal * phaseShiftImag + valueImag * phaseShiftReal
                shiftedReal[shiftedIndex] += shiftedValueReal
                shiftedImag[shiftedIndex] += shiftedValueImag
            }
        }
    }

    // 6-2: 幅值写进调用方传入的预分配缓冲（hopScratch.magnitudes），不再逐 hop 新建数组。
    private func computeMagnitudes(real: [Float], imag: [Float], count: Int, into result: inout [Float]) {
        for index in 0..<count {
            result[index] = real[index] * real[index] + imag[index] * imag[index]
        }
    }

    private func findPeaks(in magnitudes: [Float]) -> [Int] {
        guard magnitudes.count > 4 else { return [] }
        var peaks: [Int] = []
        var index = 2
        let end = magnitudes.count - 2
        while index < end {
            let magnitude = magnitudes[index]
            if magnitudes[index - 1] >= magnitude || magnitudes[index - 2] >= magnitude {
                index += 1
                continue
            }
            if magnitudes[index + 1] >= magnitude || magnitudes[index + 2] >= magnitude {
                index += 1
                continue
            }
            peaks.append(index)
            index += 2
        }
        return peaks
    }

    private func completeSpectrum(real: inout [Float], imag: inout [Float]) {
        let half = blockSize / 2
        guard half > 1 else { return }
        for index in 1..<half {
            real[blockSize - index] = real[index]
            imag[blockSize - index] = -imag[index]
        }
    }

    private func applyWindow(_ values: inout [Float]) {
        for index in 0..<min(values.count, hannWindow.count) {
            values[index] *= hannWindow[index]
        }
    }

    private func performFFT(real: inout [Float], imag: inout [Float], direction: FFTDirection) {
        real.withUnsafeMutableBufferPointer { realPointer in
            imag.withUnsafeMutableBufferPointer { imagPointer in
                var splitComplex = DSPSplitComplex(realp: realPointer.baseAddress!, imagp: imagPointer.baseAddress!)
                vDSP_fft_zip(fftSetup, &splitComplex, 1, log2n, direction)
            }
        }
    }

    private static func makeHannWindow(length: Int) -> [Float] {
        guard length > 0 else { return [] }
        return (0..<length).map { index in
            Float(0.8 * (1 - cos(2 * Double.pi * Double(index) / Double(length))))
        }
    }
}

private final class LXSpatialPannerEngine {
    private struct DelayLine {
        var buffer: [Float]
        var writeIndex = 0

        init(size: Int) {
            buffer = Array(repeating: 0, count: max(size, 1))
        }

        mutating func pushAndRead(_ input: Float, delaySamples: Int) -> Float {
            let bufferCount = buffer.count
            let clampedDelay = max(0, min(delaySamples, bufferCount - 1))
            buffer[writeIndex] = input
            let readIndex = (writeIndex - clampedDelay + bufferCount) % bufferCount
            let output = buffer[readIndex]
            writeIndex += 1
            if writeIndex >= bufferCount {
                writeIndex = 0
            }
            return output
        }
    }

    private let sampleRate: Double
    private var processedSamples: Double = 0
    private var maxDelaySamples: Int
    private var leftDelay = DelayLine(size: 1)
    private var rightDelay = DelayLine(size: 1)
    private var soundR: Float = 0.5
    private var speed: Float = 25

    init(sampleRate: Double, soundR: Float, speed: Float) {
        self.sampleRate = sampleRate
        self.maxDelaySamples = max(Int(round(sampleRate * 0.00075)), 1)
        self.leftDelay = DelayLine(size: maxDelaySamples + 2)
        self.rightDelay = DelayLine(size: maxDelaySamples + 2)
        update(soundR: soundR, speed: speed)
    }

    func update(soundR: Float, speed: Float) {
        self.soundR = max(0.1, min(soundR / 10, 3))
        self.speed = max(1, min(speed, 50))
    }

    func processFrame(_ samples: inout [Float], activeChannels: Int) {
        guard activeChannels >= 2, sampleRate > 0 else { return }

        let phaseStep = (Double.pi / 180.0) / (max(Double(speed) * 0.01, 0.1) * sampleRate)
        let angle = Float(processedSamples * phaseStep)
        let x = sin(angle) * soundR
        let y = cos(angle) * soundR
        let z = cos(angle) * soundR
        // 6-5: 距离衰减与 C++ 侧（FLAC 路径）公式对齐：1/(1+0.18*distance)；
        // 原先硬编码 1，y 是死计算，两引擎开环绕时最大约 48% 音量差。
        let distance = sqrt(x * x + y * y + z * z)
        let attenuation: Float = 1 / (1 + 0.18 * distance)
        let normalizedX = max(-1, min(1, x / max(soundR, 0.0001)))
        let leftGain = attenuation * sqrt(0.5 * (1 - normalizedX))
        let rightGain = attenuation * sqrt(0.5 * (1 + normalizedX))
        let backFactor = z > 0 ? max(0.72, 1 - 0.12 * z) : 1
        let sidePreserve = 0.28 * attenuation
        let itdSamples = Int(round(abs(normalizedX) * Float(maxDelaySamples)))

        let inputLeft = samples[0]
        let inputRight = samples[1]
        let mid = 0.5 * (inputLeft + inputRight)
        let side = 0.5 * (inputLeft - inputRight)

        let delayedLeft = leftDelay.pushAndRead(mid * leftGain * backFactor, delaySamples: normalizedX > 0 ? itdSamples : 0)
        let delayedRight = rightDelay.pushAndRead(mid * rightGain * backFactor, delaySamples: normalizedX < 0 ? itdSamples : 0)

        samples[0] = max(min(delayedLeft + side * sidePreserve, 1), -1)
        samples[1] = max(min(delayedRight - side * sidePreserve, 1), -1)
        processedSamples += 1
    }
}

private final class LXDynamicsProcessor {
    private let attackCoeff: Float
    private let releaseCoeff: Float
    private let limiterThreshold: Float = 0.98
    private var currentGain: Float = 1

    init?(sampleRate: Double) {
        guard sampleRate > 0 else { return nil }
        self.attackCoeff = exp(-1 / (0.001 * Float(sampleRate)))
        self.releaseCoeff = exp(-1 / (0.08 * Float(sampleRate)))
    }

    func processFrame(_ samples: inout [Float], activeChannels: Int) {
        guard activeChannels > 0 else { return }

        var peak: Float = 0
        for channel in 0..<activeChannels {
            peak = max(peak, abs(samples[channel]))
        }

        var targetGain: Float = 1
        if peak > limiterThreshold {
            targetGain = limiterThreshold / peak
        }

        let coeff = targetGain < currentGain ? attackCoeff : releaseCoeff
        currentGain = coeff * currentGain + (1 - coeff) * targetGain
        currentGain = max(0, min(currentGain, 1))

        for channel in 0..<activeChannels {
            samples[channel] *= currentGain
        }
    }
}

struct LXSoundEffectConfiguration: Equatable {
    var equalizerEnabled = false
    var gains = LXEqualizerAudioMixController.normalizeGains([])
    var convolutionFileName = ""
    var convolutionAssetUri = ""
    var convolutionMainGain: Float = 10
    var convolutionSendGain: Float = 0
    var pannerEnabled = false
    var pannerSoundR: Float = 5
    var pannerSpeed: Float = 25
    var pitchPlaybackRate: Float = 1

    var hasEqualizer: Bool {
        equalizerEnabled && gains.contains(where: { abs($0) >= 0.01 })
    }

    var hasConvolution: Bool {
        !convolutionFileName.isEmpty
    }

    var hasPanner: Bool {
        pannerEnabled
    }

    var hasPitchShift: Bool {
        abs(pitchPlaybackRate - 1) >= 0.01
    }

    var isActive: Bool {
        hasEqualizer || hasConvolution || hasPanner || hasPitchShift
    }

    static func fromUserInfo(_ userInfo: [AnyHashable: Any]?) -> LXSoundEffectConfiguration {
        let equalizerInfo = userInfo?["equalizer"] as? [AnyHashable: Any] ?? userInfo
        let convolutionInfo = userInfo?["convolution"] as? [AnyHashable: Any]
        let pannerInfo = userInfo?["panner"] as? [AnyHashable: Any]
        let pitchInfo = userInfo?["pitchShifter"] as? [AnyHashable: Any]

        let inputGains = equalizerInfo?["gains"] as? [NSNumber] ?? []
        var gains = Array(repeating: Float(0), count: lxSoundEffectBandFrequencies.count)
        for index in 0..<gains.count {
            gains[index] = index < inputGains.count ? inputGains[index].floatValue : 0
        }

        return LXSoundEffectConfiguration(
            equalizerEnabled: equalizerInfo?["enabled"] as? Bool ?? false,
            gains: LXEqualizerAudioMixController.normalizeGains(gains),
            convolutionFileName: (convolutionInfo?["fileName"] as? String) ?? "",
            convolutionAssetUri: (convolutionInfo?["assetUri"] as? String) ?? "",
            convolutionMainGain: clampedFloat(convolutionInfo?["mainGain"], defaultValue: 10, minValue: 0, maxValue: 50),
            convolutionSendGain: clampedFloat(convolutionInfo?["sendGain"], defaultValue: 0, minValue: 0, maxValue: 50),
            pannerEnabled: pannerInfo?["enabled"] as? Bool ?? false,
            pannerSoundR: clampedFloat(pannerInfo?["soundR"], defaultValue: 5, minValue: 1, maxValue: 30),
            pannerSpeed: clampedFloat(pannerInfo?["speed"], defaultValue: 25, minValue: 1, maxValue: 50),
            pitchPlaybackRate: clampedFloat(pitchInfo?["playbackRate"], defaultValue: 1, minValue: 0.5, maxValue: 1.5)
        )
    }

    private static func clampedFloat(_ value: Any?, defaultValue: Float, minValue: Float, maxValue: Float) -> Float {
        let result: Float
        if let number = value as? NSNumber {
            result = number.floatValue
        } else {
            result = defaultValue
        }
        return min(max(result, minValue), maxValue)
    }
}

final class LXEqualizerAudioMixController {
    private let lock = NSLock()
    private let convolutionLoadQueue = DispatchQueue(label: "com.lxmusicmobile.soundeffect.convolution", qos: .userInitiated)
    private var config = LXSoundEffectConfiguration()
    private var coefficients = Array(repeating: LXBiquadCoefficients.bypass, count: lxSoundEffectBandFrequencies.count)
    private var equalizerHeadroomGain: Float = 1
    private var eqStates: [[LXBiquadState]] = []
    private var convolutionEngine: LXConvolutionEngine?
    private var pendingConvolutionLoadID: UInt64 = 0
    private var dynamicsProcessor: LXDynamicsProcessor?
    private var pitchEngine: LXPhaseVocoderPitchShifter?
    private var pannerEngine: LXSpatialPannerEngine?
    private var sampleRate: Double = 0
    private var channelsPerFrame = 0
    private var bitsPerChannel: UInt32 = 0
    private var isFloat = false
    private var isInterleaved = false
    // 6-2: 逐帧采样 scratch，prepare 时按 channelsPerFrame 预分配、逐回调复用；
    // processFloat32/Int16/Int32 只在 tap 锁内调用，单份 scratch 足够，
    // 不再每回调分配 frameSamples。
    private var frameScratch: [Float] = []

    init(enabled: Bool, gains: [Float]) {
        updateConfig(enabled: enabled, gains: gains)
    }

    init(config: LXSoundEffectConfiguration) {
        updateConfig(config)
    }

    func updateConfig(enabled: Bool, gains: [Float]) {
        var config = self.config
        config.equalizerEnabled = enabled
        config.gains = Self.normalizeGains(gains)
        updateConfig(config)
    }

    func updateConfig(_ config: LXSoundEffectConfiguration) {
        lock.lock()
        defer { lock.unlock() }

        let previousConfig = self.config
        if previousConfig == config { return }
        self.config = config
        if sampleRate > 0 {
            refreshProcessingStateLocked(previousConfig: previousConfig, resetTime: false)
        }
    }

    func makeAudioMix(for asset: AVAsset) -> AVAudioMix? {
        guard let audioTrack = asset.tracks(withMediaType: .audio).first else { return nil }
        guard let tap = makeAudioProcessingTap() else { return nil }

        let params = AVMutableAudioMixInputParameters(track: audioTrack)
        params.audioTapProcessor = tap

        let audioMix = AVMutableAudioMix()
        audioMix.inputParameters = [params]
        return audioMix
    }

    private func makeAudioProcessingTap() -> MTAudioProcessingTap? {
        var callbacks = MTAudioProcessingTapCallbacks(
            version: kMTAudioProcessingTapCallbacksVersion_0,
            clientInfo: UnsafeMutableRawPointer(Unmanaged.passRetained(self).toOpaque()),
            init: { _, clientInfo, tapStorageOut in
                tapStorageOut.pointee = clientInfo
            },
            finalize: { tap in
                let storage = MTAudioProcessingTapGetStorage(tap)
                Unmanaged<LXEqualizerAudioMixController>.fromOpaque(storage).release()
            },
            prepare: { tap, _, processingFormat in
                let storage = MTAudioProcessingTapGetStorage(tap)
                let processor = Unmanaged<LXEqualizerAudioMixController>.fromOpaque(storage).takeUnretainedValue()
                processor.prepare(with: processingFormat.pointee)
            },
            unprepare: { tap in
                let storage = MTAudioProcessingTapGetStorage(tap)
                let processor = Unmanaged<LXEqualizerAudioMixController>.fromOpaque(storage).takeUnretainedValue()
                processor.unprepare()
            },
            process: { tap, numberFrames, _, bufferListInOut, numberFramesOut, flagsOut in
                let storage = MTAudioProcessingTapGetStorage(tap)
                let processor = Unmanaged<LXEqualizerAudioMixController>.fromOpaque(storage).takeUnretainedValue()
                let status = processor.process(
                    tap: tap,
                    numberFrames: numberFrames,
                    bufferListInOut: bufferListInOut,
                    numberFramesOut: numberFramesOut,
                    flagsOut: flagsOut
                )
                if status != noErr {
                    numberFramesOut.pointee = 0
                    flagsOut.pointee = 0
                }
            }
        )

        var tap: MTAudioProcessingTap?
        let status = MTAudioProcessingTapCreate(
            kCFAllocatorDefault,
            &callbacks,
            kMTAudioProcessingTapCreationFlag_PostEffects,
            &tap
        )
        guard status == noErr else {
            // 创建失败时 tap 不存在、finalize 永不会被调用，必须手动释放
            // clientInfo 里 passRetained 的那一份引用，否则每次失败漏一个控制器。
            if let clientInfo = callbacks.clientInfo {
                Unmanaged<LXEqualizerAudioMixController>.fromOpaque(clientInfo).release()
            }
            return nil
        }
        return tap
    }

    private func prepare(with format: AudioStreamBasicDescription) {
        lock.lock()
        defer { lock.unlock() }

        sampleRate = format.mSampleRate
        channelsPerFrame = max(Int(format.mChannelsPerFrame), 1)
        bitsPerChannel = format.mBitsPerChannel
        isFloat = (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        isInterleaved = (format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) == 0
        // 6-2: frameScratch 按当前声道数预分配；声道数不变时不重新分配。
        if frameScratch.count != channelsPerFrame {
            frameScratch = Array(repeating: 0, count: channelsPerFrame)
        }
        refreshProcessingStateLocked(previousConfig: config, resetTime: true)
    }

    private func unprepare() {
        lock.lock()
        defer { lock.unlock() }

        sampleRate = 0
        channelsPerFrame = 0
        bitsPerChannel = 0
        isFloat = false
        isInterleaved = false
        pendingConvolutionLoadID &+= 1
        equalizerHeadroomGain = 1
        eqStates.removeAll(keepingCapacity: false)
        convolutionEngine = nil
        dynamicsProcessor = nil
        pitchEngine = nil
        pannerEngine = nil
        coefficients = Array(repeating: LXBiquadCoefficients.bypass, count: lxSoundEffectBandFrequencies.count)
    }

    private func refreshProcessingStateLocked(previousConfig: LXSoundEffectConfiguration, resetTime: Bool) {
        refreshEqualizerStateLocked(previousConfig: previousConfig, resetTime: resetTime)
        refreshConvolutionStateLocked(resetTime: resetTime)
        refreshDynamicsStateLocked(resetTime: resetTime)
        refreshPitchStateLocked(resetTime: resetTime)
        refreshPannerStateLocked(resetTime: resetTime)
    }

    private func refreshEqualizerStateLocked(previousConfig: LXSoundEffectConfiguration, resetTime: Bool) {
        coefficients = config.hasEqualizer
            ? Self.makeCoefficients(sampleRate: sampleRate, gains: config.gains)
            : Array(repeating: .bypass, count: lxSoundEffectBandFrequencies.count)
        equalizerHeadroomGain = config.hasEqualizer ? Self.makeHeadroomGain(gains: config.gains) : 1

        let shouldResetStates = resetTime ||
            eqStates.count != channelsPerFrame ||
            previousConfig.hasEqualizer != config.hasEqualizer
        if shouldResetStates {
            eqStates = Array(
                repeating: Array(repeating: LXBiquadState(), count: coefficients.count),
                count: channelsPerFrame
            )
        }
    }

    private func refreshConvolutionStateLocked(resetTime: Bool) {
        guard sampleRate > 0, channelsPerFrame > 0, config.hasConvolution else {
            pendingConvolutionLoadID &+= 1
            convolutionEngine = nil
            return
        }

        if let engine = convolutionEngine,
           engine.matches(config: config, sampleRate: sampleRate, channelCount: channelsPerFrame) {
            engine.updateGains(mainGain: config.convolutionMainGain / 10, sendGain: config.convolutionSendGain / 10)
            return
        }

        let configSnapshot = config
        let sampleRateSnapshot = sampleRate
        let channelCountSnapshot = channelsPerFrame
        pendingConvolutionLoadID &+= 1
        let loadID = pendingConvolutionLoadID
        convolutionEngine = nil

        convolutionLoadQueue.async { [weak self] in
            let engine = LXConvolutionEngine(
                config: configSnapshot,
                sampleRate: sampleRateSnapshot,
                channelCount: channelCountSnapshot
            )
            self?.finishConvolutionLoad(
                loadID: loadID,
                configSnapshot: configSnapshot,
                sampleRate: sampleRateSnapshot,
                channelCount: channelCountSnapshot,
                engine: engine
            )
        }
    }

    private func finishConvolutionLoad(
        loadID: UInt64,
        configSnapshot: LXSoundEffectConfiguration,
        sampleRate: Double,
        channelCount: Int,
        engine: LXConvolutionEngine?
    ) {
        lock.lock()
        defer { lock.unlock() }

        guard pendingConvolutionLoadID == loadID,
              abs(self.sampleRate - sampleRate) <= 1,
              self.channelsPerFrame == channelCount,
              self.config.convolutionFileName == configSnapshot.convolutionFileName,
              self.config.convolutionAssetUri == configSnapshot.convolutionAssetUri else {
            return
        }

        convolutionEngine = engine
        convolutionEngine?.updateGains(
            mainGain: config.convolutionMainGain / 10,
            sendGain: config.convolutionSendGain / 10
        )
    }

    private func refreshDynamicsStateLocked(resetTime: Bool) {
        guard config.isActive else {
            dynamicsProcessor = nil
            return
        }
        if resetTime || dynamicsProcessor == nil {
            dynamicsProcessor = LXDynamicsProcessor(sampleRate: sampleRate)
        }
    }

    private func refreshPitchStateLocked(resetTime: Bool) {
        guard config.hasPitchShift else {
            pitchEngine = nil
            return
        }
        if resetTime || pitchEngine == nil {
            pitchEngine = LXPhaseVocoderPitchShifter(channelCount: channelsPerFrame)
        }
    }

    private func refreshPannerStateLocked(resetTime: Bool) {
        guard config.hasPanner, channelsPerFrame >= 2 else {
            pannerEngine = nil
            return
        }
        if resetTime || pannerEngine == nil {
            pannerEngine = LXSpatialPannerEngine(sampleRate: sampleRate, soundR: config.pannerSoundR, speed: config.pannerSpeed)
        }
        pannerEngine?.update(soundR: config.pannerSoundR, speed: config.pannerSpeed)
    }

    private func process(
        tap: MTAudioProcessingTap,
        numberFrames: CMItemCount,
        bufferListInOut: UnsafeMutablePointer<AudioBufferList>,
        numberFramesOut: UnsafeMutablePointer<CMItemCount>,
        flagsOut: UnsafeMutablePointer<MTAudioProcessingTapFlags>
    ) -> OSStatus {
        let status = MTAudioProcessingTapGetSourceAudio(
            tap,
            numberFrames,
            bufferListInOut,
            flagsOut,
            nil,
            numberFramesOut
        )
        guard status == noErr else { return status }

        let frameCount = Int(numberFramesOut.pointee)
        guard frameCount > 0 else { return noErr }

        lock.lock()
        defer { lock.unlock() }

        guard config.isActive, channelsPerFrame > 0 else {
            return noErr
        }

        let audioBuffers = UnsafeMutableAudioBufferListPointer(bufferListInOut)
        if isFloat && bitsPerChannel == 32 {
            processFloat32(audioBuffers, frameCount: frameCount)
        } else if !isFloat && bitsPerChannel == 16 {
            processInt16(audioBuffers, frameCount: frameCount)
        } else if !isFloat && bitsPerChannel == 32 {
            processInt32(audioBuffers, frameCount: frameCount)
        }

        return noErr
    }

    private func processFloat32(_ audioBuffers: UnsafeMutableAudioBufferListPointer, frameCount: Int) {
        if isInterleaved {
            guard let audioBuffer = audioBuffers.first,
                  let data = audioBuffer.mData?.assumingMemoryBound(to: Float.self) else { return }

            // 6-2: 复用 prepare 预分配的 frameScratch，不再每回调分配 frameSamples。
            for frame in 0..<frameCount {
                let baseIndex = frame * channelsPerFrame
                for channel in 0..<channelsPerFrame {
                    frameScratch[channel] = data[baseIndex + channel]
                }
                processFrame(&frameScratch, activeChannels: channelsPerFrame)
                for channel in 0..<channelsPerFrame {
                    data[baseIndex + channel] = frameScratch[channel]
                }
            }
            return
        }

        let activeChannels = min(audioBuffers.count, channelsPerFrame)
        guard activeChannels > 0 else { return }
        for frame in 0..<frameCount {
            for channel in 0..<activeChannels {
                guard let data = audioBuffers[channel].mData?.assumingMemoryBound(to: Float.self) else { continue }
                frameScratch[channel] = data[frame]
            }
            processFrame(&frameScratch, activeChannels: activeChannels)
            for channel in 0..<activeChannels {
                guard let data = audioBuffers[channel].mData?.assumingMemoryBound(to: Float.self) else { continue }
                data[frame] = frameScratch[channel]
            }
        }
    }

    private func processInt16(_ audioBuffers: UnsafeMutableAudioBufferListPointer, frameCount: Int) {
        let scale = Float(Int16.max)
        if isInterleaved {
            guard let audioBuffer = audioBuffers.first,
                  let data = audioBuffer.mData?.assumingMemoryBound(to: Int16.self) else { return }

            // 6-2: 复用 prepare 预分配的 frameScratch，不再每回调分配 frameSamples。
            for frame in 0..<frameCount {
                let baseIndex = frame * channelsPerFrame
                for channel in 0..<channelsPerFrame {
                    frameScratch[channel] = Float(data[baseIndex + channel]) / scale
                }
                processFrame(&frameScratch, activeChannels: channelsPerFrame)
                for channel in 0..<channelsPerFrame {
                    data[baseIndex + channel] = Int16(clamping: Int(frameScratch[channel] * scale))
                }
            }
            return
        }

        let activeChannels = min(audioBuffers.count, channelsPerFrame)
        guard activeChannels > 0 else { return }
        for frame in 0..<frameCount {
            for channel in 0..<activeChannels {
                guard let data = audioBuffers[channel].mData?.assumingMemoryBound(to: Int16.self) else { continue }
                frameScratch[channel] = Float(data[frame]) / scale
            }
            processFrame(&frameScratch, activeChannels: activeChannels)
            for channel in 0..<activeChannels {
                guard let data = audioBuffers[channel].mData?.assumingMemoryBound(to: Int16.self) else { continue }
                data[frame] = Int16(clamping: Int(frameScratch[channel] * scale))
            }
        }
    }

    private func processInt32(_ audioBuffers: UnsafeMutableAudioBufferListPointer, frameCount: Int) {
        let scale = Float(Int32.max)
        if isInterleaved {
            guard let audioBuffer = audioBuffers.first,
                  let data = audioBuffer.mData?.assumingMemoryBound(to: Int32.self) else { return }

            // 6-2: 复用 prepare 预分配的 frameScratch，不再每回调分配 frameSamples。
            for frame in 0..<frameCount {
                let baseIndex = frame * channelsPerFrame
                for channel in 0..<channelsPerFrame {
                    frameScratch[channel] = Float(data[baseIndex + channel]) / scale
                }
                processFrame(&frameScratch, activeChannels: channelsPerFrame)
                for channel in 0..<channelsPerFrame {
                    data[baseIndex + channel] = Int32(clamping: Int(frameScratch[channel] * scale))
                }
            }
            return
        }

        let activeChannels = min(audioBuffers.count, channelsPerFrame)
        guard activeChannels > 0 else { return }
        for frame in 0..<frameCount {
            for channel in 0..<activeChannels {
                guard let data = audioBuffers[channel].mData?.assumingMemoryBound(to: Int32.self) else { continue }
                frameScratch[channel] = Float(data[frame]) / scale
            }
            processFrame(&frameScratch, activeChannels: activeChannels)
            for channel in 0..<activeChannels {
                guard let data = audioBuffers[channel].mData?.assumingMemoryBound(to: Int32.self) else { continue }
                data[frame] = Int32(clamping: Int(frameScratch[channel] * scale))
            }
        }
    }

    // 6-2: activeChannels 由调用方显式传入（frameScratch 按 channelsPerFrame 预分配，
    // 非交错且 buffer 数不足时不能再从 samples.count 推导）。
    private func processFrame(_ samples: inout [Float], activeChannels: Int) {
        let activeChannels = min(activeChannels, samples.count, channelsPerFrame)
        guard activeChannels > 0 else { return }

        for channel in 0..<activeChannels {
            let output = processEqualizer(samples[channel], channel: channel)
            samples[channel] = output * equalizerHeadroomGain
        }

        processPitch(&samples, activeChannels: activeChannels)

        processConvolution(&samples, activeChannels: activeChannels)

        processDynamics(&samples, activeChannels: activeChannels)

        applyPanner(to: &samples, activeChannels: activeChannels)
        for channel in 0..<activeChannels {
            samples[channel] = max(min(samples[channel], 1), -1)
        }
    }

    private func processEqualizer(_ sample: Float, channel: Int) -> Float {
        guard config.hasEqualizer, channel < eqStates.count else { return sample }

        var output = sample
        for bandIndex in coefficients.indices {
            let coeff = coefficients[bandIndex]
            if coeff.isBypass { continue }

            var state = eqStates[channel][bandIndex]
            let filtered = coeff.b0 * output + state.z1
            state.z1 = coeff.b1 * output - coeff.a1 * filtered + state.z2
            state.z2 = coeff.b2 * output - coeff.a2 * filtered
            eqStates[channel][bandIndex] = state
            output = filtered
        }
        return output
    }

    private func processPitch(_ samples: inout [Float], activeChannels: Int) {
        guard let engine = pitchEngine else { return }
        engine.processFrame(&samples, activeChannels: activeChannels, pitchFactor: config.pitchPlaybackRate)
    }

    private func processConvolution(_ samples: inout [Float], activeChannels: Int) {
        guard let engine = convolutionEngine else {
            let dryGain = config.hasConvolution ? (config.convolutionMainGain / 10) : 1
            if dryGain != 1 {
                for channel in 0..<activeChannels {
                    samples[channel] *= dryGain
                }
            }
            return
        }
        engine.processFrame(&samples, activeChannels: activeChannels)
    }

    private func processDynamics(_ samples: inout [Float], activeChannels: Int) {
        guard let processor = dynamicsProcessor else { return }
        processor.processFrame(&samples, activeChannels: activeChannels)
    }

    private func applyPanner(to samples: inout [Float], activeChannels: Int) {
        guard let engine = pannerEngine else { return }
        engine.processFrame(&samples, activeChannels: activeChannels)
    }

    static func normalizeGains(_ gains: [Float]) -> [Float] {
        var normalized = Array(repeating: Float(0), count: lxSoundEffectBandFrequencies.count)
        for index in 0..<normalized.count {
            normalized[index] = index < gains.count ? gains[index] : 0
        }
        return normalized
    }

    private static func makeHeadroomGain(gains: [Float]) -> Float {
        _ = gains
        return 1
    }

    private static func makeCoefficients(sampleRate: Double, gains: [Float]) -> [LXBiquadCoefficients] {
        guard sampleRate > 0 else {
            return Array(repeating: .bypass, count: lxSoundEffectBandFrequencies.count)
        }

        let q: Float = 1.41
        return lxSoundEffectBandFrequencies.enumerated().map { index, frequency in
            let gain = index < gains.count ? gains[index] : 0
            if abs(gain) < 0.01 { return .bypass }

            let amplitude = pow(10, gain / 40)
            let omega = 2 * Float.pi * frequency / Float(sampleRate)
            let cosOmega = cos(omega)
            let sinOmega = sin(omega)
            let alpha = sinOmega / (2 * q)

            let b0 = 1 + alpha * amplitude
            let b1 = -2 * cosOmega
            let b2 = 1 - alpha * amplitude
            let a0 = 1 + alpha / amplitude
            let a1 = -2 * cosOmega
            let a2 = 1 - alpha / amplitude

            return LXBiquadCoefficients(
                b0: b0 / a0,
                b1: b1 / a0,
                b2: b2 / a0,
                a1: a1 / a0,
                a2: a2 / a0
            )
        }
    }
}

private final class LXConvolutionEngine {
    private let assetKey: String
    private let sampleRate: Double
    private let channelCount: Int
    private let outputChannels: Int
    private let blockSize: Int
    private var dryGain: Float
    private var wetGain: Float
    private let kernel: LXSharedIRConvolutionBridge?
    private var inputBuffer: [[Float]]
    private var inputFill = 0
    private var outputQueue: [[Float]]
    private var outputReadIndex = 0
    private var outputFrameCount = 0
    // 6-2: 卷积块处理 scratch，init 时按 blockSize 预分配、逐块复用；
    // 内核原地处理 scratch 后再逐元拷回 outputQueue（不直接赋值，避免共享存储导致下次复用时 CoW）。
    private var processScratchChannel0: [Float]
    private var processScratchChannel1: [Float]

    init?(config: LXSoundEffectConfiguration, sampleRate: Double, channelCount: Int) {
        let effectiveChannels = max(1, min(channelCount, 2))
        guard let assetKey = Self.assetKey(assetUri: config.convolutionAssetUri, fileName: config.convolutionFileName) else { return nil }
        guard let response = Self.loadImpulseResponse(
            assetUri: config.convolutionAssetUri,
            fileName: config.convolutionFileName,
            sampleRate: sampleRate
        ) else { return nil }

        self.assetKey = assetKey
        self.sampleRate = sampleRate
        self.channelCount = effectiveChannels
        self.outputChannels = max(1, min(effectiveChannels, 2))
        self.blockSize = 512
        self.dryGain = config.convolutionMainGain / 10
        self.wetGain = config.convolutionSendGain / 10
        let bridgedChannels = response.map { channel in
            channel.withUnsafeBufferPointer { buffer in
                guard let baseAddress = buffer.baseAddress else { return Data() }
                return Data(bytes: baseAddress, count: buffer.count * MemoryLayout<Float>.stride)
            }
        }
        self.kernel = LXSharedIRConvolutionBridge(
            irChannelData: bridgedChannels,
            inputChannels: UInt(effectiveChannels),
            outputChannels: UInt(self.outputChannels),
            blockSize: UInt(self.blockSize),
            dryGain: self.dryGain,
            wetGain: self.wetGain
        )
        self.inputBuffer = Array(repeating: Array(repeating: 0, count: self.blockSize), count: effectiveChannels)
        self.outputQueue = Array(repeating: Array(repeating: 0, count: self.blockSize), count: self.outputChannels)
        // 6-2: 块处理 scratch 预分配。
        self.processScratchChannel0 = Array(repeating: 0, count: self.blockSize)
        self.processScratchChannel1 = Array(repeating: 0, count: self.blockSize)
        guard kernel?.isReady() == true else { return nil }
    }

    func matches(config: LXSoundEffectConfiguration, sampleRate: Double, channelCount: Int) -> Bool {
        let effectiveChannels = max(1, min(channelCount, 2))
        guard let nextAssetKey = Self.assetKey(assetUri: config.convolutionAssetUri, fileName: config.convolutionFileName) else {
            return false
        }
        return assetKey == nextAssetKey &&
            abs(self.sampleRate - sampleRate) <= 1 &&
            self.channelCount == effectiveChannels
    }

    func updateGains(mainGain: Float, sendGain: Float) {
        dryGain = mainGain
        wetGain = sendGain
        kernel?.updateDryGain(mainGain, wetGain: sendGain)
    }

    func processFrame(_ samples: inout [Float], activeChannels: Int) {
        let usedChannels = min(activeChannels, channelCount)
        guard usedChannels > 0 else { return }

        for channel in 0..<usedChannels {
            inputBuffer[channel][inputFill] = samples[channel]
        }
        inputFill += 1
        if inputFill >= blockSize {
            processBufferedBlock()
            inputFill = 0
        }

        if outputFrameCount > 0 && outputReadIndex < outputFrameCount {
            for channel in 0..<usedChannels {
                let wet = channel < outputChannels ? outputQueue[channel][outputReadIndex] : 0
                samples[channel] = wet
            }
            outputReadIndex += 1
            if outputReadIndex >= outputFrameCount {
                outputFrameCount = 0
                outputReadIndex = 0
            }
        } else {
            for channel in 0..<usedChannels {
                samples[channel] *= dryGain
            }
        }
    }

    private func processBufferedBlock() {
        outputReadIndex = 0
        outputFrameCount = blockSize

        guard let kernel else {
            for channel in 0..<outputChannels {
                for index in 0..<blockSize {
                    outputQueue[channel][index] = 0
                }
            }
            return
        }

        let activeChannels = min(channelCount, outputChannels)
        // 6-2: 输入逐元拷入预分配 scratch（原先 var processedChannel0 = inputBuffer[0]
        // 是 CoW 共享、内核写入时触发 512 浮点拷贝；单声道时还另建一个零数组），
        // 内核原地处理后逐元拷回 outputQueue。
        for index in 0..<blockSize {
            processScratchChannel0[index] = inputBuffer[0][index]
        }
        if activeChannels > 1 {
            for index in 0..<blockSize {
                processScratchChannel1[index] = inputBuffer[1][index]
            }
        }

        processScratchChannel0.withUnsafeMutableBufferPointer { channel0 in
            guard let channel0Base = channel0.baseAddress else { return }
            if activeChannels > 1 {
                processScratchChannel1.withUnsafeMutableBufferPointer { channel1 in
                    kernel.processStereoChannel0(
                        channel0Base,
                        channel1: channel1.baseAddress,
                        frameCount: UInt(blockSize),
                        activeChannels: UInt(activeChannels)
                    )
                }
            } else {
                kernel.processStereoChannel0(
                    channel0Base,
                    channel1: nil,
                    frameCount: UInt(blockSize),
                    activeChannels: UInt(activeChannels)
                )
            }
        }

        for index in 0..<blockSize {
            outputQueue[0][index] = processScratchChannel0[index]
        }
        if outputChannels > 1 {
            for index in 0..<blockSize {
                outputQueue[1][index] = processScratchChannel1[index]
            }
        }
    }

    private static func loadImpulseResponse(assetUri: String, fileName: String, sampleRate: Double) -> [[Float]]? {
        guard let url = resolveAssetURL(assetUri: assetUri, fileName: fileName) else { return nil }
        guard let audioFile = try? AVAudioFile(forReading: url) else { return nil }

        let frameCapacity = AVAudioFrameCount(audioFile.length)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: audioFile.processingFormat, frameCapacity: frameCapacity) else { return nil }
        do {
            try audioFile.read(into: buffer)
        } catch {
            return nil
        }

        guard let floatChannelData = buffer.floatChannelData else { return nil }
        let frameLength = Int(buffer.frameLength)
        let channelCount = Int(buffer.format.channelCount)
        guard frameLength > 0, channelCount > 0 else { return nil }

        var channels = (0..<channelCount).map { channel in
            Array(UnsafeBufferPointer(start: floatChannelData[channel], count: frameLength))
        }
        if abs(buffer.format.sampleRate - sampleRate) > 1 {
            channels = channels.map { resample($0, from: buffer.format.sampleRate, to: sampleRate) }
        }

        let normalizationScale = calculateNormalizationScale(channels: channels, sampleRate: sampleRate)
        if normalizationScale != 1 {
            channels = channels.map { channel in channel.map { $0 * normalizationScale } }
        }
        return channels
    }

    private static func assetKey(assetUri: String, fileName: String) -> String? {
        guard let url = resolveAssetURL(assetUri: assetUri, fileName: fileName) else { return nil }
        return url.absoluteString.isEmpty ? fileName : url.absoluteString
    }

    private static func resolveAssetURL(assetUri: String, fileName: String) -> URL? {
        if let url = URL(string: assetUri), url.scheme != nil {
            return url
        }
        if assetUri.hasPrefix("/") {
            return URL(fileURLWithPath: assetUri)
        }

        let nsFileName = fileName as NSString
        let resource = nsFileName.deletingPathExtension
        let ext = nsFileName.pathExtension.isEmpty ? nil : nsFileName.pathExtension
        if let bundleURL = Bundle.main.url(forResource: resource, withExtension: ext) {
            return bundleURL
        }
        return nil
    }

    private static func resample(_ input: [Float], from inputSampleRate: Double, to outputSampleRate: Double) -> [Float] {
        guard !input.isEmpty, inputSampleRate > 0, outputSampleRate > 0, abs(inputSampleRate - outputSampleRate) > 0.5 else {
            return input
        }

        let ratio = outputSampleRate / inputSampleRate
        let outputLength = max(1, Int(round(Double(input.count) * ratio)))
        if outputLength == input.count {
            return input
        }

        var output = Array(repeating: Float(0), count: outputLength)
        let maxIndex = input.count - 1
        for index in 0..<outputLength {
            let position = Double(index) / ratio
            let lower = max(0, min(Int(floor(position)), maxIndex))
            let upper = max(0, min(lower + 1, maxIndex))
            let fraction = Float(position - Double(lower))
            if lower == upper {
                output[index] = input[lower]
            } else {
                output[index] = input[lower] * (1 - fraction) + input[upper] * fraction
            }
        }
        return output
    }

    private static func calculateNormalizationScale(channels: [[Float]], sampleRate: Double) -> Float {
        let gainCalibration: Float = 0.00125
        let gainCalibrationSampleRate: Float = 44100
        let minPower: Float = 0.000125
        let numberOfChannels = channels.count
        let length = channels.map(\.count).max() ?? 0
        guard numberOfChannels > 0, length > 0 else { return 1 }

        var power: Float = 0
        for channel in channels {
            var channelPower: Float = 0
            for sample in channel {
                channelPower += sample * sample
            }
            power += channelPower
        }
        power = sqrt(power / Float(numberOfChannels * length))
        if !power.isFinite || power.isNaN || power < minPower {
            power = minPower
        }

        var scale = (1 / power) * gainCalibration
        scale *= gainCalibrationSampleRate / Float(sampleRate)
        if numberOfChannels == 4 {
            scale *= 0.5
        }
        return scale
    }
}
