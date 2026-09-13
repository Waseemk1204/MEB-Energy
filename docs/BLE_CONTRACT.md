# The gateway contract

**MEB Energy gateway · BLE protocol version 1**

What passes between the app and the ESP32 gateway that sits on a pack's BMS.
The firmware in [`firmware/`](../firmware) implements the gateway side; the
app's [`mobile/src/ble/`](../mobile/src/ble) implements the central side. The
two share nothing but this document, and the app's codec tests are written
from it, not from the firmware — so a disagreement fails a test rather than a
technician.

The BMS is a Jiabaida (JBD) SP24S004 on UART. The gateway speaks JBD's
protocol to it and speaks *this* protocol to the app. The app never sees a
vendor packet; a different BMS is a different table in the firmware, not a
change here.

---

## 1. Roles and the two rules

The **gateway** is a BLE peripheral: it advertises, accepts one connection at
a time, and is the only thing that talks to the BMS.

The **app** is the central: it connects, authenticates, then reads telemetry
and issues parameter reads and writes.

Two rules the rest of this document serves:

1. **Nothing leaves the gateway to a central that has not proved it holds the
   gateway's key**, and nothing the app is shown is trusted unless the gateway
   proved the same. Mutual, per connection, before any telemetry or command.
2. **A write is only ever reported as what the BMS did**, read back after the
   write. "Sent" is not an outcome.

---

## 2. Advertising and discovery

| | |
|---|---|
| Complete local name | `MEB-` + last six characters of the gateway serial, e.g. `MEB-000184` |
| Advertised service | the gateway service UUID below (128-bit, complete list) |
| Connectable | yes; one central at a time |
| Preferred MTU | 247 (the gateway requests it; frames are fragmented if less is negotiated, §7) |

An **unprovisioned** gateway (no serial and key in flash yet) advertises as
`MEB-SETUP-` + last four hex digits of its BLE address and exposes only the
Identity and Provisioning characteristics (§8).

---

## 3. GATT layout

Base UUID `7a3f00XX-3b7e-4d5b-9c1a-2f4e6d8a0b10`; the `XX` byte selects:

| `XX` | Characteristic | Properties | Purpose |
|---|---|---|---|
| `01` | *(service)* | | The gateway service |
| `02` | **Identity** | read | Who this gateway is, and which BMS it found (§4) |
| `03` | **Auth** | write, notify | The mutual handshake (§5) |
| `04` | **Telemetry** | notify | One frame per 500 ms while authenticated (§6) |
| `05` | **Command** | write | Parameter reads and writes (§7) |
| `06` | **Response** | notify | The answer to each command (§7) |
| `07` | **Provisioning** | write, notify | Unprovisioned gateways only (§8) |

All multi-byte integers are **little-endian**. Signed integers are two's
complement. Strings are UTF-8 without a terminator, length-prefixed by the
enclosing TLV.

---

## 4. Identity

A read returns a sequence of TLVs: `[tag u8][length u8][value …]`. Unknown
tags are skipped by length, so a later firmware can add fields without
breaking an earlier app.

| Tag | Value | Notes |
|---|---|---|
| `0x01` | protocol version, u8 | `1` for this document |
| `0x02` | gateway serial, string | as registered in the company's gateway list, e.g. `GW-000184` |
| `0x03` | hardware revision, string | e.g. `HW 1.0` |
| `0x04` | gateway firmware version, string | e.g. `FW 1.0.0` |
| `0x05` | BMS model, string | what the gateway detected on UART, or absent if none answered |
| `0x06` | BMS firmware, string | JBD's version byte rendered as `major.minor`, or absent |
| `0x07` | cell count, u8 | as the BMS reports it |
| `0x08` | provisioned, u8 | `1` if serial and key are set; `0` in setup mode |

The app compares tag `0x02` with the gateway list the server gave it. A serial
the company has not registered, or one whose security status is not
`valid`, is refused before authentication is attempted.

---

## 5. Authentication

Each gateway holds a 32-byte key **K**, written once at provisioning (§8).
The server holds the same key against the gateway's serial and hands it, over
TLS, to the company's signed-in users who may read packs; the app keeps it in
secure storage so a technician with no signal can still authenticate on site.
Revoking a gateway in the app removes it from that list; the app refuses a
revoked serial at §4 and forgets its key.

The handshake proves both sides hold K without sending it. All HMACs are
HMAC-SHA-256. `‖` is byte concatenation. `serial` is the UTF-8 bytes of the
gateway serial from Identity.

1. **App → Auth (write):** `[0x01][nonceA: 16 bytes]` — random.
2. **Gateway → Auth (notify):** `[0x02][nonceG: 16 bytes][tagG: 32 bytes]`
   where `tagG = HMAC(K, "MEB-GW-1" ‖ serial ‖ nonceA ‖ nonceG)`.
3. The app recomputes `tagG`. If it differs, the app disconnects and reports
   the peripheral as **unverified**. Nothing else is read from it.
4. **App → Auth (write):** `[0x03][tagA: 32 bytes]`
   where `tagA = HMAC(K, "MEB-APP-1" ‖ serial ‖ nonceG ‖ nonceA)`.
5. **Gateway → Auth (notify):** `[0x04][status: u8]`. `0x00` means the
   connection is **authorised**. Anything else and the gateway disconnects.
6. Both sides derive the **session key**
   `S = HMAC(K, "MEB-SESS-1" ‖ nonceA ‖ nonceG)`, used to tag every command
   (§7). It lives as long as the connection.

Status values for step 5: `0x00` ok · `0x01` bad tag · `0x02` handshake out
of order · `0x03` not provisioned.

Until step 5 succeeds the gateway sends no telemetry and answers every
command with status `NOT_AUTHENTICATED`. A gateway that has not completed
the handshake within 10 seconds of connection disconnects. The handshake may
be repeated on the same connection (a fresh nonce pair replaces S).

Why mutual: a gateway that only proved *itself* would still take writes from
any phone that walked past. Why a session key rather than K on the wire: K
never crosses the air, and a captured command cannot be replayed on another
connection.

---

## 6. Telemetry

One notification every **500 ms** while authorised and subscribed. The frame:

| Offset | Type | Field | Unit / meaning |
|---|---|---|---|
| 0 | u8 | version | `1` |
| 1 | u8 | flags | bit0 charge MOS on · bit1 discharge MOS on · bit2 balancing active · bit3 BMS unreachable (rest of frame is the last good reading) |
| 2 | u32 | seq | increments per frame; a gap means frames were missed |
| 6 | u32 | uptime | gateway milliseconds since boot |
| 10 | u16 | packVoltage | 10 mV |
| 12 | i32 | packCurrent | 10 mA; positive charging, negative discharging |
| 16 | u16 | soc | 0.1 % |
| 18 | u16 | soh | 0.1 % (`1000` if the BMS does not report one) |
| 20 | u16 | cycles | count |
| 22 | u16 | protection | JBD protection bits, verbatim (§6.1) |
| 24 | u32 | balancingCells | bitmask, bit *n* = cell *n+1* balancing |
| 28 | u8 | ntcCount | *T* |
| 29 | i16 × T | temperatures | 0.1 °C |
| 29 + 2T | u8 | cellCount | *N* |
| 30 + 2T | u16 × N | cellVoltages | mV |

For a 24S pack with two NTCs the frame is 82 bytes; with MTU 247 it is one
notification, otherwise it is fragmented (§7.3). The app derives min/max/delta
from the cell array; the gateway does not send them.

### 6.1 Protection bits

Bit *n* set means that protection is currently tripped.

| Bit | Fault | Level |
|---|---|---|
| 0 | Cell over-voltage | Critical |
| 1 | Cell under-voltage | Critical |
| 2 | Pack over-voltage | Critical |
| 3 | Pack under-voltage | Critical |
| 4 | Charge over-temperature | Warning |
| 5 | Charge under-temperature | Warning |
| 6 | Discharge over-temperature | Warning |
| 7 | Discharge under-temperature | Warning |
| 8 | Charge over-current | Critical |
| 9 | Discharge over-current | Critical |
| 10 | Short circuit | Critical |
| 11 | BMS IC error | Critical |
| 12 | MOS software lock | Warning |

These are JBD's own bit positions from the basic-info status word, passed
through unchanged so a bit the firmware does not know about still reaches the
app (which shows it as an unnamed fault rather than dropping it).

---

## 7. Commands

### 7.1 Framing

A command is written to **Command**; its answer arrives on **Response**.
Every command carries a sequence number the app chooses (u16, incrementing)
and the answer echoes it, so answers cannot be mismatched.

**Command:** `[opcode u8][seq u16][payload …][tag 16 bytes]`
where `tag` is the first 16 bytes of `HMAC(S, opcode ‖ seq ‖ payload)`.

**Response:** `[opcode | 0x80][seq u16][status u8][payload …]`

The gateway verifies the tag before doing anything. A bad tag is answered
with status `BAD_TAG` and nothing is sent to the BMS.

### 7.2 Opcodes

| Opcode | Name | Payload | Response payload |
|---|---|---|---|
| `0x10` | READ_PARAM | `[param u8]` | `[value i32]` |
| `0x11` | WRITE_PARAM | `[param u8][value i32]` | `[readBack i32]` — what the BMS holds *after* the write |
| `0x12` | READ_ALL_PARAMS | — | `[count u8]` then `count` × `[param u8][value i32]` |

Values are integers in the parameter's **wire unit** (§7.4); the app
converts to the unit it displays.

**Status:** `0x00` OK · `0x01` UNKNOWN_PARAM · `0x02` READ_ONLY ·
`0x03` OUT_OF_RANGE (the BMS refused it) · `0x04` BMS_TIMEOUT ·
`0x05` NOT_AUTHENTICATED · `0x06` BAD_TAG · `0x07` BUSY ·
`0x08` ADJUSTED (the write was accepted but the read-back differs from what
was asked; `readBack` says what it holds).

The app maps these onto the ledger's outcomes: OK → *success*, ADJUSTED →
*adjusted*, READ_ONLY / OUT_OF_RANGE / UNKNOWN_PARAM / BAD_TAG → *rejected*,
BMS_TIMEOUT → *timeout*, a lost link mid-write → *indeterminate*.

### 7.3 Fragmentation

Any frame on Telemetry or Response longer than `MTU − 3` bytes is sent as
fragments, each prefixed with one byte: bit 7 set on the **last** fragment,
bits 0–6 the fragment index from 0. A frame that fits is still sent with the
prefix (`0x80`). The app reassembles by index and discards a sequence with a
gap. Commands are never fragmented: the longest is 24 bytes.

### 7.4 Parameters

The `param` byte, the wire unit, and the JBD EEPROM register the gateway
reads or writes for it. The parameter keys are the app's capability profile
(`mobile/src/bms/jbd-sp24s004.json`); the app's write bounds come from the
server and are enforced there — the gateway enforces nothing but what the
BMS itself refuses.

| `param` | Key | Wire unit | JBD register | JBD unit | R/W |
|---|---|---|---|---|---|
| `0x01` | `cell_ovp` | mV | `0x24` | mV | RW |
| `0x02` | `cell_ovp_release` | mV | `0x25` | mV | RW |
| `0x03` | `cell_uvp` | mV | `0x26` | mV | RW |
| `0x04` | `cell_uvp_release` | mV | `0x27` | mV | RW |
| `0x05` | `cell_ovp_delay` | ms | `0x3D` ⚠ | see note | RW |
| `0x06` | `cell_uvp_delay` | ms | `0x3D` ⚠ | see note | RW |
| `0x10` | `charge_ocp` | mA | `0x28` | 10 mA | R |
| `0x11` | `charge_ocp_delay` | s | `0x3A` ⚠ | s | RW |
| `0x12` | `discharge_ocp_1` | mA | `0x29` | 10 mA | R |
| `0x13` | `discharge_ocp_1_delay` | s | `0x3A` ⚠ | s | RW |
| `0x14` | `discharge_ocp_2` | mA | `0x39` ⚠ | see note | R |
| `0x15` | `discharge_ocp_2_delay` | ms | `0x39` ⚠ | see note | RW |
| `0x16` | `short_circuit` | mA | `0x39` ⚠ | see note | R |
| `0x17` | `short_circuit_delay` | µs | `0x39` ⚠ | see note | RW |
| `0x20` | `charge_htp` | 0.1 °C | `0x18` | 0.1 K | RW |
| `0x21` | `charge_htp_release` | 0.1 °C | `0x1C` | 0.1 K | RW |
| `0x22` | `charge_ltp` | 0.1 °C | `0x19` | 0.1 K | RW |
| `0x23` | `charge_ltp_release` | 0.1 °C | `0x1D` | 0.1 K | RW |
| `0x24` | `discharge_htp` | 0.1 °C | `0x1A` | 0.1 K | RW |
| `0x25` | `discharge_htp_release` | 0.1 °C | `0x1E` | 0.1 K | RW |
| `0x26` | `discharge_ltp` | 0.1 °C | `0x1B` | 0.1 K | RW |
| `0x27` | `discharge_ltp_release` | 0.1 °C | `0x1F` | 0.1 K | RW |
| `0x28` | `fet_htp` | 0.1 °C | ⚠ | see note | RW |
| `0x29` | `fet_htp_release` | 0.1 °C | ⚠ | see note | RW |
| `0x30` | `balance_start_v` | mV | `0x2A` | mV | RW |
| `0x31` | `balance_delta_mv` | mV | `0x2B` | mV | RW |
| `0x32` | `balance_current_ma` | mA | — | fixed by hardware | R (gateway reports the SKU value) |
| `0x40` | `cell_count` | S | `0x2F` | count | R |
| `0x41` | `capacity_ah` | mAh | `0x10` | 10 mAh | RW |

**⚠ Verify against the SP24S004 register sheet before first use.** The
unmarked registers are the JBD protocol's well-documented set (used by every
open JBD tool). The delay, second-stage and short-circuit registers pack
several fields into one word with hardware-specific encodings, and the
FET-temperature pair exists on some JBD boards and not others. Those rows are
placeholders in the firmware's table (`firmware/src/jbd_params.h`) and are
answered with `UNKNOWN_PARAM` until the register and encoding are confirmed —
which is the honest answer, and the app shows it as a refusal rather than
writing to the wrong register.

Temperatures cross the wire in 0.1 °C; the gateway converts to and from
JBD's 0.1 K (`K = °C + 2731`).

### 7.5 The write sequence on the gateway

For WRITE_PARAM the gateway, in order: enters JBD factory mode (register
`0x00` ← `0x5678`), writes the register, reads it back, exits factory mode
saving to EEPROM (register `0x01` ← `0x2828`), and answers with the
read-back. If any step times out the answer is `BMS_TIMEOUT` and the gateway
attempts to exit factory mode regardless. If the read-back differs from what
was asked the answer is `ADJUSTED`.

---

## 8. Provisioning

A gateway needs its serial and key before it can be used. Two ways in:

**Serial console (always available, needs physical access).** At 115200 8N1
on the USB port:

```
provision GW-000184 <64 hex characters of K>
```

The gateway stores both in flash, confirms, and reboots into normal mode.
`status` prints the serial and whether a key is set; `factory-reset` clears
both (and needs the BOOT button held while the command is sent, so a stray
line on a serial monitor cannot wipe a fielded gateway).

**Over BLE (setup mode only).** While unprovisioned the Provisioning
characteristic accepts `[0x01][serial length u8][serial][K: 32 bytes]` and
notifies `[0x02][status u8]`. Once provisioned the characteristic is removed
until a factory reset. An unprovisioned gateway holds no key and serves no
BMS, so accepting a key from anyone nearby gives nothing away; a provisioned
one cannot be re-keyed over the air.

The server generates K when an administrator registers the gateway (`POST
/devices`) and returns it **once**, as a line ready for the console:
`provision GW-000184 <hex>`. It is stored server-side and delivered to the
app as §5 describes; it is never shown again in the dashboard.

---

## 9. What the gateway does on its own

- Polls the BMS every 500 ms: basic info (`0x03`) and cell voltages (`0x04`),
  alternating with hardware version (`0x05`) once a minute to keep Identity's
  BMS fields current.
- If the BMS stops answering, telemetry continues with flag bit 3 set and the
  last good reading, so the app can say *stale* rather than freezing. After
  30 s of silence the gateway drops the reading and sends zeros with the flag.
- Holds no history. The app buffers and uploads; the gateway is a bridge.
- Never writes to the BMS except in response to an authorised WRITE_PARAM.
- Logs nothing that identifies a pack over the serial console in normal
  mode beyond the serial number and connection state.

---

## 10. Versioning

Identity tag `0x01` carries the protocol version. An app that reads a version
it does not know refuses the gateway with a message naming both versions
rather than guessing at a frame layout. Additive changes (new TLV tags, new
opcodes, new parameters) do not bump the version; a change to an existing
frame does.
