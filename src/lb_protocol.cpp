#include "lb_protocol.hpp"

#include "duckdb/common/exception.hpp"

namespace duckdb {

// Header type nibbles.
static constexpr uint8_t LB_TYPE_REQUEST = 1;
static constexpr uint8_t LB_TYPE_RESPONSE = 2;
static constexpr uint8_t LB_TYPE_PUSH = 3;

static constexpr uint8_t LB_HEADER_FLAG_VERIFY = 0x10; // bit 4
static constexpr uint8_t LB_HEADER_FLAG_GZIP = 0x20;   // bit 5

// 8-byte nonce + 16-byte signature trailing the body when the verify flag is set.
static constexpr size_t LB_VERIFY_TRAILER_LEN = 24;

static constexpr size_t LB_REQUEST_HEADER_LEN = 11;  // u8+u8+u32+u16+u24 = 1+1+4+2+3
static constexpr size_t LB_RESPONSE_HEADER_LEN = 10; // u8+u8+u32+u8+u24 = 1+1+4+1+3

static uint32_t ReadU24BE(const uint8_t *p) {
	return (static_cast<uint32_t>(p[0]) << 16) | (static_cast<uint32_t>(p[1]) << 8) | static_cast<uint32_t>(p[2]);
}

static uint32_t ReadU32BE(const uint8_t *p) {
	return (static_cast<uint32_t>(p[0]) << 24) | (static_cast<uint32_t>(p[1]) << 16) |
	       (static_cast<uint32_t>(p[2]) << 8) | static_cast<uint32_t>(p[3]);
}

static void WriteU16BE(std::vector<uint8_t> &out, uint16_t v) {
	out.push_back(static_cast<uint8_t>((v >> 8) & 0xFF));
	out.push_back(static_cast<uint8_t>(v & 0xFF));
}

static void WriteU24BE(std::vector<uint8_t> &out, uint32_t v) {
	out.push_back(static_cast<uint8_t>((v >> 16) & 0xFF));
	out.push_back(static_cast<uint8_t>((v >> 8) & 0xFF));
	out.push_back(static_cast<uint8_t>(v & 0xFF));
}

static void WriteU32BE(std::vector<uint8_t> &out, uint32_t v) {
	out.push_back(static_cast<uint8_t>((v >> 24) & 0xFF));
	out.push_back(static_cast<uint8_t>((v >> 16) & 0xFF));
	out.push_back(static_cast<uint8_t>((v >> 8) & 0xFF));
	out.push_back(static_cast<uint8_t>(v & 0xFF));
}

std::vector<uint8_t> LbPacket::EncodeRequest(uint8_t cmd_code, uint32_t request_id, uint16_t timeout_ms,
                                             const std::vector<uint8_t> &body) {
	if (body.size() > 0xFFFFFF) {
		throw IOException("lb_protocol: request body too large (%llu bytes, max 16777215)",
		                  static_cast<unsigned long long>(body.size()));
	}
	std::vector<uint8_t> out;
	out.reserve(LB_REQUEST_HEADER_LEN + body.size());
	out.push_back(LB_TYPE_REQUEST); // 0x01: type=request, no verify, no gzip
	out.push_back(cmd_code);
	WriteU32BE(out, request_id);
	WriteU16BE(out, timeout_ms);
	WriteU24BE(out, static_cast<uint32_t>(body.size()));
	out.insert(out.end(), body.begin(), body.end());
	return out;
}

bool IsPushPacket(const std::vector<uint8_t> &packet) {
	if (packet.empty()) {
		return false;
	}
	return (packet[0] & 0x0F) == LB_TYPE_PUSH;
}

LbResponse DecodeResponsePacket(const std::vector<uint8_t> &packet) {
	if (packet.size() < LB_RESPONSE_HEADER_LEN) {
		throw IOException("lb_protocol: response packet too short (%llu bytes, need at least 10)",
		                  static_cast<unsigned long long>(packet.size()));
	}
	uint8_t header = packet[0];
	uint8_t type = header & 0x0F;
	if (type != LB_TYPE_RESPONSE) {
		if (type == LB_TYPE_PUSH) {
			throw IOException("lb_protocol: got a push packet where a response was expected (filter pushes first)");
		}
		throw IOException("lb_protocol: unexpected packet type %llu (expected response type 2)",
		                  static_cast<unsigned long long>(type));
	}
	if (header & LB_HEADER_FLAG_GZIP) {
		throw IOException("gzip-compressed socket responses are not supported yet");
	}

	uint32_t body_len = ReadU24BE(&packet[7]);
	bool has_verify_trailer = (header & LB_HEADER_FLAG_VERIFY) != 0;
	uint64_t expected = LB_RESPONSE_HEADER_LEN + static_cast<uint64_t>(body_len);
	if (has_verify_trailer) {
		expected += LB_VERIFY_TRAILER_LEN;
	}
	if (expected != packet.size()) {
		throw IOException("lb_protocol: malformed response packet: declared length is %llu bytes but got %llu",
		                  static_cast<unsigned long long>(expected), static_cast<unsigned long long>(packet.size()));
	}

	LbResponse resp;
	resp.cmd_code = packet[1];
	resp.request_id = ReadU32BE(&packet[2]);
	resp.status_code = packet[6];
	resp.body.assign(packet.begin() + LB_RESPONSE_HEADER_LEN, packet.begin() + LB_RESPONSE_HEADER_LEN + body_len);
	return resp;
}

std::string LbStatusMessage(uint8_t status_code) {
	switch (status_code) {
	case 0:
		return "ok";
	case 1:
		return "request timeout";
	case 3:
		return "bad request";
	case 5:
		return "unauthenticated";
	case 7:
		return "internal server error";
	default:
		return "unknown status code " + std::to_string(status_code);
	}
}

} // namespace duckdb
