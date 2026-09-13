// Host tests for the portable half of the firmware. The fixed values here
// are the same ones mobile/src/ble/codec.test.ts asserts (its snapshot file
// is the source); if the two sides ever disagree, both suites say so.
#include <stdio.h>
#include <string.h>
#include <unity.h>

#include "../../src/auth.h"
#include "../../src/jbd.h"
#include "../../src/jbd_params.h"
#include "../../src/protocol.h"
#include "../../src/sha256.h"

static void hexOf(const uint8_t* b, size_t n, char* out) {
  static const char* d = "0123456789abcdef";
  for (size_t i = 0; i < n; ++i) {
    out[i * 2] = d[b[i] >> 4];
    out[i * 2 + 1] = d[b[i] & 15];
  }
  out[n * 2] = 0;
}

static void fromHex(const char* hex, uint8_t* out, size_t n) {
  for (size_t i = 0; i < n; ++i) {
    unsigned v;
    sscanf(hex + i * 2, "%2x", &v);
    out[i] = (uint8_t)v;
  }
}

/* ----------------------------------------------------------------- sha256 */

void test_sha256_abc(void) {
  uint8_t out[32];
  char hex[65];
  sha256::hash((const uint8_t*)"abc", 3, out);
  hexOf(out, 32, hex);
  TEST_ASSERT_EQUAL_STRING("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", hex);
}

void test_hmac_rfc4231_case2(void) {
  uint8_t out[32];
  char hex[65];
  sha256::hmac((const uint8_t*)"Jefe", 4, (const uint8_t*)"what do ya want for nothing?", 28, out);
  hexOf(out, 32, hex);
  TEST_ASSERT_EQUAL_STRING("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843", hex);
}

/* -------------------------------------------------------------- handshake */

static uint8_t KEY[32];
static void randomBB(uint8_t* out, size_t n) { memset(out, 0xbb, n); }

void test_handshake_vectors_match_the_app(void) {
  memset(KEY, 0x0f, 32);
  uint8_t nonceA[16], nonceG[16], tag[32], session[32];
  memset(nonceA, 0xaa, 16);
  memset(nonceG, 0xbb, 16);
  char hex[65];
  auth::Handshake::gatewayTag(KEY, "GW-000184", nonceA, nonceG, tag);
  hexOf(tag, 32, hex);
  TEST_ASSERT_EQUAL_STRING("a1b0fcdc1f7b35c6afb6f58544465297425278aedd3a48779822b1d2a16749f3", hex);
  auth::Handshake::sessionKey(KEY, nonceA, nonceG, session);
  hexOf(session, 32, hex);
  TEST_ASSERT_EQUAL_STRING("ac22d53ad186fe8ee4eaa8c872f07aaa603e02fa0afb5f5561622887bca88240", hex);
}

void test_handshake_completes_with_the_right_key(void) {
  memset(KEY, 0x0f, 32);
  auth::Handshake gw(KEY, "GW-000184", randomBB);
  uint8_t challenge[17] = {0x01};
  memset(challenge + 1, 0xaa, 16);
  uint8_t reply[64];
  size_t n = gw.receive(challenge, sizeof challenge, reply, sizeof reply);
  TEST_ASSERT_EQUAL(1 + 16 + 32, n);
  TEST_ASSERT_EQUAL(0x02, reply[0]);
  // The app's answer.
  uint8_t answer[33] = {0x03};
  auth::Handshake::appTag(KEY, "GW-000184", reply + 1, challenge + 1, answer + 1);
  n = gw.receive(answer, sizeof answer, reply, sizeof reply);
  TEST_ASSERT_EQUAL(2, n);
  TEST_ASSERT_EQUAL(0x04, reply[0]);
  TEST_ASSERT_EQUAL(auth::OK, reply[1]);
  TEST_ASSERT_TRUE(gw.authorised());
}

void test_handshake_refuses_the_wrong_key(void) {
  memset(KEY, 0x0f, 32);
  auth::Handshake gw(KEY, "GW-000184", randomBB);
  uint8_t challenge[17] = {0x01};
  memset(challenge + 1, 0xaa, 16);
  uint8_t reply[64];
  gw.receive(challenge, sizeof challenge, reply, sizeof reply);
  uint8_t wrongKey[32];
  memset(wrongKey, 0xee, 32);
  uint8_t answer[33] = {0x03};
  auth::Handshake::appTag(wrongKey, "GW-000184", reply + 1, challenge + 1, answer + 1);
  size_t n = gw.receive(answer, sizeof answer, reply, sizeof reply);
  TEST_ASSERT_EQUAL(2, n);
  TEST_ASSERT_EQUAL(auth::BAD_TAG, reply[1]);
  TEST_ASSERT_FALSE(gw.authorised());
}

void test_handshake_out_of_order_and_unprovisioned(void) {
  memset(KEY, 0x0f, 32);
  auth::Handshake gw(KEY, "GW-000184", randomBB);
  uint8_t answer[33] = {0x03};
  uint8_t reply[64];
  gw.receive(answer, sizeof answer, reply, sizeof reply);
  TEST_ASSERT_EQUAL(auth::OUT_OF_ORDER, reply[1]);

  auth::Handshake bare(nullptr, "GW-000184", randomBB);
  uint8_t challenge[17] = {0x01};
  bare.receive(challenge, sizeof challenge, reply, sizeof reply);
  TEST_ASSERT_EQUAL(0x04, reply[0]);
  TEST_ASSERT_EQUAL(auth::NOT_PROVISIONED, reply[1]);
}

/* --------------------------------------------------------------- commands */

void test_command_tag_vector_matches_the_app(void) {
  uint8_t session[32];
  memset(session, 0x11, 32);
  // 11 0001 05 a60e0000 + a tag we compute ourselves; check the tag's value.
  uint8_t body[8];
  fromHex("11000105a60e0000", body, 8);
  uint8_t mac[32];
  char hex[65];
  sha256::hmac(session, 32, body, 8, mac);
  hexOf(mac, 16, hex);
  TEST_ASSERT_EQUAL_STRING("8e85ea9fa1c15a048c37aafa7b6ae559", hex);

  uint8_t frame[8 + 16];
  memcpy(frame, body, 8);
  memcpy(frame + 8, mac, 16);
  proto::Command c;
  TEST_ASSERT_TRUE(proto::parseCommand(frame, sizeof frame, c));
  TEST_ASSERT_EQUAL(proto::WRITE_PARAM, c.opcode);
  TEST_ASSERT_EQUAL(256, c.seq);  // 00 01, little-endian
  TEST_ASSERT_EQUAL(5, c.payloadLen);
  TEST_ASSERT_EQUAL(0x05, c.payload[0]);
  TEST_ASSERT_EQUAL(3750, proto::get32(c.payload + 1));
  TEST_ASSERT_TRUE(proto::commandTagValid(c, session));
  frame[20] ^= 1;
  TEST_ASSERT_TRUE(proto::parseCommand(frame, sizeof frame, c));
  TEST_ASSERT_FALSE(proto::commandTagValid(c, session));
}

/* -------------------------------------------------------------- telemetry */

void test_telemetry_layout_matches_the_app(void) {
  proto::Telemetry t = {};
  t.seq = 1;
  t.uptimeMs = 2;
  t.chargeMos = true;
  t.bmsUnreachable = true;
  t.packVoltage10mV = 8000;
  t.packCurrent10mA = -100;
  t.socTenths = 500;
  t.sohTenths = 1000;
  t.cycles = 7;
  t.protection = 0x0401;
  t.balancingMask = 1;
  t.ntcCount = 1;
  t.tempsTenths[0] = -55;
  t.cellCount = 1;
  t.cellsMv[0] = 3333;
  uint8_t out[proto::TELEMETRY_MAX];
  size_t n = proto::encodeTelemetry(t, out, sizeof out);
  char hex[2 * proto::TELEMETRY_MAX + 1];
  hexOf(out, n, hex);
  TEST_ASSERT_EQUAL_STRING("0109" "01000000" "02000000" "401f" "9cffffff" "f401" "e803" "0700" "0104" "01000000" "01" "c9ff" "01" "050d", hex);
}

void test_fragmentation(void) {
  uint8_t frame[82];
  for (int i = 0; i < 82; ++i) frame[i] = (uint8_t)i;
  static uint8_t seen[8][256];
  static size_t seenLen[8];
  static size_t count;
  count = 0;
  auto send = [](const uint8_t* p, size_t n) {
    memcpy(seen[count], p, n);
    seenLen[count] = n;
    count++;
  };
  size_t parts = proto::fragment(frame, 82, 23, send);
  TEST_ASSERT_EQUAL(5, parts);
  TEST_ASSERT_EQUAL(0x00, seen[0][0]);
  TEST_ASSERT_EQUAL(0x84, seen[4][0]);
  TEST_ASSERT_EQUAL(20, seenLen[0]);
  count = 0;
  parts = proto::fragment(frame, 82, 247, send);
  TEST_ASSERT_EQUAL(1, parts);
  TEST_ASSERT_EQUAL(0x80, seen[0][0]);
  TEST_ASSERT_EQUAL(83, seenLen[0]);
}

void test_identity_tlv(void) {
  proto::Identity id = {"GW-000184", "HW 1.0", "FW 1.0.0", "", "", 0, true};
  uint8_t out[200];
  size_t n = proto::encodeIdentity(id, out, sizeof out);
  // 01 01 01 | 02 09 "GW-000184" | 03 06 "HW 1.0" | 04 08 "FW 1.0.0" | 08 01 01
  TEST_ASSERT_EQUAL(3 + 11 + 8 + 10 + 3, n);
  TEST_ASSERT_EQUAL(0x01, out[0]);
  TEST_ASSERT_EQUAL(0x02, out[3]);
  TEST_ASSERT_EQUAL(9, out[4]);
  TEST_ASSERT_EQUAL_MEMORY("GW-000184", out + 5, 9);
  TEST_ASSERT_EQUAL(0x08, out[n - 3]);
  TEST_ASSERT_EQUAL(1, out[n - 1]);
}

/* -------------------------------------------------------------------- jbd */

void test_jbd_read_request_bytes(void) {
  uint8_t out[7];
  jbd::buildRead(jbd::CMD_BASIC, out);
  const uint8_t expect[7] = {0xDD, 0xA5, 0x03, 0x00, 0xFF, 0xFD, 0x77};
  TEST_ASSERT_EQUAL_MEMORY(expect, out, 7);
  jbd::buildRead(jbd::CMD_CELLS, out);
  const uint8_t expect4[7] = {0xDD, 0xA5, 0x04, 0x00, 0xFF, 0xFC, 0x77};
  TEST_ASSERT_EQUAL_MEMORY(expect4, out, 7);
}

void test_jbd_factory_mode_write_bytes(void) {
  uint8_t out[9];
  jbd::buildWrite(jbd::REG_FACTORY, jbd::FACTORY_ENTER, out);
  const uint8_t expect[9] = {0xDD, 0x5A, 0x00, 0x02, 0x56, 0x78, 0xFF, 0x30, 0x77};
  TEST_ASSERT_EQUAL_MEMORY(expect, out, 9);
}

void test_jbd_parses_a_basic_info_frame(void) {
  // A 24S basic-info response: 80.00 V, -12.34 A, 2 NTCs at 24.5 and 26.0 °C.
  uint8_t data[27] = {
      0x1F, 0x40,  // 8000 × 10 mV
      0xFB, 0x2E,  // -1234 × 10 mA
      0x1F, 0x40,  // remaining
      0x27, 0x10,  // nominal 10000 × 10 mAh
      0x00, 0x78,  // cycles 120
      0x00, 0x00,  // date
      0x00, 0x05,  // balance cells 1 and 3
      0x00, 0x00,
      0x00, 0x11,  // protection bits 0 and 4
      0x12,        // sw version
      0x48,        // soc 72
      0x03,        // both FETs on
      0x18,        // 24 cells
      0x02,        // 2 NTC
      0x0B, 0x93,  // 2963 → 24.5 °C... (2963-2731 = 232 → 23.2; adjust below)
      0x0B, 0xA2,  // 2978
  };
  uint8_t frame[4 + 27 + 3];
  frame[0] = 0xDD;
  frame[1] = 0x03;
  frame[2] = 0x00;
  frame[3] = 27;
  memcpy(frame + 4, data, 27);
  uint32_t sum = 0;
  for (size_t i = 2; i < 4 + 27; ++i) sum += frame[i];
  uint16_t chk = (uint16_t)(0x10000 - sum);
  frame[31] = chk >> 8;
  frame[32] = chk & 0xff;
  frame[33] = 0x77;

  jbd::Frame f;
  TEST_ASSERT_TRUE(jbd::parse(frame, sizeof frame, f));
  jbd::Basic b;
  TEST_ASSERT_TRUE(jbd::parseBasic(f, b));
  TEST_ASSERT_EQUAL(8000, b.packVoltage10mV);
  TEST_ASSERT_EQUAL(-1234, b.current10mA);
  TEST_ASSERT_EQUAL(120, b.cycles);
  TEST_ASSERT_EQUAL(0x00000005, b.balanceMask);
  TEST_ASSERT_EQUAL(0x0011, b.protection);
  TEST_ASSERT_EQUAL(72, b.soc);
  TEST_ASSERT_EQUAL(0x03, b.fetBits);
  TEST_ASSERT_EQUAL(24, b.cellCount);
  TEST_ASSERT_EQUAL(2, b.ntcCount);
  TEST_ASSERT_EQUAL(232, b.tempsTenthsC[0]);
  TEST_ASSERT_EQUAL(247, b.tempsTenthsC[1]);

  frame[10] ^= 0x01;  // corrupt a byte: the checksum must catch it
  TEST_ASSERT_FALSE(jbd::parse(frame, sizeof frame, f));
}

void test_param_units(void) {
  const params::Spec* ovp = params::find(0x01);
  TEST_ASSERT_NOT_NULL(ovp);
  TEST_ASSERT_EQUAL(0x24, ovp->reg);
  uint16_t reg;
  TEST_ASSERT_TRUE(params::fromWire(*ovp, 3750, reg));
  TEST_ASSERT_EQUAL(3750, reg);
  TEST_ASSERT_EQUAL(3750, params::toWire(*ovp, reg));

  const params::Spec* htp = params::find(0x20);
  TEST_ASSERT_TRUE(params::fromWire(*htp, 450, reg));  // 45.0 °C
  TEST_ASSERT_EQUAL(3181, reg);                          // 0.1 K
  TEST_ASSERT_EQUAL(450, params::toWire(*htp, 3181));

  const params::Spec* cap = params::find(0x41);
  TEST_ASSERT_TRUE(params::fromWire(*cap, 100000, reg));  // 100 Ah in mAh
  TEST_ASSERT_EQUAL(10000, reg);                           // 10 mAh units
  TEST_ASSERT_EQUAL(100000, params::toWire(*cap, 10000));

  TEST_ASSERT_FALSE(params::fromWire(*ovp, -1, reg));
  TEST_ASSERT_FALSE(params::fromWire(*ovp, 70000, reg));
  TEST_ASSERT_NULL(params::find(0x7f));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_sha256_abc);
  RUN_TEST(test_hmac_rfc4231_case2);
  RUN_TEST(test_handshake_vectors_match_the_app);
  RUN_TEST(test_handshake_completes_with_the_right_key);
  RUN_TEST(test_handshake_refuses_the_wrong_key);
  RUN_TEST(test_handshake_out_of_order_and_unprovisioned);
  RUN_TEST(test_command_tag_vector_matches_the_app);
  RUN_TEST(test_telemetry_layout_matches_the_app);
  RUN_TEST(test_fragmentation);
  RUN_TEST(test_identity_tlv);
  RUN_TEST(test_jbd_read_request_bytes);
  RUN_TEST(test_jbd_factory_mode_write_bytes);
  RUN_TEST(test_jbd_parses_a_basic_info_frame);
  RUN_TEST(test_param_units);
  return UNITY_END();
}
