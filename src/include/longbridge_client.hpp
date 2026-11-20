#pragma once

#include "duckdb.hpp"

#include <string>
#include <utility>
#include <vector>

namespace duckdb_yyjson {
struct yyjson_doc;
}

namespace duckdb {

using duckdb_yyjson::yyjson_doc;

// Core HTTP/auth layer for the Longbridge OpenAPI.
//
// All HTTP goes through duckdb::HTTPUtil, which duckdb-wasm globally overrides with a
// sync-XHR based implementation, so the same code path works natively and in the browser.
//
// Configuration is resolved in the constructor with the following precedence:
//   1. DuckDB extension options: longbridge_base_url, longbridge_app_key,
//      longbridge_app_secret, longbridge_access_token, longbridge_region (set via SQL `SET`).
//   2. Environment variables: LONGBRIDGE_BASE_URL, LONGBRIDGE_APP_KEY / LONGPORT_APP_KEY,
//      LONGBRIDGE_APP_SECRET / LONGPORT_APP_SECRET,
//      LONGBRIDGE_ACCESS_TOKEN / LONGPORT_ACCESS_TOKEN, LONGBRIDGE_REGION.
// When longbridge_base_url is explicitly set (option or env) it is used as-is ("sidecar
// mode"): credentials become optional and requests are sent unsigned when they are absent.
// Otherwise region "cn" selects https://openapi.longbridge.cn, anything else
// https://openapi.longbridge.com, and credentials are required.
class LongbridgeClient {
public:
	explicit LongbridgeClient(DatabaseInstance &db);
	~LongbridgeClient();

	// Performs a GET (HMAC-SHA256 signed when credentials are configured, unsigned
	// otherwise). path like "/v1/quote/quote". params = ordered query pairs,
	// repeated keys allowed (e.g. multiple symbol=...). Returns the "data" member of the
	// response envelope (ownership transferred). Throws duckdb::IOException with the
	// server code/message when envelope code != 0 or on HTTP/network errors.
	//
	// Lifetime: the returned yyjson_doc is a fresh, self-contained document (the "data"
	// subtree is serialized from the response envelope and re-parsed) whose root is the
	// data payload. It is independent of the client and of the response buffer; the caller
	// owns it and must free it with yyjson_doc_free().
	yyjson_doc *Get(const std::string &path, const std::vector<std::pair<std::string, std::string>> &params);

private:
	DatabaseInstance &db;
	std::string app_key, app_secret, access_token, base_url;
	//! True when base_url came from longbridge_base_url / LONGBRIDGE_BASE_URL (sidecar mode)
	bool explicit_base_url = false;
};

} // namespace duckdb
