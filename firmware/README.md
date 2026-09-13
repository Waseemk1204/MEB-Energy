# The gateway firmware

An ESP32 between a JBD SP24S004 BMS (UART) and the app (BLE). What it speaks
over the air is [`docs/BLE_CONTRACT.md`](../docs/BLE_CONTRACT.md); this
README is how to build it, wire it, and put a key in it.

## Layout

| File | What |
|---|---|
| `src/main.cpp` | The device: NimBLE service, the BMS UART, the 500 ms poll, commands, provisioning, the serial console. The only file that includes `Arduino.h`. |
| `src/protocol.*` | The wire format — identity TLV, telemetry frame, command/response, fragmentation. |
| `src/auth.*` | The gateway's side of the mutual handshake. |
| `src/jbd.*` | JBD's UART protocol: framing, checksums, basic-info and cell layouts, factory-mode writes. |
| `src/jbd_params.h` | The parameter table: app parameter byte → JBD register → unit. **Read the `verified` column.** |
| `src/sha256.*` | SHA-256 / HMAC, portable. |
| `test/test_protocol/` | Host tests. The fixed vectors are the same bytes the app's `mobile/src/ble/codec.test.ts` asserts. |

Everything except `main.cpp` compiles on the host, which is how the protocol
is tested without a board.

## Build

[PlatformIO](https://platformio.org) CLI (`pip install platformio`). Then, in
this directory:

```bash
pio test -e native            # the protocol against the app's vectors, no hardware
pio run -e esp32dev           # plain ESP32 (WROOM-32 dev boards)
pio run -e esp32s3            # ESP32-S3
pio run -e esp32c3            # ESP32-C3
pio run -e esp32dev -t upload # flash over USB
pio device monitor            # the serial console, 115200
```

Pick the environment that matches the board. The BMS UART pins are per
environment in `platformio.ini`; override with `-DBMS_RX_PIN=… -DBMS_TX_PIN=…`
if the board is wired differently.

## Wiring

The JBD UART header is 3.3 V logic, 9600 8N1. Four wires:

| BMS UART header | ESP32 |
|---|---|
| GND | GND |
| TX | `BMS_RX_PIN` (GPIO16 on esp32dev) |
| RX | `BMS_TX_PIN` (GPIO17 on esp32dev) |
| VCC (3.3 V from the BMS, if present) | *do not connect* — power the ESP32 separately |

Cross TX↔RX. Confirm the header pinout against the SP24S004 sheet before
connecting; JBD boards vary in pin order. Power the ESP32 from its own USB or
a regulated 5 V supply, sharing ground with the BMS.

## Provisioning

A gateway with no serial and key advertises as `MEB-SETUP-xxxx` and serves no
BMS. Register it in the app first (Gateways → Add): the app shows a line once,
like

```
provision GW-000184 4f3c…64 hex characters…
```

Paste that line into the serial console (`pio device monitor`, then type it
and press Enter). The gateway stores both in flash and reboots as
`MEB-000184`. `status` shows what it holds.

`factory-reset` wipes both, but only while the BOOT button is held, so a
stray line on a monitor cannot blank a fielded gateway. Replacing the key on
a provisioned gateway (after "Rotate key" in the app) likewise needs BOOT held
while the new `provision` line is sent.

## The parameter table

`src/jbd_params.h` maps each of the app's parameters to a JBD EEPROM register.
Rows with `verified = false` are answered `UNKNOWN_PARAM` — the app shows the
write as refused — until the register number **and its encoding** are
confirmed against the SP24S004 register sheet. The delay registers pack
several fields into one word and differ between JBD boards; the FET
temperature pair exists on some and not others. Writing to a guessed register
on a battery is not a thing to do, so the table refuses rather than guesses.
When a row is confirmed, set the register, set `verified = true`, and if the
encoding is not a plain 16-bit value, add a `Unit` for it.

## What to expect on the console

```
MEB Energy gateway HW 1.0 FW 1.0.0
[flash] GW-000184
[bms] uart rx=16 tx=17 @ 9600
[ble] advertising as MEB-000184
[ble] connected, mtu 247
[auth] authorised
[cmd] write param 0x01 = 3750
```

No BMS answering shows in the app as *BMS unreachable* on every frame (flag
bit 3) rather than as silence: the gateway keeps sending so the app can say
*stale* instead of freezing.
