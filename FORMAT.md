# `.pwrec.gz` recording format, version 1

A recording holds the raw UDP datagrams the game sent, byte for byte, with receive times. Nothing is decoded or changed, so a recording can be replayed into any F1 25 telemetry consumer as if the game were running.

## Layers

1. **gzip** (RFC 1952). The writer sync-flushes about once per second, so a file cut off by a crash or kill decompresses up to the last flush. Readers should decompress leniently (zlib `finishFlush: Z_SYNC_FLUSH`) and treat an incomplete trailing record as the end of the data.
2. **Byte stream** inside the gzip layer: one header, then records. All integers and floats are **little-endian**.

## Header

| Offset | Type | Field |
|---|---|---|
| 0 | 5 bytes | magic, ASCII `PWREC` |
| 5 | u8 | format version, `1` |
| 6 | u32 | `n`: length of the metadata JSON in bytes |
| 10 | n bytes | metadata, UTF-8 JSON |

Metadata fields (readers must ignore unknown fields):

| Field | Type | Meaning |
|---|---|---|
| `recorderVersion` | string | version of the recorder that wrote the file |
| `startedAt` | string | ISO 8601 time when the file was started; record times are relative to it |
| `listenPort` | number | UDP port the recorder listened on |

Readers must reject other magic values and versions.

## Records

Repeated until the end of the stream:

| Offset | Type | Field |
|---|---|---|
| 0 | u8 | kind |
| 1 | f64 | `t`: milliseconds since the file was started (monotonic clock, non-decreasing) |
| 9 | u16 | `len`: payload length in bytes |
| 11 | len bytes | payload |

| Kind | Meaning |
|---|---|
| `0` | **datagram**: the payload is one UDP datagram exactly as received |
| `255` | **end**: written last when the recorder closes the file cleanly; payload empty. A file without it was cut off (crash or kill). Its data is still valid up to where it stops. |
| others | reserved. Readers skip them using `len`. |

## File organisation

- The recorder starts a new file whenever the F1 packet header's `m_sessionUID` (bytes 7–14, u64) changes to a new non-zero value. So one file usually holds one game session (practice, qualifying, race, or a restart of one).
- Datagrams with session id 0, or too short to have an F1 header, go into the file currently open. If none is open yet, they go into a file named `…_unknown-session.pwrec.gz`.
- File names: `YYYY-MM-DD_HH-MM-SS_<sessionUID as 16 hex digits>.pwrec.gz` (local time of the recorder's machine).
- Datagrams are stored whatever their packet format, so a file can contain data that isn't F1 25 (format 2025) if the game was set up wrong. Check `m_packetFormat` (bytes 0–1, u16) when reading.
