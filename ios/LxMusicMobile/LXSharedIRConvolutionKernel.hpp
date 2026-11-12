#pragma once

#include <Accelerate/Accelerate.h>
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <utility>
#include <vector>

namespace LXSharedDSP {

class IRConvolutionKernel {
public:
  static std::vector<std::pair<size_t, size_t>> routeMapping(size_t irChannelCount, size_t inputChannels, size_t outputChannels) {
    if (inputChannels >= 2 && outputChannels >= 2 && irChannelCount >= 4) {
      return {
        { 0 * inputChannels + 0, 0 },
        { 0 * inputChannels + 1, 2 },
        { 1 * inputChannels + 0, 1 },
        { 1 * inputChannels + 1, 3 },
      };
    }
    if (outputChannels >= 2 && irChannelCount >= 2 && inputChannels == 1) {
      return { { 0, 0 }, { 1, 1 } };
    }
    if (inputChannels >= 2 && outputChannels >= 2 && irChannelCount >= 2) {
      return {
        { 0 * inputChannels + 0, 0 },
        { 1 * inputChannels + 1, 1 },
      };
    }
    if (inputChannels >= 2 && outputChannels >= 2) {
      return {
        { 0 * inputChannels + 0, 0 },
        { 1 * inputChannels + 1, 0 },
      };
    }
    return { { 0, 0 } };
  }

  IRConvolutionKernel(const std::vector<std::vector<float>> &irChannels, size_t inputChannels, size_t outputChannels, float dryGain, float wetGain, size_t blockSize = 512) {
    _blockSize = blockSize;
    _fftSize = _blockSize * 2;
    _inputChannels = std::max<size_t>(1, inputChannels);
    _outputChannels = std::max<size_t>(1, outputChannels);
    _dryGain = dryGain;
    _wetGain = wetGain;

    size_t impulseLength = 0;
    for (const auto &channel : irChannels) impulseLength = std::max(impulseLength, channel.size());
    if (impulseLength == 0) return;
    _partitionCount = std::max<size_t>(1, (size_t)std::ceil((double)impulseLength / (double)_blockSize));

    size_t log2Value = (size_t)std::llround(std::log2((double)_fftSize));
    if (((size_t)1 << log2Value) != _fftSize) return;
    _log2n = (vDSP_Length)log2Value;
    _fftSetup = vDSP_create_fftsetup(_log2n, FFTRadix(kFFTRadix2));
    if (_fftSetup == nullptr) return;

    size_t routeCount = _inputChannels * _outputChannels;
    _filterReal.assign(routeCount, std::vector<std::vector<float>>(_partitionCount, std::vector<float>(_fftSize, 0)));
    _filterImag.assign(routeCount, std::vector<std::vector<float>>(_partitionCount, std::vector<float>(_fftSize, 0)));
    _historyReal.assign(_inputChannels, std::vector<std::vector<float>>(_partitionCount, std::vector<float>(_fftSize, 0)));
    _historyImag.assign(_inputChannels, std::vector<std::vector<float>>(_partitionCount, std::vector<float>(_fftSize, 0)));
    _overlaps.assign(_outputChannels, std::vector<float>(_blockSize, 0));
    _inputBuffer.assign(_inputChannels, std::vector<float>(_blockSize, 0));
    _outputQueue.assign(_outputChannels, std::vector<float>(_blockSize, 0));
    _inputScratchReal.assign(_inputChannels, std::vector<float>(_fftSize, 0));
    _inputScratchImag.assign(_inputChannels, std::vector<float>(_fftSize, 0));
    _sumScratchReal.assign(_outputChannels, std::vector<float>(_fftSize, 0));
    _sumScratchImag.assign(_outputChannels, std::vector<float>(_fftSize, 0));

    auto routeMap = routeMapping(irChannels.size(), _inputChannels, _outputChannels);
    for (const auto &route : routeMap) {
      const auto &impulseChannel = irChannels[std::min(route.second, irChannels.size() - 1)];
      for (size_t partition = 0; partition < _partitionCount; partition++) {
        size_t start = partition * _blockSize;
        size_t end = std::min(start + _blockSize, impulseChannel.size());
        std::vector<float> real(_fftSize, 0);
        if (start < end) std::copy(impulseChannel.begin() + (ptrdiff_t)start, impulseChannel.begin() + (ptrdiff_t)end, real.begin());
        std::vector<float> imag(_fftSize, 0);
        performFFT(real, imag, FFTDirection(FFT_FORWARD));
        _filterReal[route.first][partition] = std::move(real);
        _filterImag[route.first][partition] = std::move(imag);
      }
    }

    _isReady = true;
  }

  ~IRConvolutionKernel() {
    if (_fftSetup != nullptr) vDSP_destroy_fftsetup(_fftSetup);
  }

  bool isReady() const {
    return _isReady;
  }

  void updateGains(float dryGain, float wetGain) {
    _dryGain = dryGain;
    _wetGain = wetGain;
  }

  void processPCMChannels(float *const *channels, size_t frameCount, size_t activeChannels) {
    if (!_isReady || channels == nullptr) return;
    size_t usedChannels = std::min(activeChannels, _inputChannels);
    if (usedChannels == 0) return;

    // 6-4(b): 跟踪当前累积块在本调用内的起始帧（< 0 表示该块在本次调用前已开始累积）。
    ptrdiff_t blockStartFrame = -(ptrdiff_t)_inputFill;
    // M-6: 本调用内队列排出的高水位（队列逻辑已写到的最大帧号，-1 表示本调用
    // 内尚无排出）。对齐回写只触碰本次调用的缓冲，故只需确认本调用内队列排出
    // 未写进本块区间；横跨块的排出恰好覆盖下一块区间（高水位 >= blockStartFrame
    // 时必须走旧队列兜底，否则对齐回写会抹掉已排出的前块输出——511 帧丢失）。
    // 跨调用同型触发亦被守住：上调用残留的队列会在本调用的对齐检查之前先逐帧
    // 排出（首个对齐候选块最早在第 511 帧完成，残留排出先写 0..510 帧），水位
    // 已抬高，对齐条件自然不满足；故水位只需调用内局部量，跨调用不残留。
    ptrdiff_t queueDrainHighWater = -1;
    for (size_t frame = 0; frame < frameCount; frame++) {
      for (size_t channel = 0; channel < usedChannels; channel++) {
        _inputBuffer[channel][_inputFill] = channels[channel][frame];
      }
      _inputFill += 1;
      if (_inputFill >= _blockSize) {
        processBufferedBlock();
        _inputFill = 0;
        // 6-4(a)(b): 若整块都在本次调用内（Swift 桥每调用喂满 512 帧、FLAC 渲染块通常亦然），
        // 直接把卷积结果原地写回本块各帧、与输入块对齐，不再走跨调用的输出队列。
        // 旧行为：每块仅最后一帧输出 1 个湿样本、其余 511 帧干声直通，叠加 Swift 侧
        // 累积块总延迟 1022 帧且有干声回声；改后单级延迟 512 帧（仅 Swift 侧累积块）。
        // 块横跨调用边界时（渲染块非 512 倍数、流尾短读）仍走旧的输出队列兜底。
        // M-6: 追加高水位门控——仅当本调用内队列排出未曾写进本块区间时才可原地
        // 回写；否则落入旧队列兜底（与横跨块同一路径，输出正确、仅延迟回旧值）。
        if (blockStartFrame >= 0 && queueDrainHighWater < blockStartFrame) {
          for (size_t channel = 0; channel < usedChannels; channel++) {
            if (channel >= _outputChannels) {
              for (size_t index = 0; index < _blockSize; index++) {
                channels[channel][(size_t)blockStartFrame + index] = 0.0f;
              }
              continue;
            }
            for (size_t index = 0; index < _blockSize; index++) {
              channels[channel][(size_t)blockStartFrame + index] = _outputQueue[channel][index];
            }
          }
          _outputFrameCount = 0;
          _outputReadIndex = 0;
          blockStartFrame += (ptrdiff_t)_blockSize;
          continue;
        }
        blockStartFrame += (ptrdiff_t)_blockSize;
      }

      if (_outputFrameCount > 0 && _outputReadIndex < _outputFrameCount) {
        for (size_t channel = 0; channel < usedChannels; channel++) {
          channels[channel][frame] = channel < _outputChannels ? _outputQueue[channel][_outputReadIndex] : 0.0f;
        }
        // M-6: 队列排出的唯一写出点（横跨块与旧队列兜底均经此分支逐帧排出），
        // 在此更新高水位；用 max 而非直接赋值，防将来帧序非单调时水位回退。
        queueDrainHighWater = std::max(queueDrainHighWater, (ptrdiff_t)frame);
        _outputReadIndex += 1;
        if (_outputReadIndex >= _outputFrameCount) {
          _outputFrameCount = 0;
          _outputReadIndex = 0;
        }
      } else {
        for (size_t channel = 0; channel < usedChannels; channel++) {
          channels[channel][frame] *= _dryGain;
        }
      }
    }
  }

private:
  void processBufferedBlock() {
    size_t currentHistoryIndex = _historyWriteIndex;

    for (size_t inputChannel = 0; inputChannel < _inputChannels; inputChannel++) {
      auto &real = _inputScratchReal[inputChannel];
      auto &imag = _inputScratchImag[inputChannel];
      std::fill(real.begin(), real.end(), 0.0f);
      std::fill(imag.begin(), imag.end(), 0.0f);
      std::copy(_inputBuffer[inputChannel].begin(), _inputBuffer[inputChannel].end(), real.begin());
      performFFT(real, imag, FFTDirection(FFT_FORWARD));
      _historyReal[inputChannel][currentHistoryIndex] = real;
      _historyImag[inputChannel][currentHistoryIndex] = imag;
    }

    for (size_t outputChannel = 0; outputChannel < _outputChannels; outputChannel++) {
      auto &sumReal = _sumScratchReal[outputChannel];
      auto &sumImag = _sumScratchImag[outputChannel];
      std::fill(sumReal.begin(), sumReal.end(), 0.0f);
      std::fill(sumImag.begin(), sumImag.end(), 0.0f);

      for (size_t inputChannel = 0; inputChannel < _inputChannels; inputChannel++) {
        size_t routeIndex = outputChannel * _inputChannels + inputChannel;
        for (size_t partition = 0; partition < _partitionCount; partition++) {
          size_t historyIndex = (currentHistoryIndex + _partitionCount - partition) % _partitionCount;
          const auto &inputReal = _historyReal[inputChannel][historyIndex];
          const auto &inputImag = _historyImag[inputChannel][historyIndex];
          const auto &filterReal = _filterReal[routeIndex][partition];
          const auto &filterImag = _filterImag[routeIndex][partition];
          for (size_t index = 0; index < _fftSize; index++) {
            float real = filterReal[index] * inputReal[index] - filterImag[index] * inputImag[index];
            float imag = filterReal[index] * inputImag[index] + filterImag[index] * inputReal[index];
            sumReal[index] += real;
            sumImag[index] += imag;
          }
        }
      }

      performFFT(sumReal, sumImag, FFTDirection(FFT_INVERSE));
      float scale = 1.0f / (float)_fftSize;
      for (size_t index = 0; index < _fftSize; index++) sumReal[index] *= scale;

      for (size_t index = 0; index < _blockSize; index++) {
        float wet = (sumReal[index] + _overlaps[outputChannel][index]) * _wetGain;
        float dry = outputChannel < _inputBuffer.size() ? _inputBuffer[outputChannel][index] * _dryGain : 0.0f;
        _outputQueue[outputChannel][index] = dry + wet;
      }
      std::copy(sumReal.begin() + (ptrdiff_t)_blockSize, sumReal.end(), _overlaps[outputChannel].begin());
    }

    _outputReadIndex = 0;
    _outputFrameCount = _blockSize;
    _historyWriteIndex = (currentHistoryIndex + 1) % _partitionCount;
  }

  void performFFT(std::vector<float> &real, std::vector<float> &imag, FFTDirection direction) {
    DSPSplitComplex split = {
      .realp = real.data(),
      .imagp = imag.data(),
    };
    vDSP_fft_zip(_fftSetup, &split, 1, _log2n, direction);
  }

  size_t _blockSize = 0;
  size_t _fftSize = 0;
  size_t _partitionCount = 0;
  size_t _inputChannels = 0;
  size_t _outputChannels = 0;
  vDSP_Length _log2n = 0;
  FFTSetup _fftSetup = nullptr;
  std::vector<std::vector<std::vector<float>>> _filterReal;
  std::vector<std::vector<std::vector<float>>> _filterImag;
  std::vector<std::vector<std::vector<float>>> _historyReal;
  std::vector<std::vector<std::vector<float>>> _historyImag;
  std::vector<std::vector<float>> _overlaps;
  std::vector<std::vector<float>> _inputBuffer;
  std::vector<std::vector<float>> _outputQueue;
  std::vector<std::vector<float>> _inputScratchReal;
  std::vector<std::vector<float>> _inputScratchImag;
  std::vector<std::vector<float>> _sumScratchReal;
  std::vector<std::vector<float>> _sumScratchImag;
  size_t _inputFill = 0;
  size_t _outputReadIndex = 0;
  size_t _outputFrameCount = 0;
  size_t _historyWriteIndex = 0;
  float _dryGain = 1.0f;
  float _wetGain = 0.0f;
  bool _isReady = false;
};

} // namespace LXSharedDSP
