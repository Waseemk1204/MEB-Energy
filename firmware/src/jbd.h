#pragma once
#include <stddef.h>
#include <stdint.h>

// Jiabaida (JBD) BMS UART protocol: the "Xiaoxiang" protocol every JBD
// board speaks at 9600 8N1. Request and response framing, the basic-info and
// cell-voltage layouts, and register writes through factory mode.
//
// Codec only. The bytes go over a UART the caller owns, so everything here
// runs on the host as well and is tested against captured frames.
namespace jbd {

constexpr uint8_t START = 0xDD;
constexpr uint8_t END = 0x77;
constexpr uint8_t READ = 0xA5;
constexpr uint8_t WRITE = 0x5A;

// Read commands.
constexpr uint8_t CMD_BASIC = 0x03;
constexpr uint8_t CMD_CELLS = 0x04;
constexpr uint8_t CMD_HARDWARE = 0x05;

// Registers written to enter and leave factory (parameter) mode.
constexpr uint8_t REG_FACTORY = 0x00;
constexpr uint16_t FACTORY_ENTER = 0x5678;
constexpr uint8_t REG_EXIT = 0x01;
constexpr uint16_t EXIT_SAVE = 0x2828;

// Builds `DD A5 cmd 00 chk chk 77`. Returns 7.
size_t buildRead(uint8_t cmd, uint8_t out[7]);
// Builds `DD 5A reg 02 hi lo chk chk 77`. Returns 9.
size_t buildWrite(uint8_t reg, uint16_t value, uint8_t out[9]);

// A response, parsed. `data` points into the caller's buffer.
struct Frame {
  uint8_t cmd;
  uint8_t status;  // 0x00 ok, 0x80 error
  const uint8_t* data;
  size_t len;
};

// Parses a complete response frame; verifies checksum and framing.
bool parse(const uint8_t* in, size_t len, Frame& out);

struct Basic {
  uint16_t packVoltage10mV;
  int16_t current10mA;
  uint16_t remaining10mAh;
  uint16_t nominal10mAh;
  uint16_t cycles;
  uint32_t balanceMask;   // cells 1..32
  uint16_t protection;
  uint8_t softwareVersion;
  uint8_t soc;            // %
  uint8_t fetBits;        // bit0 charge, bit1 discharge
  uint8_t cellCount;
  uint8_t ntcCount;
  int16_t tempsTenthsC[8];
};

bool parseBasic(const Frame& f, Basic& out);

// Fills `mv` (up to `cap` entries), returns the cell count.
size_t parseCells(const Frame& f, uint16_t* mv, size_t cap);

// JBD temperatures are 0.1 K; the wire wants 0.1 °C.
inline int16_t kelvinTenthsToC(uint16_t k) { return (int16_t)((int32_t)k - 2731); }
inline uint16_t cTenthsToKelvin(int16_t c) { return (uint16_t)((int32_t)c + 2731); }

}  // namespace jbd
