#include "longbridge_client.hpp"
#include "longbridge_extension.hpp"

#include "duckdb/common/exception.hpp"
#include "duckdb/common/http_util.hpp"
#include "duckdb/main/database.hpp"

#include "yyjson.hpp"

#include <openssl/evp.h>
#include <openssl/hmac.h>

#include <cstdlib>
#include <ctime>

namespace duckdb {

using namespace duckdb_yyjson;

static constexpr uint64_t LONGBRIDGE_HTTP_TIMEOUT_SECONDS = 15;

static bool IsUnreserved(char c) {
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' ||
	       c == '.' || c == '~';
}

static std::string UrlEncode(const std::string &input) {
	static const char hex[] = "0123456789ABCDEF";
	std::string result;
	result.reserve(input.size());
	for (char c : input) {
		if (IsUnreserved(c)) {
			result.push_back(c);
		} else {
			result.push_back('%');
			result.push_back(hex[(static_cast<unsigned char>(c) >> 4) & 0xF]);
			result.push_back(hex[static_cast<unsigned char>(c) & 0xF]);
		}
	}
	return result;
}

static std::string ToLowerHex(const unsigned char *data, size_t len) {
	static const char hex[] = "0123456789abcdef";
	std::string result;
	result.reserve(len * 2);
	for (size_t i = 0; i < len; i++) {
		result.push_back(hex[(data[i] >> 4) & 0xF]);
		result.push_back(hex[data[i] & 0xF]);
	}
	return result;
}

static std::string Sha1Hex(const std::string &input) {
	unsigned char digest[EVP_MAX_MD_SIZE];
	size_t digest_len = 0;
	if (!EVP_Q_digest(nullptr, "SHA1", nullptr, input.data(), input.size(), digest, &digest_len)) {
		throw IOException("Longbridge: failed to compute SHA1 digest");
	}
	return ToLowerHex(digest, digest_len);
}

static std::string HmacSha256Hex(const std::string &key, const std::string &message) {
	unsigned char digest[EVP_MAX_MD_SIZE];
	unsigned int digest_len = 0;
	if (!HMAC(EVP_sha256(), key.data(), static_cast<int>(key.size()),
	          reinterpret_cast<const unsigned char *>(message.data()), message.size(), digest, &digest_len)) {
		throw IOException("Longbridge: failed to compute HMAC-SHA256 signature");
	}
	return ToLowerHex(digest, digest_len);
}

// Returns the value of a (global) extension option, or an empty string when unset/empty.
static std::string GetOptionValue(DatabaseInstance &db, const std::string &name) {
	Value value;
#ifdef LONGBRIDGE_DUCKDB_V2
	const Identifier setting(name);
#else
	const std::string &setting = name;
#endif
	if (db.TryGetCurrentSetting(setting, value) && !value.IsNull()) {
		auto str = value.ToString();
		if (!str.empty()) {
			return str;
		}
	}
	return std::string();
}

static std::string GetEnvValue(const std::vector<std::string> &names) {
	for (const auto &name : names) {
		const char *value = std::getenv(name.c_str());
		if (value && value[0] != '\0') {
			return std::string(value);
		}
	}
	return std::string();
}

LongbridgeClient::LongbridgeClient(DatabaseInstance &db) : db(db) {
	// Precedence: DuckDB extension option > environment variable (LONGBRIDGE_*, legacy LONGPORT_*).
	app_key = GetOptionValue(db, "longbridge_app_key");
	if (app_key.empty()) {
		app_key = GetEnvValue({"LONGBRIDGE_APP_KEY", "LONGPORT_APP_KEY"});
	}
	app_secret = GetOptionValue(db, "longbridge_app_secret");
	if (app_secret.empty()) {
		app_secret = GetEnvValue({"LONGBRIDGE_APP_SECRET", "LONGPORT_APP_SECRET"});
	}
	access_token = GetOptionValue(db, "longbridge_access_token");
	if (access_token.empty()) {
		access_token = GetEnvValue({"LONGBRIDGE_ACCESS_TOKEN", "LONGPORT_ACCESS_TOKEN"});
	}

	// Base URL: explicit option/env (sidecar mode) > region-based default.
	base_url = GetOptionValue(db, "longbridge_base_url");
	if (base_url.empty()) {
		base_url = GetEnvValue({"LONGBRIDGE_BASE_URL"});
	}
	explicit_base_url = !base_url.empty();
	if (!explicit_base_url) {
		auto region = GetOptionValue(db, "longbridge_region");
		if (region.empty()) {
			region = GetEnvValue({"LONGBRIDGE_REGION"});
		}
		base_url = (region == "cn") ? "https://openapi.longbridge.cn" : "https://openapi.longbridge.com";
	}
	while (!base_url.empty() && base_url.back() == '/') {
		base_url.pop_back();
	}
}

LongbridgeClient::~LongbridgeClient() = default;

yyjson_doc *LongbridgeClient::Get(const std::string &path,
                                  const std::vector<std::pair<std::string, std::string>> &params) {
	const bool has_credentials = !app_key.empty() && !app_secret.empty() && !access_token.empty();
	if (!has_credentials && !explicit_base_url) {
		throw InvalidInputException(
		    "Longbridge credentials are not configured. Either SET the extension options, e.g. "
		    "SET longbridge_app_key = '<key>'; SET longbridge_app_secret = '<secret>'; "
		    "SET longbridge_access_token = '<token>'; or export the LONGBRIDGE_APP_KEY, LONGBRIDGE_APP_SECRET and "
		    "LONGBRIDGE_ACCESS_TOKEN environment variables (legacy LONGPORT_* variants are also accepted). "
		    "Alternatively, point longbridge_base_url at a gateway that does not require authentication.");
	}

	// Build the (ordered) query string; values are URL-encoded.
	std::string query;
	for (const auto &kv : params) {
		if (!query.empty()) {
			query.push_back('&');
		}
		query += UrlEncode(kv.first);
		query.push_back('=');
		query += UrlEncode(kv.second);
	}

	HTTPHeaders headers(db);
	if (has_credentials) {
		// Sign the request (legacy API-key scheme).
		const std::string method = "GET";
		const std::string timestamp = std::to_string(static_cast<long long>(std::time(nullptr)));
		const std::string signed_headers = "authorization;x-api-key;x-timestamp";
		std::string canonical = method + "|" + path + "|" + query + "|" + "authorization:" + access_token + "\n" +
		                        "x-api-key:" + app_key + "\n" + "x-timestamp:" + timestamp + "\n" + "|" +
		                        signed_headers + "|";
		// GET requests carry no body, so no body SHA1 is appended.
		const std::string sign_str = "HMAC-SHA256|" + Sha1Hex(canonical);
		const std::string signature = HmacSha256Hex(app_secret, sign_str);
		const std::string signature_header = "HMAC-SHA256 SignedHeaders=" + signed_headers + ", Signature=" + signature;

		headers.Insert("x-api-key", app_key);
		headers.Insert("authorization", access_token);
		headers.Insert("x-timestamp", timestamp);
		headers.Insert("x-api-signature", signature_header);
	}

	// Perform the request through duckdb::HTTPUtil (natively the built-in httplib client,
	// in duckdb-wasm the globally overridden sync-XHR implementation).
	const std::string url = query.empty() ? base_url + path : base_url + path + "?" + query;

	auto &http_util = HTTPUtil::Get(db);
	auto http_params = http_util.InitializeParameters(db, url);
	http_params->timeout = LONGBRIDGE_HTTP_TIMEOUT_SECONDS;

	GetRequestInfo request(url, headers, *http_params, nullptr, nullptr);
	// Return failed requests to us instead of throwing so the error can be wrapped with
	// the full URL (duckdb-wasm reports CORS/network failures opaquely).
	request.try_request = true;

	unique_ptr<HTTPResponse> response;
	try {
		response = http_util.Request(request);
	} catch (std::exception &e) {
		throw IOException("Longbridge HTTP GET to %s failed: %s", url, e.what());
	}
	if (!response) {
		throw IOException("Longbridge HTTP GET to %s failed: no response", url);
	}
	if (response->HasRequestError()) {
		throw IOException("Longbridge HTTP GET to %s failed: %s", url, response->GetRequestError());
	}
	if (response->status != HTTPStatusCode::OK_200) {
		throw IOException("Longbridge HTTP request to %s returned status %d: %s", url,
		                  static_cast<int>(response->status), response->body);
	}

	// Parse the response envelope {"code":0,"message":"success","data":{...}}.
	yyjson_doc *envelope = yyjson_read(response->body.data(), response->body.size(), 0);
	if (!envelope) {
		throw IOException("Longbridge: failed to parse API response as JSON: %s", response->body);
	}
	yyjson_val *root = yyjson_doc_get_root(envelope);
	yyjson_val *code = yyjson_obj_get(root, "code");
	if (!code || !yyjson_is_num(code) || yyjson_get_sint(code) != 0) {
		std::string message = "unknown error";
		yyjson_val *message_val = yyjson_obj_get(root, "message");
		if (message_val && yyjson_is_str(message_val)) {
			message = yyjson_get_str(message_val);
		}
		const auto code_str = code && yyjson_is_num(code) ? std::to_string(yyjson_get_sint(code)) : "?";
		yyjson_doc_free(envelope);
		throw IOException("Longbridge API error (code %s): %s", code_str, message);
	}

	// Hand ownership of a self-contained "data" document to the caller: serialize the data
	// subtree out of the envelope and re-parse it into a fresh document.
	yyjson_val *data = yyjson_obj_get(root, "data");
	size_t data_len = 0;
	char *data_json = data ? yyjson_val_write(data, 0, &data_len) : nullptr;
	yyjson_doc_free(envelope);
	if (!data_json) {
		return yyjson_read("null", 4, 0);
	}
	yyjson_doc *result = yyjson_read(data_json, data_len, 0);
	free(data_json);
	if (!result) {
		throw IOException("Longbridge: failed to parse API response data payload as JSON");
	}
	return result;
}

} // namespace duckdb
