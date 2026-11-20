#define DUCKDB_EXTENSION_MAIN

#include "longbridge_extension.hpp"
#include "duckdb.hpp"
#include "duckdb/main/config.hpp"

namespace duckdb {

static void LoadInternal(ExtensionLoader &loader) {
	auto &config = DBConfig::GetConfig(loader.GetDatabaseInstance());
	// Options are registered with GLOBAL default scope so values set via `SET` are readable
	// from the client through DatabaseInstance::TryGetCurrentSetting.
	config.AddExtensionOption("longbridge_app_key", "Longbridge OpenAPI app key", LogicalType::VARCHAR, Value(),
	                          nullptr, SetScope::GLOBAL);
	config.AddExtensionOption("longbridge_app_secret", "Longbridge OpenAPI app secret", LogicalType::VARCHAR, Value(),
	                          nullptr, SetScope::GLOBAL);
	config.AddExtensionOption("longbridge_access_token", "Longbridge OpenAPI access token", LogicalType::VARCHAR,
	                          Value(), nullptr, SetScope::GLOBAL);
	config.AddExtensionOption("longbridge_region", "Longbridge API region ('cn' or 'hk')", LogicalType::VARCHAR,
	                          Value(), nullptr, SetScope::GLOBAL);
	config.AddExtensionOption("longbridge_base_url",
	                          "Longbridge OpenAPI base URL; overrides the region-based default. When set (or "
	                          "LONGBRIDGE_BASE_URL is exported), credentials are optional and requests are sent "
	                          "unsigned when they are absent",
	                          LogicalType::VARCHAR, Value(), nullptr, SetScope::GLOBAL);

	RegisterQuoteFunctions(loader);
	RegisterInstrumentFunctions(loader);
	RegisterBarsFunctions(loader);
	RegisterPortfolioFunctions(loader);
}

void LongbridgeExtension::Load(ExtensionLoader &loader) {
	LoadInternal(loader);
}

std::string LongbridgeExtension::Name() {
	return "longbridge";
}

std::string LongbridgeExtension::Version() const {
#ifdef EXT_VERSION_LONGBRIDGE
	return EXT_VERSION_LONGBRIDGE;
#else
	return "";
#endif
}

} // namespace duckdb

extern "C" {

DUCKDB_CPP_EXTENSION_ENTRY(longbridge, loader) {
	duckdb::LoadInternal(loader);
}
}
