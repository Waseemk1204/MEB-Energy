#include "auth.h"

#include <string.h>

#include "sha256.h"

namespace auth {

static void tag(const uint8_t key[KEY_LEN], const char* label, const char* serial, const uint8_t* n1,
                const uint8_t* n2, uint8_t out[32]) {
  // label ‖ serial ‖ n1 ‖ n2, in one buffer. Serial is bounded by the
  // provisioning limit, so a fixed buffer is enough.
  uint8_t msg[16 + 64 + NONCE_LEN * 2];
  size_t at = 0;
  size_t ll = strlen(label);
  memcpy(msg + at, label, ll);
  at += ll;
  size_t sl = serial ? strlen(serial) : 0;
  if (sl > 64) sl = 64;
  memcpy(msg + at, serial, sl);
  at += sl;
  memcpy(msg + at, n1, NONCE_LEN);
  at += NONCE_LEN;
  memcpy(msg + at, n2, NONCE_LEN);
  at += NONCE_LEN;
  sha256::hmac(key, KEY_LEN, msg, at, out);
}

void Handshake::gatewayTag(const uint8_t key[KEY_LEN], const char* serial, const uint8_t nonceA[NONCE_LEN],
                           const uint8_t nonceG[NONCE_LEN], uint8_t out[32]) {
  tag(key, "MEB-GW-1", serial, nonceA, nonceG, out);
}

void Handshake::appTag(const uint8_t key[KEY_LEN], const char* serial, const uint8_t nonceG[NONCE_LEN],
                       const uint8_t nonceA[NONCE_LEN], uint8_t out[32]) {
  tag(key, "MEB-APP-1", serial, nonceG, nonceA, out);
}

void Handshake::sessionKey(const uint8_t key[KEY_LEN], const uint8_t nonceA[NONCE_LEN],
                           const uint8_t nonceG[NONCE_LEN], uint8_t out[32]) {
  uint8_t msg[16 + NONCE_LEN * 2];
  const char* label = "MEB-SESS-1";
  size_t ll = strlen(label);
  memcpy(msg, label, ll);
  memcpy(msg + ll, nonceA, NONCE_LEN);
  memcpy(msg + ll + NONCE_LEN, nonceG, NONCE_LEN);
  sha256::hmac(key, KEY_LEN, msg, ll + NONCE_LEN * 2, out);
}

Handshake::Handshake(const uint8_t* key, const char* serial, Random random)
    : key_(key), serial_(serial), random_(random) {
  reset();
}

void Handshake::reset() {
  challenged_ = false;
  authorised_ = false;
  memset(session_, 0, sizeof session_);
}

size_t Handshake::receive(const uint8_t* in, size_t len, uint8_t* out, size_t cap) {
  if (cap < 2) return 0;
  if (!key_) {
    out[0] = 0x04;
    out[1] = NOT_PROVISIONED;
    return 2;
  }
  if (len >= 1 && in[0] == 0x01) {
    if (len != 1 + NONCE_LEN || cap < 1 + NONCE_LEN + 32) {
      out[0] = 0x04;
      out[1] = OUT_OF_ORDER;
      return 2;
    }
    // A fresh challenge replaces any earlier state on this connection.
    authorised_ = false;
    memcpy(nonceA_, in + 1, NONCE_LEN);
    random_(nonceG_, NONCE_LEN);
    challenged_ = true;
    out[0] = 0x02;
    memcpy(out + 1, nonceG_, NONCE_LEN);
    gatewayTag(key_, serial_, nonceA_, nonceG_, out + 1 + NONCE_LEN);
    return 1 + NONCE_LEN + 32;
  }
  if (len >= 1 && in[0] == 0x03) {
    if (!challenged_) {
      out[0] = 0x04;
      out[1] = OUT_OF_ORDER;
      return 2;
    }
    uint8_t expected[32];
    appTag(key_, serial_, nonceG_, nonceA_, expected);
    if (len != 33 || !sha256::equal(in + 1, expected, 32)) {
      challenged_ = false;
      out[0] = 0x04;
      out[1] = BAD_TAG;
      return 2;
    }
    sessionKey(key_, nonceA_, nonceG_, session_);
    authorised_ = true;
    challenged_ = false;
    out[0] = 0x04;
    out[1] = OK;
    return 2;
  }
  out[0] = 0x04;
  out[1] = OUT_OF_ORDER;
  return 2;
}

}  // namespace auth
