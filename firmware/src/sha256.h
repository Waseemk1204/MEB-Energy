#pragma once
#include <stddef.h>
#include <stdint.h>

// SHA-256 and HMAC-SHA-256, portable. The gateway could use mbedtls, but the
// same code has to run in the host tests against the app's vectors, and one
// implementation that runs everywhere is worth more than a faster one that
// runs on the device only.
namespace sha256 {

struct Context {
  uint32_t state[8];
  uint64_t bitlen;
  uint8_t buffer[64];
  size_t buffered;
};

void init(Context& c);
void update(Context& c, const uint8_t* data, size_t len);
void finish(Context& c, uint8_t out[32]);

void hash(const uint8_t* data, size_t len, uint8_t out[32]);
void hmac(const uint8_t* key, size_t keyLen, const uint8_t* msg, size_t msgLen, uint8_t out[32]);

// Constant time.
bool equal(const uint8_t* a, const uint8_t* b, size_t len);

}  // namespace sha256
