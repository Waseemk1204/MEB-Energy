#pragma once
#include <stdint.h>

// docs/BLE_CONTRACT.md §7.4: the parameter byte the app sends, the JBD
// register behind it, and how the two units relate.
//
// `verified` is the honest bit. The unmarked registers are JBD's documented
// EEPROM map, the same one every open JBD tool uses. The ones marked false
// are packed or board-specific and are answered UNKNOWN_PARAM until somebody
// with the SP24S004 register sheet confirms the register and the encoding —
// writing to the wrong register on a battery is not a thing to guess at.
namespace params {

enum Unit : uint8_t {
  SAME,        // wire value == register value
  X10,         // wire = register × 10   (JBD in 10 mA / 10 mAh, wire in mA / mAh)
  KELVIN,      // wire 0.1 °C, register 0.1 K
  FIXED,       // not a register: the gateway answers a constant
};

struct Spec {
  uint8_t id;
  uint8_t reg;
  Unit unit;
  bool writable;
  bool verified;
  int32_t fixedValue;  // for FIXED
};

// Cell-count and the balance current are properties of the SKU. The
// SP24S004 200 A SKU balances at 60 mA; adjust for another SKU.
constexpr int32_t BALANCE_CURRENT_MA = 60;

constexpr Spec TABLE[] = {
    {0x01, 0x24, SAME, true, true, 0},     // cell_ovp (mV)
    {0x02, 0x25, SAME, true, true, 0},     // cell_ovp_release
    {0x03, 0x26, SAME, true, true, 0},     // cell_uvp
    {0x04, 0x27, SAME, true, true, 0},     // cell_uvp_release
    {0x05, 0x3D, SAME, true, false, 0},    // cell_ovp_delay ⚠ packed
    {0x06, 0x3D, SAME, true, false, 0},    // cell_uvp_delay ⚠ packed
    {0x10, 0x28, X10, false, true, 0},     // charge_ocp (read-only for the app; JBD 10 mA)
    {0x11, 0x3A, SAME, true, false, 0},    // charge_ocp_delay ⚠
    {0x12, 0x29, X10, false, true, 0},     // discharge_ocp_1
    {0x13, 0x3A, SAME, true, false, 0},    // discharge_ocp_1_delay ⚠
    {0x14, 0x39, SAME, false, false, 0},   // discharge_ocp_2 ⚠
    {0x15, 0x39, SAME, true, false, 0},    // discharge_ocp_2_delay ⚠
    {0x16, 0x39, SAME, false, false, 0},   // short_circuit ⚠
    {0x17, 0x39, SAME, true, false, 0},    // short_circuit_delay ⚠
    {0x20, 0x18, KELVIN, true, true, 0},   // charge_htp
    {0x21, 0x1C, KELVIN, true, true, 0},   // charge_htp_release
    {0x22, 0x19, KELVIN, true, true, 0},   // charge_ltp
    {0x23, 0x1D, KELVIN, true, true, 0},   // charge_ltp_release
    {0x24, 0x1A, KELVIN, true, true, 0},   // discharge_htp
    {0x25, 0x1E, KELVIN, true, true, 0},   // discharge_htp_release
    {0x26, 0x1B, KELVIN, true, true, 0},   // discharge_ltp
    {0x27, 0x1F, KELVIN, true, true, 0},   // discharge_ltp_release
    {0x28, 0x00, KELVIN, true, false, 0},  // fet_htp ⚠ board-specific
    {0x29, 0x00, KELVIN, true, false, 0},  // fet_htp_release ⚠
    {0x30, 0x2A, SAME, true, true, 0},     // balance_start_v (mV)
    {0x31, 0x2B, SAME, true, true, 0},     // balance_delta_mv
    {0x32, 0x00, FIXED, false, true, BALANCE_CURRENT_MA},  // balance_current_ma
    {0x40, 0x2F, SAME, false, true, 0},    // cell_count
    {0x41, 0x10, X10, true, true, 0},      // capacity_ah (wire mAh, JBD 10 mAh)
};

constexpr size_t COUNT = sizeof(TABLE) / sizeof(TABLE[0]);

inline const Spec* find(uint8_t id) {
  for (size_t i = 0; i < COUNT; ++i)
    if (TABLE[i].id == id) return &TABLE[i];
  return nullptr;
}

// Register value → wire value.
inline int32_t toWire(const Spec& s, uint16_t reg) {
  switch (s.unit) {
    case X10: return (int32_t)reg * 10;
    case KELVIN: return (int32_t)reg - 2731;
    case FIXED: return s.fixedValue;
    default: return (int32_t)reg;
  }
}

// Wire value → register value. False if it does not fit the register.
inline bool fromWire(const Spec& s, int32_t wire, uint16_t& reg) {
  int32_t v;
  switch (s.unit) {
    case X10: v = wire / 10; break;
    case KELVIN: v = wire + 2731; break;
    case FIXED: return false;
    default: v = wire; break;
  }
  if (v < 0 || v > 0xffff) return false;
  reg = (uint16_t)v;
  return true;
}

}  // namespace params
