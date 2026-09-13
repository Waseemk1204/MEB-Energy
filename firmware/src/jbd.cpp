#include "jbd.h"

namespace jbd {

// Checksum: 0x10000 minus the sum of the bytes between START+direction and
// the checksum itself — for a request that is cmd, length and data; for a
// response, status, length and data.
static uint16_t checksum(const uint8_t* p, size_t n) {
  uint32_t sum = 0;
  for (size_t i = 0; i < n; ++i) sum += p[i];
  return (uint16_t)(0x10000 - sum);
}

size_t buildRead(uint8_t cmd, uint8_t out[7]) {
  out[0] = START;
  out[1] = READ;
  out[2] = cmd;
  out[3] = 0x00;
  uint16_t c = checksum(out + 2, 2);
  out[4] = c >> 8;
  out[5] = c & 0xff;
  out[6] = END;
  return 7;
}

size_t buildWrite(uint8_t reg, uint16_t value, uint8_t out[9]) {
  out[0] = START;
  out[1] = WRITE;
  out[2] = reg;
  out[3] = 0x02;
  out[4] = value >> 8;
  out[5] = value & 0xff;
  uint16_t c = checksum(out + 2, 4);
  out[6] = c >> 8;
  out[7] = c & 0xff;
  out[8] = END;
  return 9;
}

bool parse(const uint8_t* in, size_t len, Frame& out) {
  if (len < 7 || in[0] != START || in[len - 1] != END) return false;
  uint8_t dataLen = in[3];
  if (len != (size_t)dataLen + 7) return false;
  uint16_t expected = checksum(in + 2, 2 + dataLen);
  uint16_t got = (uint16_t)((in[len - 3] << 8) | in[len - 2]);
  if (expected != got) return false;
  out.cmd = in[1];
  out.status = in[2];
  out.data = in + 4;
  out.len = dataLen;
  return true;
}

static uint16_t be16(const uint8_t* p) { return (uint16_t)((p[0] << 8) | p[1]); }

bool parseBasic(const Frame& f, Basic& out) {
  if (f.cmd != CMD_BASIC || f.status != 0x00 || f.len < 23) return false;
  const uint8_t* d = f.data;
  out.packVoltage10mV = be16(d);
  out.current10mA = (int16_t)be16(d + 2);
  out.remaining10mAh = be16(d + 4);
  out.nominal10mAh = be16(d + 6);
  out.cycles = be16(d + 8);
  // d+10..11: production date, unused.
  out.balanceMask = (uint32_t)be16(d + 12) | ((uint32_t)be16(d + 14) << 16);
  out.protection = be16(d + 16);
  out.softwareVersion = d[18];
  out.soc = d[19];
  out.fetBits = d[20];
  out.cellCount = d[21];
  out.ntcCount = d[22];
  if (out.ntcCount > 8) out.ntcCount = 8;
  if (f.len < 23 + (size_t)out.ntcCount * 2) return false;
  for (uint8_t i = 0; i < out.ntcCount; ++i) out.tempsTenthsC[i] = kelvinTenthsToC(be16(d + 23 + i * 2));
  return true;
}

size_t parseCells(const Frame& f, uint16_t* mv, size_t cap) {
  if (f.cmd != CMD_CELLS || f.status != 0x00) return 0;
  size_t n = f.len / 2;
  if (n > cap) n = cap;
  for (size_t i = 0; i < n; ++i) mv[i] = be16(f.data + i * 2);
  return n;
}

}  // namespace jbd
