#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace duckdb {

// Minimal RFC6455 WebSocket client over OpenSSL (blocking sockets).
// Self-contained transport used by the Longbridge quote pull session layer.
class WsClient {
public:
	// Connects TCP+TLS to host:port (SNI = host, peer cert verified), performs the WS upgrade
	// handshake GET path_with_query (e.g. "/v2?version=1&codec=1&platform=9") with
	// Sec-WebSocket-Key/Version: 13, and validates Sec-WebSocket-Accept (base64(SHA1(key+GUID))).
	// timeout_ms applies to connect, reads and writes. Throws duckdb::IOException on any failure.
	WsClient(const std::string &host, const std::string &port, const std::string &path_with_query, int timeout_ms);
	~WsClient(); // sends WS Close best-effort, shuts down TLS, closes fd

	WsClient(const WsClient &) = delete;
	WsClient &operator=(const WsClient &) = delete;

	void SendBinary(const std::vector<uint8_t> &payload); // one binary WS message; CLIENT FRAMES MUST BE MASKED (random
	                                                      // 4-byte mask)
	std::vector<uint8_t> RecvBinary(); // one complete binary message payload; handles continuation frames,
	                                   // 126/127 extended lengths, interleaved Ping (reply Pong echoing
	                                   // payload), ignores Pong; on Close frame throws IOException with
	                                   // close code/reason; on timeout throws IOException.

private:
	void ConnectTcp(const std::string &host, const std::string &port);
	void ConnectTls(const std::string &host);
	void Handshake(const std::string &host, const std::string &port, const std::string &path_with_query);

	void WriteAll(const uint8_t *data, size_t len);
	void ReadExact(uint8_t *data, size_t len);
	void SendFrame(uint8_t opcode, const uint8_t *data, size_t len);

	int timeout_ms_;
	intptr_t sock_;   // socket handle (SOCKET on Windows, int fd elsewhere); -1 when closed
	void *ssl_ctx_;   // SSL_CTX *
	void *ssl_;       // SSL *
	bool close_sent_; // destructor sends Close at most once
};

} // namespace duckdb
