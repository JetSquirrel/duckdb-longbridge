#include "ws_client.hpp"

#include "duckdb/common/exception.hpp"

#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <openssl/ssl.h>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "ws2_32.lib")
#else
#include <cerrno>
#include <netdb.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
#endif

#include <chrono>
#include <cstring>

namespace duckdb {

namespace {

// RFC6455 magic GUID appended to Sec-WebSocket-Key for the Accept digest.
constexpr const char *WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
// Sanity cap on a single (reassembled) WebSocket message.
constexpr size_t WS_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
// Cap on the HTTP upgrade response header block.
constexpr size_t WS_MAX_HEADER_BYTES = 16 * 1024;

constexpr uint8_t WS_OPCODE_CONTINUATION = 0x0;
constexpr uint8_t WS_OPCODE_TEXT = 0x1;
constexpr uint8_t WS_OPCODE_BINARY = 0x2;
constexpr uint8_t WS_OPCODE_CLOSE = 0x8;
constexpr uint8_t WS_OPCODE_PING = 0x9;
constexpr uint8_t WS_OPCODE_PONG = 0xA;

void CloseSocketHandle(intptr_t sock) {
#ifdef _WIN32
	closesocket(static_cast<SOCKET>(sock));
#else
	close(static_cast<int>(sock));
#endif
}

void SetSocketTimeouts(intptr_t sock, int timeout_ms) {
#ifdef _WIN32
	DWORD ms = static_cast<DWORD>(timeout_ms);
	setsockopt(static_cast<SOCKET>(sock), SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char *>(&ms), sizeof(ms));
	setsockopt(static_cast<SOCKET>(sock), SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char *>(&ms), sizeof(ms));
#else
	struct timeval tv;
	tv.tv_sec = timeout_ms / 1000;
	tv.tv_usec = (timeout_ms % 1000) * 1000;
	int fd = static_cast<int>(sock);
	setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
	setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
#endif
}

std::string LastSocketError() {
#ifdef _WIN32
	return "WSA error " + std::to_string(WSAGetLastError());
#else
	return std::strerror(errno);
#endif
}

bool IsTimeoutError() {
#ifdef _WIN32
	return WSAGetLastError() == WSAETIMEDOUT || WSAGetLastError() == WSAEWOULDBLOCK;
#else
	return errno == EAGAIN || errno == EWOULDBLOCK;
#endif
}

std::string SslErrorString() {
	unsigned long err = ERR_get_error();
	if (err == 0) {
		return "unknown TLS error";
	}
	char buf[256];
	ERR_error_string_n(err, buf, sizeof(buf));
	return buf;
}

std::string Base64Encode(const uint8_t *data, size_t len) {
	std::string out(4 * ((len + 2) / 3), '\0');
	int written = EVP_EncodeBlock(reinterpret_cast<unsigned char *>(&out[0]), data, static_cast<int>(len));
	out.resize(static_cast<size_t>(written));
	return out;
}

std::string Sha1Base64(const std::string &input) {
	unsigned char digest[EVP_MAX_MD_SIZE];
	size_t digest_len = 0;
	if (!EVP_Q_digest(nullptr, "SHA1", nullptr, input.data(), input.size(), digest, &digest_len)) {
		throw IOException("WsClient: failed to compute SHA1 digest");
	}
	return Base64Encode(digest, digest_len);
}

std::string ToLower(std::string s) {
	for (auto &c : s) {
		if (c >= 'A' && c <= 'Z') {
			c = static_cast<char>(c - 'A' + 'a');
		}
	}
	return s;
}

std::string Trim(const std::string &s) {
	size_t begin = s.find_first_not_of(" \t\r\n");
	if (begin == std::string::npos) {
		return "";
	}
	size_t end = s.find_last_not_of(" \t\r\n");
	return s.substr(begin, end - begin + 1);
}

// Case-insensitive lookup of a header value within a raw HTTP header block.
std::string FindHeader(const std::string &headers, const std::string &name) {
	std::string lower = ToLower(headers);
	std::string needle = ToLower(name) + ":";
	size_t pos = 0;
	while ((pos = lower.find(needle, pos)) != std::string::npos) {
		// Header name must start at the beginning of a line.
		if (pos == 0 || lower[pos - 1] == '\n') {
			size_t value_begin = pos + needle.size();
			size_t value_end = lower.find("\r\n", value_begin);
			if (value_end == std::string::npos) {
				value_end = lower.size();
			}
			return Trim(headers.substr(value_begin, value_end - value_begin));
		}
		pos += needle.size();
	}
	return "";
}

#ifdef _WIN32
void EnsureWsaStartup() {
	static bool initialized = [] {
		WSADATA wsa_data;
		return WSAStartup(MAKEWORD(2, 2), &wsa_data) == 0;
	}();
	if (!initialized) {
		throw IOException("WsClient: WSAStartup failed");
	}
}
#endif

} // namespace

WsClient::WsClient(const std::string &host, const std::string &port, const std::string &path_with_query, int timeout_ms)
    : timeout_ms_(timeout_ms), sock_(-1), ssl_ctx_(nullptr), ssl_(nullptr), close_sent_(false) {
	if (timeout_ms_ <= 0) {
		throw IOException("WsClient: timeout_ms must be positive");
	}
	try {
		ConnectTcp(host, port);
		ConnectTls(host);
		Handshake(host, port, path_with_query);
	} catch (...) {
		// Avoid leaking the socket/TLS state when the constructor fails midway;
		// the destructor never runs for a failed constructor.
		if (ssl_) {
			SSL_free(static_cast<SSL *>(ssl_));
			ssl_ = nullptr;
		}
		if (ssl_ctx_) {
			SSL_CTX_free(static_cast<SSL_CTX *>(ssl_ctx_));
			ssl_ctx_ = nullptr;
		}
		if (sock_ != -1) {
			CloseSocketHandle(sock_);
			sock_ = -1;
		}
		throw;
	}
}

WsClient::~WsClient() {
	// Best-effort WS Close frame; never throw from a destructor.
	try {
		if (ssl_ && !close_sent_) {
			SendFrame(WS_OPCODE_CLOSE, nullptr, 0);
		}
	} catch (...) {
	}
	if (ssl_) {
		SSL_shutdown(static_cast<SSL *>(ssl_));
		SSL_free(static_cast<SSL *>(ssl_));
		ssl_ = nullptr;
	}
	if (ssl_ctx_) {
		SSL_CTX_free(static_cast<SSL_CTX *>(ssl_ctx_));
		ssl_ctx_ = nullptr;
	}
	if (sock_ != -1) {
		CloseSocketHandle(sock_);
		sock_ = -1;
	}
}

void WsClient::ConnectTcp(const std::string &host, const std::string &port) {
#ifdef _WIN32
	EnsureWsaStartup();
#endif
	struct addrinfo hints;
	std::memset(&hints, 0, sizeof(hints));
	hints.ai_family = AF_UNSPEC;
	hints.ai_socktype = SOCK_STREAM;

	struct addrinfo *addresses = nullptr;
	int gai = getaddrinfo(host.c_str(), port.c_str(), &hints, &addresses);
	if (gai != 0 || !addresses) {
		throw IOException("WsClient: failed to resolve " + host + ":" + port + " (" + gai_strerror(gai) + ")");
	}

	std::string last_error;
	for (struct addrinfo *addr = addresses; addr; addr = addr->ai_next) {
		intptr_t candidate = static_cast<intptr_t>(socket(addr->ai_family, addr->ai_socktype, addr->ai_protocol));
		if (candidate == -1) {
			last_error = LastSocketError();
			continue;
		}
		SetSocketTimeouts(candidate, timeout_ms_);
		if (connect(static_cast<int>(candidate), addr->ai_addr, static_cast<int>(addr->ai_addrlen)) == 0) {
			sock_ = candidate;
			break;
		}
		last_error = LastSocketError();
		CloseSocketHandle(candidate);
	}
	freeaddrinfo(addresses);

	if (sock_ == -1) {
		throw IOException("WsClient: failed to connect to " + host + ":" + port + ": " + last_error);
	}
}

void WsClient::ConnectTls(const std::string &host) {
	const SSL_METHOD *method = TLS_client_method();
	ssl_ctx_ = SSL_CTX_new(method);
	if (!ssl_ctx_) {
		throw IOException("WsClient: failed to create TLS context: " + SslErrorString());
	}

	SSL *ssl = SSL_new(static_cast<SSL_CTX *>(ssl_ctx_));
	if (!ssl) {
		throw IOException("WsClient: failed to create TLS session: " + SslErrorString());
	}
	ssl_ = ssl;

	// Load the system trust store. SSL_set1_default_verify_paths is the per-connection variant
	// but only exists on LibreSSL; OpenSSL uses the context-wide call.
#if defined(LIBRESSL_VERSION_NUMBER)
	if (SSL_set1_default_verify_paths(ssl) != 1 &&
	    SSL_CTX_set_default_verify_paths(static_cast<SSL_CTX *>(ssl_ctx_)) != 1) {
		throw IOException("WsClient: failed to load default CA trust store: " + SslErrorString());
	}
#else
	if (SSL_CTX_set_default_verify_paths(static_cast<SSL_CTX *>(ssl_ctx_)) != 1) {
		throw IOException("WsClient: failed to load default CA trust store: " + SslErrorString());
	}
#endif

	if (SSL_set_tlsext_host_name(ssl, host.c_str()) != 1) {
		throw IOException("WsClient: failed to set SNI host name: " + SslErrorString());
	}
	// Enable hostname verification against the peer certificate.
	if (SSL_set1_host(ssl, host.c_str()) != 1) {
		throw IOException("WsClient: failed to set TLS verification host: " + SslErrorString());
	}
	SSL_set_verify(ssl, SSL_VERIFY_PEER, nullptr);

	if (SSL_set_fd(ssl, static_cast<int>(sock_)) != 1) {
		throw IOException("WsClient: failed to attach TLS session to socket: " + SslErrorString());
	}

	if (SSL_connect(ssl) != 1) {
		int ssl_err = SSL_get_error(ssl, -1);
		if (ssl_err == SSL_ERROR_SYSCALL && IsTimeoutError()) {
			throw IOException("WsClient: TLS handshake timed out connecting to " + host);
		}
		throw IOException("WsClient: TLS handshake with " + host + " failed: " + SslErrorString());
	}
}

void WsClient::Handshake(const std::string &host, const std::string &port, const std::string &path_with_query) {
	uint8_t key_bytes[16];
	if (RAND_bytes(key_bytes, sizeof(key_bytes)) != 1) {
		throw IOException("WsClient: failed to generate Sec-WebSocket-Key: " + SslErrorString());
	}
	std::string key = Base64Encode(key_bytes, sizeof(key_bytes));

	std::string request = "GET " + path_with_query +
	                      " HTTP/1.1\r\n"
	                      "Host: " +
	                      host + ":" + port +
	                      "\r\n"
	                      "Upgrade: websocket\r\n"
	                      "Connection: Upgrade\r\n"
	                      "Sec-WebSocket-Key: " +
	                      key +
	                      "\r\n"
	                      "Sec-WebSocket-Version: 13\r\n"
	                      "\r\n";
	WriteAll(reinterpret_cast<const uint8_t *>(request.data()), request.size());

	// Read the response header block byte-by-byte so we never over-read into WebSocket frames.
	std::string headers;
	headers.reserve(1024);
	for (;;) {
		uint8_t byte = 0;
		ReadExact(&byte, 1);
		headers.push_back(static_cast<char>(byte));
		if (headers.size() >= 4 && headers.compare(headers.size() - 4, 4, "\r\n\r\n") == 0) {
			break;
		}
		if (headers.size() >= WS_MAX_HEADER_BYTES) {
			throw IOException("WsClient: WebSocket upgrade response headers exceed size limit");
		}
	}

	size_t line_end = headers.find("\r\n");
	std::string status_line = line_end == std::string::npos ? headers : headers.substr(0, line_end);
	if (status_line.find(" 101") == std::string::npos) {
		throw IOException("WsClient: WebSocket upgrade rejected by server: " + status_line);
	}

	std::string accept = FindHeader(headers, "Sec-WebSocket-Accept");
	if (accept.empty()) {
		throw IOException("WsClient: WebSocket upgrade response is missing Sec-WebSocket-Accept");
	}
	std::string expected = Sha1Base64(key + WS_GUID);
	if (accept != expected) {
		throw IOException("WsClient: Sec-WebSocket-Accept mismatch (server is not a valid RFC6455 endpoint)");
	}
}

void WsClient::SendBinary(const std::vector<uint8_t> &payload) {
	SendFrame(WS_OPCODE_BINARY, payload.empty() ? nullptr : payload.data(), payload.size());
}

void WsClient::SendFrame(uint8_t opcode, const uint8_t *data, size_t len) {
	uint8_t header[14];
	size_t header_len = 0;
	header[header_len++] = static_cast<uint8_t>(0x80 | (opcode & 0x0F)); // FIN set, no RSV
	// Client frames must be masked.
	if (len < 126) {
		header[header_len++] = static_cast<uint8_t>(0x80 | len);
	} else if (len <= 0xFFFF) {
		header[header_len++] = static_cast<uint8_t>(0x80 | 126);
		header[header_len++] = static_cast<uint8_t>((len >> 8) & 0xFF);
		header[header_len++] = static_cast<uint8_t>(len & 0xFF);
	} else {
		header[header_len++] = static_cast<uint8_t>(0x80 | 127);
		for (int shift = 56; shift >= 0; shift -= 8) {
			header[header_len++] = static_cast<uint8_t>((static_cast<uint64_t>(len) >> shift) & 0xFF);
		}
	}
	uint8_t mask[4];
	if (RAND_bytes(mask, sizeof(mask)) != 1) {
		throw IOException("WsClient: failed to generate frame mask: " + SslErrorString());
	}
	std::memcpy(header + header_len, mask, sizeof(mask));
	header_len += sizeof(mask);

	WriteAll(header, header_len);
	if (len > 0) {
		// Copy the payload so the caller's buffer is not mutated by masking.
		std::vector<uint8_t> masked(data, data + len);
		for (size_t i = 0; i < len; i++) {
			masked[i] ^= mask[i % 4];
		}
		WriteAll(masked.data(), len);
	}
	if (opcode == WS_OPCODE_CLOSE) {
		close_sent_ = true;
	}
}

std::vector<uint8_t> WsClient::RecvBinary() {
	std::vector<uint8_t> message;
	bool in_message = false;

	for (;;) {
		uint8_t frame_header[2];
		ReadExact(frame_header, sizeof(frame_header));
		bool fin = (frame_header[0] & 0x80) != 0;
		uint8_t opcode = frame_header[0] & 0x0F;
		if (frame_header[0] & 0x70) {
			throw IOException("WsClient: server sent a frame with reserved bits set (no extensions negotiated)");
		}
		bool masked = (frame_header[1] & 0x80) != 0;
		uint64_t payload_len = frame_header[1] & 0x7F;
		if (payload_len == 126) {
			uint8_t ext[2];
			ReadExact(ext, sizeof(ext));
			payload_len = (static_cast<uint64_t>(ext[0]) << 8) | ext[1];
		} else if (payload_len == 127) {
			uint8_t ext[8];
			ReadExact(ext, sizeof(ext));
			payload_len = 0;
			for (int i = 0; i < 8; i++) {
				payload_len = (payload_len << 8) | ext[i];
			}
			if (payload_len & (static_cast<uint64_t>(1) << 63)) {
				throw IOException("WsClient: server sent an invalid 64-bit payload length");
			}
		}
		if (payload_len > WS_MAX_MESSAGE_BYTES) {
			throw IOException("WsClient: server frame exceeds the 64MB message size cap");
		}

		bool is_control = (opcode & 0x8) != 0;
		if (is_control && (!fin || payload_len > 125)) {
			throw IOException("WsClient: server sent an invalid control frame");
		}

		uint8_t mask[4] = {0, 0, 0, 0};
		if (masked) {
			// Server frames should be unmasked per RFC6455; be lenient and unmask if needed.
			ReadExact(mask, sizeof(mask));
		}

		std::vector<uint8_t> payload(static_cast<size_t>(payload_len));
		if (payload_len > 0) {
			ReadExact(payload.data(), payload.size());
			if (masked) {
				for (size_t i = 0; i < payload.size(); i++) {
					payload[i] ^= mask[i % 4];
				}
			}
		}

		switch (opcode) {
		case WS_OPCODE_CLOSE: {
			uint16_t code = 1005;
			std::string reason;
			if (payload.size() >= 2) {
				code = static_cast<uint16_t>((payload[0] << 8) | payload[1]);
				reason.assign(reinterpret_cast<const char *>(payload.data() + 2), payload.size() - 2);
			}
			throw IOException("WsClient: server closed the WebSocket (code " + std::to_string(code) +
			                  (reason.empty() ? ")" : ", reason: " + reason + ")"));
		}
		case WS_OPCODE_PING:
			SendFrame(WS_OPCODE_PONG, payload.empty() ? nullptr : payload.data(), payload.size());
			break;
		case WS_OPCODE_PONG:
			break; // ignored
		case WS_OPCODE_TEXT:
		case WS_OPCODE_BINARY:
			if (in_message) {
				throw IOException("WsClient: server started a new message before finishing the fragmented one");
			}
			in_message = true;
			message = std::move(payload);
			if (fin) {
				return message;
			}
			break;
		case WS_OPCODE_CONTINUATION:
			if (!in_message) {
				throw IOException("WsClient: server sent a continuation frame without an initial frame");
			}
			if (message.size() + payload.size() > WS_MAX_MESSAGE_BYTES) {
				throw IOException("WsClient: reassembled message exceeds the 64MB size cap");
			}
			message.insert(message.end(), payload.begin(), payload.end());
			if (fin) {
				return message;
			}
			break;
		default:
			throw IOException("WsClient: server sent unsupported opcode " + std::to_string(opcode));
		}
	}
}

void WsClient::WriteAll(const uint8_t *data, size_t len) {
	SSL *ssl = static_cast<SSL *>(ssl_);
	auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms_);
	size_t written = 0;
	while (written < len) {
		int ret = SSL_write(ssl, data + written, static_cast<int>(len - written));
		if (ret > 0) {
			written += static_cast<size_t>(ret);
			continue;
		}
		int ssl_err = SSL_get_error(ssl, ret);
		if (ssl_err == SSL_ERROR_WANT_WRITE || ssl_err == SSL_ERROR_WANT_READ) {
			if (std::chrono::steady_clock::now() >= deadline) {
				throw IOException("WsClient: timed out writing to the WebSocket");
			}
			continue;
		}
		if (ssl_err == SSL_ERROR_SYSCALL && IsTimeoutError()) {
			throw IOException("WsClient: timed out writing to the WebSocket");
		}
		throw IOException("WsClient: failed to write to the WebSocket: " + SslErrorString());
	}
}

void WsClient::ReadExact(uint8_t *data, size_t len) {
	SSL *ssl = static_cast<SSL *>(ssl_);
	auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms_);
	size_t received = 0;
	while (received < len) {
		int ret = SSL_read(ssl, data + received, static_cast<int>(len - received));
		if (ret > 0) {
			received += static_cast<size_t>(ret);
			continue;
		}
		int ssl_err = SSL_get_error(ssl, ret);
		if (ssl_err == SSL_ERROR_WANT_READ || ssl_err == SSL_ERROR_WANT_WRITE) {
			if (std::chrono::steady_clock::now() >= deadline) {
				throw IOException("WsClient: timed out reading from the WebSocket");
			}
			continue;
		}
		if (ssl_err == SSL_ERROR_ZERO_RETURN || (ssl_err == SSL_ERROR_SYSCALL && ret == 0)) {
			throw IOException("WsClient: connection closed by the server while reading");
		}
		if (ssl_err == SSL_ERROR_SYSCALL && IsTimeoutError()) {
			throw IOException("WsClient: timed out reading from the WebSocket");
		}
		throw IOException("WsClient: failed to read from the WebSocket: " + SslErrorString());
	}
}

} // namespace duckdb
