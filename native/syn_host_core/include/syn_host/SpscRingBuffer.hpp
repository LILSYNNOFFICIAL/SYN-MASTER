#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace syn::host {

/**
 * Wait-free single-producer / single-consumer (SPSC) ring buffer for interleaved
 * or planar float32 audio samples. Uses acquire/release memory ordering only;
 * safe for real-time audio callbacks (zero allocations or mutexes in push/pop).
 */
class SpscRingBuffer {
public:
  explicit SpscRingBuffer(size_t capacitySamples = 65536) {
    resize(capacitySamples);
  }

  void resize(size_t capacitySamples) {
    size_t cap = 1;
    while (cap < capacitySamples + 1) cap <<= 1;
    m_buffer.assign(cap, 0.0f);
    m_mask = cap - 1;
    reset();
  }

  void reset() {
    m_writePos.store(0, std::memory_order_relaxed);
    m_readPos.store(0, std::memory_order_relaxed);
    m_underruns.store(0, std::memory_order_relaxed);
    m_overruns.store(0, std::memory_order_relaxed);
  }

  size_t capacity() const {
    return m_buffer.empty() ? 0 : m_buffer.size() - 1;
  }

  size_t availableToRead() const {
    const size_t w = m_writePos.load(std::memory_order_acquire);
    const size_t r = m_readPos.load(std::memory_order_relaxed);
    return (w - r) & m_mask;
  }

  size_t availableToWrite() const {
    const size_t w = m_writePos.load(std::memory_order_relaxed);
    const size_t r = m_readPos.load(std::memory_order_acquire);
    return (r - w - 1) & m_mask;
  }

  size_t push(const float* src, size_t count) {
    if (!src || count == 0 || m_buffer.empty()) return 0;
    const size_t freeSpace = availableToWrite();
    const size_t toWrite = count <= freeSpace ? count : freeSpace;
    if (toWrite < count) {
      m_overruns.fetch_add(1, std::memory_order_relaxed);
    }
    size_t w = m_writePos.load(std::memory_order_relaxed);
    for (size_t i = 0; i < toWrite; ++i) {
      m_buffer[(w + i) & m_mask] = src[i];
    }
    m_writePos.store((w + toWrite) & m_mask, std::memory_order_release);
    return toWrite;
  }

  size_t pop(float* dst, size_t count) {
    if (!dst || count == 0 || m_buffer.empty()) return 0;
    const size_t avail = availableToRead();
    const size_t toRead = count <= avail ? count : avail;
    if (toRead < count) {
      m_underruns.fetch_add(1, std::memory_order_relaxed);
    }
    size_t r = m_readPos.load(std::memory_order_relaxed);
    for (size_t i = 0; i < toRead; ++i) {
      dst[i] = m_buffer[(r + i) & m_mask];
    }
    for (size_t i = toRead; i < count; ++i) {
      dst[i] = 0.0f;
    }
    m_readPos.store((r + toRead) & m_mask, std::memory_order_release);
    return toRead;
  }

  uint64_t underrunCount() const { return m_underruns.load(std::memory_order_relaxed); }
  uint64_t overrunCount() const { return m_overruns.load(std::memory_order_relaxed); }

private:
  std::vector<float> m_buffer;
  size_t m_mask = 0;
  std::atomic<size_t> m_writePos{0};
  std::atomic<size_t> m_readPos{0};
  std::atomic<uint64_t> m_underruns{0};
  std::atomic<uint64_t> m_overruns{0};
};

} // namespace syn::host
