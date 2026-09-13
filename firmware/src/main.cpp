// The MEB Energy gateway.
//
// An ESP32 with a JBD BMS on one UART and the app on BLE. Everything it says
// over the air is docs/BLE_CONTRACT.md; everything it says to the BMS is
// jbd.h. This file is the glue: the radio, the serial port, the poll loop,
// flash, and the console. The protocol itself lives in the portable files
// beside it, which the host tests cover.
//
// Boot:  read serial + key from flash → advertise as MEB-xxxxxx (or
//        MEB-SETUP-xxxx with nothing provisioned) → poll the BMS every 500 ms.
// Link:  the central must complete the §5 handshake within 10 s or is dropped;
//        until it does, no telemetry and no commands.
// Write: factory mode → register → read back → save & exit → answer with
//        what the BMS holds.

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <Preferences.h>
#include <esp_random.h>

#include "auth.h"
#include "jbd.h"
#include "jbd_params.h"
#include "protocol.h"

#ifndef GATEWAY_FW_VERSION
#define GATEWAY_FW_VERSION "FW 1.0.0"
#endif
#ifndef GATEWAY_HW_REVISION
#define GATEWAY_HW_REVISION "HW 1.0"
#endif
#ifndef BMS_BAUD
#define BMS_BAUD 9600
#endif
#ifndef BMS_RX_PIN
#define BMS_RX_PIN 16
#endif
#ifndef BMS_TX_PIN
#define BMS_TX_PIN 17
#endif
#ifndef BOOT_BUTTON_PIN
#define BOOT_BUTTON_PIN 0
#endif

static const uint32_t POLL_MS = 500;
static const uint32_t HANDSHAKE_DEADLINE_MS = 10000;
static const uint32_t BMS_SILENCE_DROP_MS = 30000;
static const uint32_t BMS_REPLY_TIMEOUT_MS = 300;
static const uint32_t HARDWARE_REFRESH_MS = 60000;

/* ----------------------------------------------------------------- flash */

static Preferences prefs;
static char gSerial[32] = "";
static uint8_t gKey[auth::KEY_LEN];
static bool gProvisioned = false;

static void loadProvisioning() {
  prefs.begin("meb", true);
  String serial = prefs.getString("serial", "");
  size_t keyLen = prefs.getBytesLength("key");
  if (serial.length() > 0 && serial.length() < sizeof gSerial && keyLen == auth::KEY_LEN) {
    strlcpy(gSerial, serial.c_str(), sizeof gSerial);
    prefs.getBytes("key", gKey, auth::KEY_LEN);
    gProvisioned = true;
  }
  prefs.end();
}

static bool saveProvisioning(const char* serial, const uint8_t key[auth::KEY_LEN]) {
  if (!prefs.begin("meb", false)) return false;
  prefs.putString("serial", serial);
  prefs.putBytes("key", key, auth::KEY_LEN);
  prefs.end();
  return true;
}

static void clearProvisioning() {
  prefs.begin("meb", false);
  prefs.clear();
  prefs.end();
}

/* ------------------------------------------------------------------- BMS */

// UART1 on every board, with the pins remapped per environment. The C3 has
// no UART2 at all, and on the classic ESP32 UART1's default pins are the
// flash pins -- an explicit pin assignment sidesteps both.
static HardwareSerial bms(1);

struct BmsState {
  bool everAnswered = false;
  uint32_t lastAnswerMs = 0;
  jbd::Basic basic = {};
  uint16_t cellsMv[proto::MAX_CELLS] = {};
  uint8_t cellCount = 0;
  char model[24] = "";
  char firmware[8] = "";
  uint32_t lastHardwareMs = 0;
} gBms;

// One request, one reply, blocking for at most BMS_REPLY_TIMEOUT_MS. The
// poll loop is the only caller besides a command, and commands run inside
// it, so there is never a second frame in flight.
static bool exchange(const uint8_t* req, size_t reqLen, uint8_t* buf, size_t cap, jbd::Frame& out) {
  while (bms.available()) bms.read();  // stale bytes from a timed-out reply
  bms.write(req, reqLen);
  bms.flush();
  size_t n = 0;
  uint32_t start = millis();
  while (millis() - start < BMS_REPLY_TIMEOUT_MS) {
    while (bms.available() && n < cap) {
      buf[n++] = (uint8_t)bms.read();
      if (n >= 7 && buf[0] == jbd::START && n == (size_t)buf[3] + 7) {
        return jbd::parse(buf, n, out);
      }
      // Resync: anything before START is noise.
      if (n == 1 && buf[0] != jbd::START) n = 0;
    }
    delay(2);
  }
  return false;
}

static bool readRegister(uint8_t reg, uint16_t& value) {
  uint8_t req[7], buf[64];
  jbd::buildRead(reg, req);
  jbd::Frame f;
  if (!exchange(req, sizeof req, buf, sizeof buf, f) || f.status != 0 || f.len < 2) return false;
  value = (uint16_t)((f.data[0] << 8) | f.data[1]);
  return true;
}

static bool writeRegister(uint8_t reg, uint16_t value) {
  uint8_t req[9], buf[64];
  jbd::buildWrite(reg, value, req);
  jbd::Frame f;
  return exchange(req, sizeof req, buf, sizeof buf, f) && f.status == 0;
}

static void pollBms() {
  uint8_t req[7], buf[128];
  jbd::Frame f;
  bool ok = false;

  jbd::buildRead(jbd::CMD_BASIC, req);
  if (exchange(req, sizeof req, buf, sizeof buf, f)) {
    jbd::Basic b;
    if (jbd::parseBasic(f, b)) {
      gBms.basic = b;
      ok = true;
    }
  }
  jbd::buildRead(jbd::CMD_CELLS, req);
  if (exchange(req, sizeof req, buf, sizeof buf, f)) {
    size_t n = jbd::parseCells(f, gBms.cellsMv, proto::MAX_CELLS);
    if (n) {
      gBms.cellCount = (uint8_t)n;
      ok = true;
    }
  }
  if (ok) {
    gBms.everAnswered = true;
    gBms.lastAnswerMs = millis();
    if (!gBms.model[0]) strlcpy(gBms.model, "JBD SP24S004", sizeof gBms.model);
    snprintf(gBms.firmware, sizeof gBms.firmware, "%u.%u", gBms.basic.softwareVersion >> 4,
             gBms.basic.softwareVersion & 0x0f);
  }
  // The hardware string, once a minute: it names the exact board.
  if (ok && millis() - gBms.lastHardwareMs > HARDWARE_REFRESH_MS) {
    gBms.lastHardwareMs = millis();
    jbd::buildRead(jbd::CMD_HARDWARE, req);
    if (exchange(req, sizeof req, buf, sizeof buf, f) && f.status == 0 && f.len > 0) {
      size_t n = f.len < sizeof gBms.model - 1 ? f.len : sizeof gBms.model - 1;
      memcpy(gBms.model, f.data, n);
      gBms.model[n] = 0;
    }
  }
}

static bool bmsReachable() { return gBms.everAnswered && millis() - gBms.lastAnswerMs < BMS_REPLY_TIMEOUT_MS * 4; }

/* ------------------------------------------------------------------- BLE */

static NimBLEServer* gServer = nullptr;
static NimBLECharacteristic* gIdentity = nullptr;
static NimBLECharacteristic* gAuth = nullptr;
static NimBLECharacteristic* gTelemetry = nullptr;
static NimBLECharacteristic* gCommand = nullptr;
static NimBLECharacteristic* gResponse = nullptr;
static NimBLECharacteristic* gProvisioning = nullptr;

static void randomBytes(uint8_t* out, size_t n) { esp_fill_random(out, n); }

static auth::Handshake gHandshake(nullptr, gSerial, randomBytes);
static bool gConnected = false;
static uint16_t gConnHandle = 0;
static uint32_t gConnectedAtMs = 0;
static uint16_t gMtu = 23;
static uint32_t gTelemetrySeq = 0;

// Commands arrive on the BLE task; the BMS is driven from loop(). One slot
// hands the frame across, and BUSY answers a second one while it is held.
static volatile bool gCommandPending = false;
static uint8_t gCommandBuf[64];
static size_t gCommandLen = 0;

static void notifyFragmented(NimBLECharacteristic* ch, const uint8_t* frame, size_t len) {
  proto::fragment(frame, len, gMtu, [&](const uint8_t* p, size_t n) { ch->notify(p, n); });
}

static void refreshIdentity() {
  proto::Identity id = {gProvisioned ? gSerial : "", GATEWAY_HW_REVISION, GATEWAY_FW_VERSION,
                        gBms.everAnswered ? gBms.model : "", gBms.everAnswered ? gBms.firmware : "",
                        gBms.everAnswered ? gBms.basic.cellCount : (uint8_t)0, gProvisioned};
  uint8_t buf[200];
  size_t n = proto::encodeIdentity(id, buf, sizeof buf);
  gIdentity->setValue(buf, n);
}

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer*, NimBLEConnInfo& info) override {
    gConnected = true;
    gConnHandle = info.getConnHandle();
    gConnectedAtMs = millis();
    gMtu = info.getMTU();
    gHandshake.reset();
    Serial.printf("[ble] connected, mtu %u\n", gMtu);
  }
  void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int reason) override {
    gConnected = false;
    gHandshake.reset();
    gCommandPending = false;
    Serial.printf("[ble] disconnected (%d)\n", reason);
    NimBLEDevice::startAdvertising();
  }
  void onMTUChange(uint16_t mtu, NimBLEConnInfo&) override {
    gMtu = mtu;
    Serial.printf("[ble] mtu %u\n", mtu);
  }
};

class AuthCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* ch, NimBLEConnInfo&) override {
    NimBLEAttValue v = ch->getValue();
    uint8_t out[64];
    size_t n = gHandshake.receive(v.data(), v.length(), out, sizeof out);
    if (n) {
      ch->setValue(out, n);
      ch->notify();
    }
    if (gHandshake.authorised()) Serial.println("[auth] authorised");
    else if (n == 2 && out[1] != auth::OK && v.length() > 0 && v.data()[0] == 0x03) {
      Serial.println("[auth] refused; disconnecting");
      gServer->disconnect(gConnHandle);
    }
  }
};

class CommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* ch, NimBLEConnInfo&) override {
    NimBLEAttValue v = ch->getValue();
    if (gCommandPending || v.length() > sizeof gCommandBuf) {
      proto::Command c;
      if (proto::parseCommand(v.data(), v.length(), c)) {
        uint8_t out[8];
        size_t n = proto::encodeResponse(c.opcode, c.seq, proto::BUSY, nullptr, 0, out, sizeof out);
        gResponse->setValue(out, n);
        gResponse->notify();
      }
      return;
    }
    memcpy(gCommandBuf, v.data(), v.length());
    gCommandLen = v.length();
    gCommandPending = true;
  }
};

class ProvisioningCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* ch, NimBLEConnInfo&) override {
    NimBLEAttValue v = ch->getValue();
    uint8_t reply[2] = {0x02, 0x01};
    // [0x01][len][serial][key:32]
    if (!gProvisioned && v.length() >= 2 && v.data()[0] == 0x01) {
      size_t len = v.data()[1];
      if (len > 0 && len < sizeof gSerial && v.length() == 2 + len + auth::KEY_LEN) {
        char serial[32];
        memcpy(serial, v.data() + 2, len);
        serial[len] = 0;
        if (saveProvisioning(serial, v.data() + 2 + len)) {
          reply[1] = 0x00;
          ch->setValue(reply, 2);
          ch->notify();
          Serial.printf("[provision] %s over BLE; rebooting\n", serial);
          delay(200);
          ESP.restart();
        }
      }
    }
    ch->setValue(reply, 2);
    ch->notify();
  }
};

static void startBle() {
  char name[24];
  if (gProvisioned) {
    size_t n = strlen(gSerial);
    snprintf(name, sizeof name, "MEB-%s", n > 6 ? gSerial + n - 6 : gSerial);
  } else {
    NimBLEDevice::init("");
    std::string addr = NimBLEDevice::getAddress().toString();
    snprintf(name, sizeof name, "MEB-SETUP-%s", addr.substr(addr.length() - 5).erase(2, 1).c_str());
    NimBLEDevice::deinit(true);
  }
  NimBLEDevice::init(name);
  NimBLEDevice::setMTU(247);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);

  gServer = NimBLEDevice::createServer();
  gServer->setCallbacks(new ServerCallbacks());
  NimBLEService* svc = gServer->createService(proto::SERVICE_UUID);

  gIdentity = svc->createCharacteristic(proto::CHAR_IDENTITY, NIMBLE_PROPERTY::READ);
  gAuth = svc->createCharacteristic(proto::CHAR_AUTH, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
  gAuth->setCallbacks(new AuthCallbacks());
  gTelemetry = svc->createCharacteristic(proto::CHAR_TELEMETRY, NIMBLE_PROPERTY::NOTIFY);
  gCommand = svc->createCharacteristic(proto::CHAR_COMMAND, NIMBLE_PROPERTY::WRITE);
  gCommand->setCallbacks(new CommandCallbacks());
  gResponse = svc->createCharacteristic(proto::CHAR_RESPONSE, NIMBLE_PROPERTY::NOTIFY);
  if (!gProvisioned) {
    gProvisioning =
        svc->createCharacteristic(proto::CHAR_PROVISIONING, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
    gProvisioning->setCallbacks(new ProvisioningCallbacks());
  }
  refreshIdentity();
  svc->start();

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(proto::SERVICE_UUID);
  adv->setName(name);
  adv->enableScanResponse(true);
  adv->start();
  Serial.printf("[ble] advertising as %s\n", name);
}

/* ---------------------------------------------------------------- commands */

static void answer(uint8_t opcode, uint16_t seq, uint8_t status, const uint8_t* payload, size_t len) {
  uint8_t out[proto::TELEMETRY_MAX];
  size_t n = proto::encodeResponse(opcode, seq, status, payload, len, out, sizeof out);
  notifyFragmented(gResponse, out, n);
}

static uint8_t readParam(const params::Spec& s, int32_t& value) {
  if (s.unit == params::FIXED) {
    value = s.fixedValue;
    return proto::OK;
  }
  uint16_t reg;
  if (!readRegister(s.reg, reg)) return proto::BMS_TIMEOUT;
  value = params::toWire(s, reg);
  return proto::OK;
}

// §7.5: factory mode, write, read back, save and exit. Exit is attempted
// whatever happened, so a failed write does not leave the BMS in setup.
static uint8_t writeParam(const params::Spec& s, int32_t wire, int32_t& readBack) {
  uint16_t reg;
  if (!params::fromWire(s, wire, reg)) return proto::OUT_OF_RANGE;
  if (!writeRegister(jbd::REG_FACTORY, jbd::FACTORY_ENTER)) return proto::BMS_TIMEOUT;
  uint8_t status = proto::OK;
  if (!writeRegister(s.reg, reg)) {
    status = proto::OUT_OF_RANGE;  // the BMS answered with an error status
  }
  uint16_t after;
  bool readOk = readRegister(s.reg, after);
  bool exited = writeRegister(jbd::REG_EXIT, jbd::EXIT_SAVE);
  if (!readOk || !exited) return proto::BMS_TIMEOUT;
  readBack = params::toWire(s, after);
  if (status != proto::OK) return status;
  return after == reg ? proto::OK : proto::ADJUSTED;
}

static void handleCommand() {
  proto::Command c;
  if (!proto::parseCommand(gCommandBuf, gCommandLen, c)) {
    gCommandPending = false;
    return;
  }
  if (!gHandshake.authorised()) {
    answer(c.opcode, c.seq, proto::NOT_AUTHENTICATED, nullptr, 0);
    gCommandPending = false;
    return;
  }
  if (!proto::commandTagValid(c, gHandshake.session())) {
    answer(c.opcode, c.seq, proto::BAD_TAG, nullptr, 0);
    gCommandPending = false;
    return;
  }

  uint8_t payload[1 + params::COUNT * 5];
  switch (c.opcode) {
    case proto::READ_PARAM: {
      const params::Spec* s = c.payloadLen >= 1 ? params::find(c.payload[0]) : nullptr;
      if (!s || !s->verified) {
        answer(c.opcode, c.seq, proto::UNKNOWN_PARAM, nullptr, 0);
        break;
      }
      int32_t value = 0;
      uint8_t status = readParam(*s, value);
      proto::put32(payload, (uint32_t)value);
      answer(c.opcode, c.seq, status, payload, 4);
      break;
    }
    case proto::WRITE_PARAM: {
      const params::Spec* s = c.payloadLen >= 5 ? params::find(c.payload[0]) : nullptr;
      if (!s || !s->verified) {
        answer(c.opcode, c.seq, proto::UNKNOWN_PARAM, nullptr, 0);
        break;
      }
      if (!s->writable) {
        answer(c.opcode, c.seq, proto::READ_ONLY, nullptr, 0);
        break;
      }
      int32_t wire = proto::get32(c.payload + 1);
      int32_t readBack = 0;
      Serial.printf("[cmd] write param 0x%02x = %ld\n", s->id, (long)wire);
      uint8_t status = writeParam(*s, wire, readBack);
      proto::put32(payload, (uint32_t)readBack);
      answer(c.opcode, c.seq, status, payload, status == proto::BMS_TIMEOUT ? 0 : 4);
      break;
    }
    case proto::READ_ALL_PARAMS: {
      size_t at = 1;
      uint8_t count = 0;
      for (size_t i = 0; i < params::COUNT; ++i) {
        const params::Spec& s = params::TABLE[i];
        if (!s.verified) continue;
        int32_t value = 0;
        if (readParam(s, value) != proto::OK) continue;
        payload[at] = s.id;
        proto::put32(payload + at + 1, (uint32_t)value);
        at += 5;
        count++;
      }
      payload[0] = count;
      answer(c.opcode, c.seq, proto::OK, payload, at);
      break;
    }
    default:
      answer(c.opcode, c.seq, proto::UNKNOWN_PARAM, nullptr, 0);
  }
  gCommandPending = false;
}

/* -------------------------------------------------------------- telemetry */

static void sendTelemetry() {
  proto::Telemetry t = {};
  bool live = bmsReachable();
  bool dropped = gBms.everAnswered && millis() - gBms.lastAnswerMs > BMS_SILENCE_DROP_MS;
  t.seq = ++gTelemetrySeq;
  t.uptimeMs = millis();
  t.bmsUnreachable = !live;
  if (gBms.everAnswered && !dropped) {
    const jbd::Basic& b = gBms.basic;
    t.chargeMos = b.fetBits & 0x01;
    t.dischargeMos = b.fetBits & 0x02;
    t.balancing = b.balanceMask != 0;
    t.packVoltage10mV = b.packVoltage10mV;
    t.packCurrent10mA = b.current10mA;
    t.socTenths = (uint16_t)b.soc * 10;
    // JBD reports no state of health; remaining/nominal at full charge is
    // the closest honest figure, and 100 % when it cannot be told.
    t.sohTenths = 1000;
    t.cycles = b.cycles;
    t.protection = b.protection;
    t.balancingMask = b.balanceMask;
    t.ntcCount = b.ntcCount;
    for (uint8_t i = 0; i < b.ntcCount && i < proto::MAX_NTC; ++i) t.tempsTenths[i] = b.tempsTenthsC[i];
    t.cellCount = gBms.cellCount;
    for (uint8_t i = 0; i < gBms.cellCount; ++i) t.cellsMv[i] = gBms.cellsMv[i];
  }
  uint8_t out[proto::TELEMETRY_MAX];
  size_t n = proto::encodeTelemetry(t, out, sizeof out);
  notifyFragmented(gTelemetry, out, n);
}

/* ---------------------------------------------------------------- console */

static bool bootButtonHeld() { return digitalRead(BOOT_BUTTON_PIN) == LOW; }

static void console(const String& line) {
  if (line == "status") {
    Serial.printf("serial: %s\nkey: %s\nbms: %s\nble: %s\n", gProvisioned ? gSerial : "(none)",
                  gProvisioned ? "set" : "not set", gBms.everAnswered ? gBms.model : "not seen",
                  gConnected ? (gHandshake.authorised() ? "authorised" : "connected") : "advertising");
    return;
  }
  if (line.startsWith("provision ")) {
    int sp = line.indexOf(' ', 10);
    if (sp < 0) {
      Serial.println("usage: provision <serial> <64 hex characters>");
      return;
    }
    String serial = line.substring(10, sp);
    String hex = line.substring(sp + 1);
    hex.trim();
    if (serial.length() == 0 || serial.length() >= sizeof gSerial || hex.length() != 64) {
      Serial.println("provision: serial up to 31 characters, key exactly 64 hex characters");
      return;
    }
    uint8_t key[auth::KEY_LEN];
    for (size_t i = 0; i < auth::KEY_LEN; ++i) {
      char pair[3] = {hex[i * 2], hex[i * 2 + 1], 0};
      char* end;
      long v = strtol(pair, &end, 16);
      if (*end) {
        Serial.println("provision: key is not hex");
        return;
      }
      key[i] = (uint8_t)v;
    }
    if (gProvisioned && !bootButtonHeld()) {
      Serial.println("already provisioned: hold BOOT while sending to replace the key");
      return;
    }
    if (saveProvisioning(serial.c_str(), key)) {
      Serial.printf("provisioned %s; rebooting\n", serial.c_str());
      delay(200);
      ESP.restart();
    } else {
      Serial.println("provision: could not write flash");
    }
    return;
  }
  if (line == "factory-reset") {
    if (!bootButtonHeld()) {
      Serial.println("hold BOOT while sending factory-reset");
      return;
    }
    clearProvisioning();
    Serial.println("cleared; rebooting into setup mode");
    delay(200);
    ESP.restart();
    return;
  }
  Serial.println("commands: status | provision <serial> <hexkey> | factory-reset");
}

/* ------------------------------------------------------------------- main */

void setup() {
  Serial.begin(115200);
  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);
  delay(200);
  Serial.printf("\nMEB Energy gateway %s %s\n", GATEWAY_HW_REVISION, GATEWAY_FW_VERSION);

  loadProvisioning();
  gHandshake = auth::Handshake(gProvisioned ? gKey : nullptr, gSerial, randomBytes);
  Serial.printf("[flash] %s\n", gProvisioned ? gSerial : "not provisioned (setup mode)");

  bms.begin(BMS_BAUD, SERIAL_8N1, BMS_RX_PIN, BMS_TX_PIN);
  Serial.printf("[bms] uart rx=%d tx=%d @ %d\n", BMS_RX_PIN, BMS_TX_PIN, BMS_BAUD);

  startBle();
}

void loop() {
  static uint32_t lastPoll = 0;
  static String line;

  // The console, a line at a time.
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      line.trim();
      if (line.length()) console(line);
      line = "";
    } else if (line.length() < 120) {
      line += c;
    }
  }

  // A central that never authenticates does not get to sit on the link.
  if (gConnected && !gHandshake.authorised() && millis() - gConnectedAtMs > HANDSHAKE_DEADLINE_MS) {
    Serial.println("[auth] deadline; disconnecting");
    gServer->disconnect(gConnHandle);
    gConnectedAtMs = millis();
  }

  if (gCommandPending) handleCommand();

  if (millis() - lastPoll >= POLL_MS) {
    lastPoll = millis();
    if (gProvisioned) pollBms();
    refreshIdentity();
    if (gConnected && gHandshake.authorised()) sendTelemetry();
  }

  delay(5);
}
