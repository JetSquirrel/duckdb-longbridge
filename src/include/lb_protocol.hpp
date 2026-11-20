#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace duckdb {

// Longbridge OpenAPI socket packet framing (wss://openapi-quote.longbridge.com/v2).
// All multi-byte integers are BIG-ENDIAN.
//
// Request packet:
//   u8  header      - type(low nibble) | verify(bit 4) | gzip(bit 5) | reserved(bits 6-7); client sends 0x01
//   u8  cmd_code
//   u32 request_id
//   u16 timeout_ms
//   u24 body_len    - 3-byte big-endian length (NOT u32)
//   body[body_len]
//
// Response packet:
//   u8  header
//   u8  cmd_code
//   u32 request_id
//   u8  status_code
//   u24 body_len    - 3-byte big-endian length (NOT u32)
//   body[body_len]
//
// Header byte bit layout (verified against the official docs' worked examples, e.g. type=1/all-flags-clear
// = 0x01 and reserve=3/gzip=1/type=3 = 0xE3): type = LOW nibble (bits 3..0): 1 = request, 2 = response,
// 3 = push; verify = bit 4 (0x10), gzip = bit 5 (0x20), reserved = bits 7..6. The client sends 0x01.
//
// VERIFY TRAILER: if the verify bit is set on a received packet, an 8-byte nonce and a
// 16-byte signature trail the body. body_len covers the protobuf body only; the total
// payload on the wire is body_len + 24. DecodeResponsePacket strips the trailing 24
// bytes before exposing the body. (We do not verify the signature; the nonce/signature
// scheme is only used on the private-channel handshake and is simply removed.)
//
// GZIP: if the gzip bit is set, DecodeResponsePacket throws IOException - gzip-compressed
// socket responses are not supported yet (no zlib dependency).
//
// Throws duckdb::IOException on malformed frames.

struct LbPacket {
	// Encodes a request packet (header byte 0x01: type=1, no verify, no gzip).
	static std::vector<uint8_t> EncodeRequest(uint8_t cmd_code, uint32_t request_id, uint16_t timeout_ms,
	                                          const std::vector<uint8_t> &body);
};

struct LbResponse {
	uint8_t cmd_code;
	uint32_t request_id;
	uint8_t status_code;
	std::vector<uint8_t> body; // protobuf payload; verify trailer already stripped
};

// Parses one response packet. Throws IOException on a malformed frame, on a non-response
// packet type (push packets must be filtered by the caller - see IsPushPacket), and when
// the gzip flag is set. Strips the 24-byte verify trailer when present.
LbResponse DecodeResponsePacket(const std::vector<uint8_t> &packet);

// True when the header type nibble (low 4 bits) == 3 (server push). Safe on short buffers (returns false).
bool IsPushPacket(const std::vector<uint8_t> &packet);

// Maps a response status_code to a message:
//   0 ok, 1 timeout, 3 bad request, 5 unauthenticated, 7 internal; unknown -> generic.
std::string LbStatusMessage(uint8_t status_code);

} // namespace duckdb
