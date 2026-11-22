#include "syn_host/WindowsPeInspector.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <sstream>

namespace syn::host {

namespace {

uint16_t readU16LE(const uint8_t* p) {
  return static_cast<uint16_t>(p[0]) | (static_cast<uint16_t>(p[1]) << 8);
}

uint32_t readU32LE(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) |
         (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) |
         (static_cast<uint32_t>(p[3]) << 24);
}

constexpr uint16_t IMAGE_FILE_MACHINE_I386 = 0x014c;
constexpr uint16_t IMAGE_FILE_MACHINE_AMD64 = 0x8664;
constexpr uint16_t IMAGE_FILE_MACHINE_ARM64 = 0xaa64;

constexpr uint16_t PE_OPTIONAL_HDR32_MAGIC = 0x010b;
constexpr uint16_t PE_OPTIONAL_HDR64_MAGIC = 0x020b;

class Sha256 {
public:
  Sha256() { reset(); }

  void reset() {
    m_state = {0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
               0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u};
    m_bitLen = 0;
    m_bufLen = 0;
  }

  void update(const uint8_t* data, size_t len) {
    for (size_t i = 0; i < len; ++i) {
      m_buf[m_bufLen++] = data[i];
      if (m_bufLen == 64) {
        transform(m_buf.data());
        m_bitLen += 512;
        m_bufLen = 0;
      }
    }
  }

  std::string finalHex() {
    size_t i = m_bufLen;
    if (m_bufLen < 56) {
      m_buf[i++] = 0x80;
      while (i < 56) m_buf[i++] = 0x00;
    } else {
      m_buf[i++] = 0x80;
      while (i < 64) m_buf[i++] = 0x00;
      transform(m_buf.data());
      std::memset(m_buf.data(), 0, 56);
    }

    m_bitLen += static_cast<uint64_t>(m_bufLen) * 8ULL;
    for (int j = 0; j < 8; ++j) {
      m_buf[63 - j] = static_cast<uint8_t>((m_bitLen >> (j * 8)) & 0xFFu);
    }
    transform(m_buf.data());

    std::ostringstream oss;
    oss << std::hex << std::setfill('0');
    for (uint32_t w : m_state) {
      oss << std::setw(8) << w;
    }
    return oss.str();
  }

private:
  static inline uint32_t rotr(uint32_t x, uint32_t n) {
    return (x >> n) | (x << (32 - n));
  }

  void transform(const uint8_t* block) {
    static constexpr std::array<uint32_t, 64> K = {
        0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
        0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
        0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
        0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
        0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
        0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
        0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
        0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u};

    std::array<uint32_t, 64> w{};
    for (size_t i = 0; i < 16; ++i) {
      w[i] = (static_cast<uint32_t>(block[i * 4]) << 24) |
             (static_cast<uint32_t>(block[i * 4 + 1]) << 16) |
             (static_cast<uint32_t>(block[i * 4 + 2]) << 8) |
             static_cast<uint32_t>(block[i * 4 + 3]);
    }
    for (size_t i = 16; i < 64; ++i) {
      uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
      uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }

    uint32_t a = m_state[0], b = m_state[1], c = m_state[2], d = m_state[3];
    uint32_t e = m_state[4], f = m_state[5], g = m_state[6], h = m_state[7];

    for (size_t i = 0; i < 64; ++i) {
      uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      uint32_t ch = (e & f) ^ ((~e) & g);
      uint32_t temp1 = h + S1 + ch + K[i] + w[i];
      uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
      uint32_t temp2 = S0 + maj;

      h = g;
      g = f;
      f = e;
      e = d + temp1;
      d = c;
      c = b;
      b = a;
      a = temp1 + temp2;
    }

    m_state[0] += a;
    m_state[1] += b;
    m_state[2] += c;
    m_state[3] += d;
    m_state[4] += e;
    m_state[5] += f;
    m_state[6] += g;
    m_state[7] += h;
  }

  std::array<uint32_t, 8> m_state{};
  uint64_t m_bitLen = 0;
  std::array<uint8_t, 64> m_buf{};
  size_t m_bufLen = 0;
};

} // namespace

PeInspectionResult WindowsPeInspector::inspectBytes(const std::vector<uint8_t>& bytes) {
  PeInspectionResult res;
  if (bytes.size() < 64) {
    res.diagnostic = "File too small to contain DOS MZ header (< 64 bytes)";
    return res;
  }

  // DOS header magic "MZ"
  if (bytes[0] != 'M' || bytes[1] != 'Z') {
    res.diagnostic = "Invalid DOS header signature (expected MZ)";
    return res;
  }

  uint32_t peOffset = readU32LE(&bytes[0x3C]);
  // Check bounds safely without overflow: need at least 4 (PE\0\0) + 20 (COFF header) + 2 (Optional magic)
  if (peOffset > bytes.size() || bytes.size() - peOffset < 26) {
    res.diagnostic = "e_lfanew PE header offset out of bounds";
    return res;
  }

  if (bytes[peOffset] != 'P' || bytes[peOffset + 1] != 'E' ||
      bytes[peOffset + 2] != 0 || bytes[peOffset + 3] != 0) {
    res.diagnostic = "Missing PE\\0\\0 signature at e_lfanew";
    return res;
  }

  const uint8_t* coff = &bytes[peOffset + 4];
  uint16_t machine = readU16LE(coff);
  uint16_t optHeaderSize = readU16LE(coff + 16);
  res.machineType = machine;

  uint16_t optMagic = 0;
  if (optHeaderSize >= 2 && bytes.size() - (peOffset + 24) >= 2) {
    optMagic = readU16LE(&bytes[peOffset + 24]);
  }

  if (machine == IMAGE_FILE_MACHINE_AMD64) {
    res.validPe = true;
    res.arch = BinaryArch::X64;
    res.is64Bit = (optMagic == PE_OPTIONAL_HDR64_MAGIC || optMagic == 0);
    res.diagnostic = "Valid Windows x64 PE32+ binary";
  } else if (machine == IMAGE_FILE_MACHINE_I386) {
    res.validPe = true;
    res.arch = BinaryArch::X86;
    res.is64Bit = false;
    res.diagnostic = "Valid Windows x86 (32-bit) PE32 binary — incompatible with 64-bit host";
  } else if (machine == IMAGE_FILE_MACHINE_ARM64) {
    res.validPe = true;
    res.arch = BinaryArch::ARM64;
    res.is64Bit = (optMagic == PE_OPTIONAL_HDR64_MAGIC || optMagic == 0);
    res.diagnostic = "Valid Windows ARM64 PE binary";
  } else {
    res.validPe = true;
    res.arch = BinaryArch::Unknown;
    res.diagnostic = "PE binary with unrecognized machine architecture";
  }

  return res;
}

PeInspectionResult WindowsPeInspector::inspectFile(const std::filesystem::path& filePath) {
  std::error_code ec;
  if (!std::filesystem::is_regular_file(filePath, ec)) {
    PeInspectionResult res;
    res.diagnostic = "Binary file does not exist or is not a regular file";
    return res;
  }

  std::ifstream ifs(filePath, std::ios::binary);
  if (!ifs.is_open()) {
    PeInspectionResult res;
    res.diagnostic = "Unable to open binary file for PE inspection";
    return res;
  }

  // Read up to 64 KiB header window for fast PE inspection
  std::vector<uint8_t> buf(65536);
  ifs.read(reinterpret_cast<char*>(buf.data()), static_cast<std::streamsize>(buf.size()));
  buf.resize(static_cast<size_t>(ifs.gcount()));
  return inspectBytes(buf);
}

std::string WindowsPeInspector::sha256Bytes(const uint8_t* data, size_t len) {
  Sha256 hasher;
  if (data && len > 0) {
    hasher.update(data, len);
  }
  return hasher.finalHex();
}

std::string WindowsPeInspector::sha256File(const std::filesystem::path& filePath) {
  std::ifstream ifs(filePath, std::ios::binary);
  if (!ifs.is_open()) return {};

  Sha256 hasher;
  std::array<uint8_t, 65536> buf{};
  while (ifs) {
    ifs.read(reinterpret_cast<char*>(buf.data()), static_cast<std::streamsize>(buf.size()));
    std::streamsize n = ifs.gcount();
    if (n > 0) {
      hasher.update(buf.data(), static_cast<size_t>(n));
    }
  }
  return hasher.finalHex();
}

BundleFileResolution WindowsPeInspector::resolveAndInspectVst3Bundle(
    const std::filesystem::path& bundlePath,
    bool computeHash) {
  BundleFileResolution out;
  out.bundlePath = bundlePath.lexically_normal().string();

  std::error_code ec;
  if (!std::filesystem::exists(bundlePath, ec)) {
    out.exists = false;
    out.errorMessage = "Bundle path does not exist on disk";
    return out;
  }

  std::filesystem::path targetBinary;
  if (std::filesystem::is_regular_file(bundlePath, ec)) {
    // Legacy flat *.vst3 file
    out.exists = true;
    out.isBundleDirectory = false;
    targetBinary = bundlePath;
  } else if (std::filesystem::is_directory(bundlePath, ec)) {
    out.exists = true;
    out.isBundleDirectory = true;

    // Standard VST3 bundle folder specification on Windows:
    //   <Name>.vst3/Contents/x86_64-win/<Name>.vst3
    // Fallback also inspects x86-win or arm64-win to detect wrong-arch bundles clearly.
    const std::array<std::string, 3> archSubdirs = {"x86_64-win", "arm64-win", "x86-win"};
    for (const auto& sub : archSubdirs) {
      std::filesystem::path dir = bundlePath / "Contents" / sub;
      if (std::filesystem::is_directory(dir, ec)) {
        for (const auto& entry : std::filesystem::directory_iterator(dir, ec)) {
          if (entry.is_regular_file(ec) && entry.path().extension() == ".vst3") {
            targetBinary = entry.path();
            break;
          }
        }
      }
      if (!targetBinary.empty()) break;
    }

    if (targetBinary.empty()) {
      out.errorMessage = "VST3 bundle directory missing Contents/<arch>-win/*.vst3 binary";
      return out;
    }
  } else {
    out.errorMessage = "Unsupported filesystem entry type for VST3 bundle";
    return out;
  }

  out.binaryPath = targetBinary.lexically_normal().string();
  out.sizeBytes = std::filesystem::file_size(targetBinary, ec);

  auto ftime = std::filesystem::last_write_time(targetBinary, ec);
  if (!ec) {
    out.mtimeNs = std::chrono::duration_cast<std::chrono::nanoseconds>(
        ftime.time_since_epoch()).count();
  }

  out.pe = inspectFile(targetBinary);
  if (computeHash) {
    out.sha256Hex = sha256File(targetBinary);
  }
  return out;
}

} // namespace syn::host
