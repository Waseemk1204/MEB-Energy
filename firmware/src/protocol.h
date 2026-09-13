#pragma once
#include <stddef.h>
#include <stdint.h>

// The wire format, docs/BLE_CONTRACT.md. Nothing here knows about a radio;
// it turns structs into bytes and back, and the host tests hold it to the
// same vectors the app's tests do.
namespace proto {

constexpr uint8_t VERSION = 1;

// §3
constexpr const char* SERVICE_UUID = "7a3f0001-3b7e-4d5b-9c1a-2f4e6d8a0b10";
constexpr const char* CHAR_IDENTITY = "7a3f0002-3b7e-4d5b-9c1a-2f4e6d8a0b10";
constexpr const char* CHAR_AUTH = "7a3f0003-3b7e-4d5b-9c1a-2f4e6d8a0b10";
constexpr const char* CHAR_TELEMETRY = "7a3f0004-3b7e-4d5b-9c1a-2f4e6d8a0b10";
constexpr const char* CHAR_COMMAND = "7a3f0005-3b7e-4d5b-9c1a-2f4e6d8a0b10";
constexpr const char* CHAR_RESPONSE = "7a3f0006-3b7e-4d5b-9c1a-2f4e6d8a0b10";
constexpr const char* CHAR_PROVISIONING = "7a3f0007-3b7e-4d5b-9c1a-2f4e6d8a0b10";

constexpr size_t MAX_CELLS = 32;
constexpr size_t MAX_NTC = 8;

// §4 — everything Identity can say. Empty strings are omitted from the TLV.
struct Identity {
  const char* serial;
  const char* hardwareRevision;
  const char* firmwareVersion;
  const char* bmsModel;     // "" if none detected
  const char* bmsFirmware;  // "" if none detected
  uint8_t cellCount;        // 0 if unknown
  bool provisioned;
};

// Returns bytes written; `out` needs up to 2 + (2 + 24) * 6 + 3 + 3 ≈ 170.
size_t encodeIdentity(const Identity& id, uint8_t* out, size_t cap);

// §6
struct Telemetry {
  uint32_t seq;
  uint32_t uptimeMs;
  bool chargeMos, dischargeMos, balancing, bmsUnreachable;
  uint16_t packVoltage10mV;
  int32_t packCurrent10mA;
  uint16_t socTenths;
  uint16_t sohTenths;
  uint16_t cycles;
  uint16_t protection;
  uint32_t balancingMask;
  uint8_t ntcCount;
  int16_t tempsTenths[MAX_NTC];
  uint8_t cellCount;
  uint16_t cellsMv[MAX_CELLS];
};

constexpr size_t TELEMETRY_MAX = 30 + MAX_NTC * 2 + MAX_CELLS * 2;
size_t encodeTelemetry(const Telemetry& t, uint8_t* out, size_t cap);

// §7
enum Opcode : uint8_t { READ_PARAM = 0x10, WRITE_PARAM = 0x11, READ_ALL_PARAMS = 0x12 };

enum Status : uint8_t {
  OK = 0x00,
  UNKNOWN_PARAM = 0x01,
  READ_ONLY = 0x02,
  OUT_OF_RANGE = 0x03,
  BMS_TIMEOUT = 0x04,
  NOT_AUTHENTICATED = 0x05,
  BAD_TAG = 0x06,
  BUSY = 0x07,
  ADJUSTED = 0x08,
};

struct Command {
  uint8_t opcode;
  uint16_t seq;
  const uint8_t* payload;
  size_t payloadLen;
  const uint8_t* tag;  // 16 bytes
};

// Splits a Command frame. False if too short to be one.
bool parseCommand(const uint8_t* in, size_t len, Command& out);

// Verifies §7.1's tag with the session key. Constant time.
bool commandTagValid(const Command& c, const uint8_t session[32]);

// Builds a Response frame; returns bytes written.
size_t encodeResponse(uint8_t opcode, uint16_t seq, uint8_t status, const uint8_t* payload, size_t payloadLen,
                      uint8_t* out, size_t cap);

// §7.3 — chunk `frame` for an MTU. Calls `send` per fragment; returns count.
template <typename Send>
size_t fragment(const uint8_t* frame, size_t len, size_t mtu, Send send) {
  size_t chunk = mtu > 4 ? mtu - 3 - 1 : 1;
  size_t count = len == 0 ? 1 : (len + chunk - 1) / chunk;
  uint8_t piece[256];
  for (size_t i = 0; i < count; ++i) {
    size_t at = i * chunk;
    size_t n = (len - at) < chunk ? (len - at) : chunk;
    if (n + 1 > sizeof piece) n = sizeof piece - 1;
    piece[0] = (uint8_t)((i == count - 1 ? 0x80 : 0x00) | (i & 0x7f));
    for (size_t j = 0; j < n; ++j) piece[1 + j] = frame[at + j];
    send(piece, n + 1);
  }
  return count;
}

// Little-endian helpers.
inline void put16(uint8_t* p, uint16_t v) { p[0] = v & 0xff; p[1] = v >> 8; }
inline void put32(uint8_t* p, uint32_t v) { p[0] = v & 0xff; p[1] = (v >> 8) & 0xff; p[2] = (v >> 16) & 0xff; p[3] = v >> 24; }
inline uint16_t get16(const uint8_t* p) { return (uint16_t)(p[0] | (p[1] << 8)); }
inline int32_t get32(const uint8_t* p) { return (int32_t)((uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24)); }

}  // namespace proto
