#include "protocol.h"

#include <string.h>

#include "sha256.h"

namespace proto {

static size_t tlvStr(uint8_t tag, const char* s, uint8_t* out, size_t cap, size_t at) {
  if (!s || !*s) return at;
  size_t n = strlen(s);
  if (n > 255) n = 255;
  if (at + 2 + n > cap) return at;
  out[at] = tag;
  out[at + 1] = (uint8_t)n;
  memcpy(out + at + 2, s, n);
  return at + 2 + n;
}

static size_t tlvU8(uint8_t tag, uint8_t v, uint8_t* out, size_t cap, size_t at) {
  if (at + 3 > cap) return at;
  out[at] = tag;
  out[at + 1] = 1;
  out[at + 2] = v;
  return at + 3;
}

size_t encodeIdentity(const Identity& id, uint8_t* out, size_t cap) {
  size_t at = 0;
  at = tlvU8(0x01, VERSION, out, cap, at);
  at = tlvStr(0x02, id.serial, out, cap, at);
  at = tlvStr(0x03, id.hardwareRevision, out, cap, at);
  at = tlvStr(0x04, id.firmwareVersion, out, cap, at);
  at = tlvStr(0x05, id.bmsModel, out, cap, at);
  at = tlvStr(0x06, id.bmsFirmware, out, cap, at);
  if (id.cellCount) at = tlvU8(0x07, id.cellCount, out, cap, at);
  at = tlvU8(0x08, id.provisioned ? 1 : 0, out, cap, at);
  return at;
}

size_t encodeTelemetry(const Telemetry& t, uint8_t* out, size_t cap) {
  uint8_t ntc = t.ntcCount > MAX_NTC ? MAX_NTC : t.ntcCount;
  uint8_t cells = t.cellCount > MAX_CELLS ? MAX_CELLS : t.cellCount;
  size_t need = 30 + ntc * 2 + cells * 2;
  if (need > cap) return 0;
  out[0] = VERSION;
  out[1] = (uint8_t)((t.chargeMos ? 1 : 0) | (t.dischargeMos ? 2 : 0) | (t.balancing ? 4 : 0) |
                     (t.bmsUnreachable ? 8 : 0));
  put32(out + 2, t.seq);
  put32(out + 6, t.uptimeMs);
  put16(out + 10, t.packVoltage10mV);
  put32(out + 12, (uint32_t)t.packCurrent10mA);
  put16(out + 16, t.socTenths);
  put16(out + 18, t.sohTenths);
  put16(out + 20, t.cycles);
  put16(out + 22, t.protection);
  put32(out + 24, t.balancingMask);
  out[28] = ntc;
  size_t at = 29;
  for (uint8_t i = 0; i < ntc; ++i, at += 2) put16(out + at, (uint16_t)t.tempsTenths[i]);
  out[at++] = cells;
  for (uint8_t i = 0; i < cells; ++i, at += 2) put16(out + at, t.cellsMv[i]);
  return at;
}

bool parseCommand(const uint8_t* in, size_t len, Command& out) {
  if (len < 3 + 16) return false;
  out.opcode = in[0];
  out.seq = get16(in + 1);
  out.payload = in + 3;
  out.payloadLen = len - 3 - 16;
  out.tag = in + len - 16;
  return true;
}

bool commandTagValid(const Command& c, const uint8_t session[32]) {
  uint8_t body[3 + 64];
  if (c.payloadLen > 64) return false;
  body[0] = c.opcode;
  put16(body + 1, c.seq);
  memcpy(body + 3, c.payload, c.payloadLen);
  uint8_t mac[32];
  sha256::hmac(session, 32, body, 3 + c.payloadLen, mac);
  return sha256::equal(mac, c.tag, 16);
}

size_t encodeResponse(uint8_t opcode, uint16_t seq, uint8_t status, const uint8_t* payload, size_t payloadLen,
                      uint8_t* out, size_t cap) {
  if (4 + payloadLen > cap) return 0;
  out[0] = (uint8_t)(opcode | 0x80);
  put16(out + 1, seq);
  out[3] = status;
  if (payloadLen) memcpy(out + 4, payload, payloadLen);
  return 4 + payloadLen;
}

}  // namespace proto
