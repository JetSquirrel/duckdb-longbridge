#pragma once

#include "duckdb.hpp"

// DuckDB 2.0 names columns and settings with Identifier (case-insensitive) rather
// than std::string. The demo's wasm build still targets v1.5.4, so build against both.
#if __has_include("duckdb/common/identifier.hpp")
#include "duckdb/common/identifier.hpp"
#define LONGBRIDGE_HAS_IDENTIFIER 1
#endif

namespace duckdb {

#ifdef LONGBRIDGE_HAS_IDENTIFIER
//! The column-name vector a table function's bind fills in.
using ColumnNames = vector<Identifier>;
#else
using ColumnNames = vector<string>;
#endif

class LongbridgeExtension : public Extension {
public:
	void Load(ExtensionLoader &db) override;
	std::string Name() override;
	std::string Version() const override;
};

void RegisterQuoteFunctions(ExtensionLoader &loader);
void RegisterInstrumentFunctions(ExtensionLoader &loader);
void RegisterBarsFunctions(ExtensionLoader &loader);
void RegisterPortfolioFunctions(ExtensionLoader &loader);

} // namespace duckdb
