#pragma once
#include <stddef.h>
#include <stdint.h>

// The gateway's side of docs/BLE_CONTRACT.md §5, as a state machine over
// bytes. The radio glue writes what `receive` returns to the Auth
// characteristic; nothing here knows there is a radio.
namespace auth {

constexpr size_t NONCE_LEN = 16;
constexpr size_t KEY_LEN = 32;

enum Reply : uint8_t { OK = 0x00, BAD_TAG = 0x01, OUT_OF_ORDER = 0x02, NOT_PROVISIONED = 0x03 };

typedef void (*Random)(uint8_t* out, size_t n);

class Handshake {
 public:
  // `key` is null for an unprovisioned gateway. `serial` must outlive this.
  Handshake(const uint8_t* key, const char* serial, Random random);

  // Handle one write to Auth. Returns the number of bytes to notify back.
  size_t receive(const uint8_t* in, size_t len, uint8_t* out, size_t cap);

  bool authorised() const { return authorised_; }
  const uint8_t* session() const { return session_; }
  void reset();

  // Pure functions, exposed for the host tests and the app's vectors.
  static void gatewayTag(const uint8_t key[KEY_LEN], const char* serial, const uint8_t nonceA[NONCE_LEN],
                         const uint8_t nonceG[NONCE_LEN], uint8_t out[32]);
  static void appTag(const uint8_t key[KEY_LEN], const char* serial, const uint8_t nonceG[NONCE_LEN],
                     const uint8_t nonceA[NONCE_LEN], uint8_t out[32]);
  static void sessionKey(const uint8_t key[KEY_LEN], const uint8_t nonceA[NONCE_LEN], const uint8_t nonceG[NONCE_LEN],
                         uint8_t out[32]);

 private:
  const uint8_t* key_;
  const char* serial_;
  Random random_;
  uint8_t nonceA_[NONCE_LEN];
  uint8_t nonceG_[NONCE_LEN];
  bool challenged_ = false;
  bool authorised_ = false;
  uint8_t session_[32];
};

}  // namespace auth
