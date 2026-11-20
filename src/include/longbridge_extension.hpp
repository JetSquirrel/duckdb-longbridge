#pragma once

#include "duckdb.hpp"

// The extension builds against DuckDB 2.0 (the community repository) and v1.5.4 (the
// demo's wasm build). 2.0 is told apart by its Identifier header: it names columns and
// settings with Identifier rather than std::string, and fills table-function output by
// appending to each column vector.
#if __has_include("duckdb/common/identifier.hpp")
#include "duckdb/common/identifier.hpp"
#define LONGBRIDGE_DUCKDB_V2 1
#endif

namespace duckdb {

#ifdef LONGBRIDGE_DUCKDB_V2
//! The column-name vector a table function's bind fills in.
using ColumnNames = vector<Identifier>;
#else
using ColumnNames = vector<string>;
#endif

//! Write `value` into column `col` of row `row` of a table function's output. Rows must
//! be written in order, each column once per row.
inline void SetOutputValue(DataChunk &output, idx_t col, idx_t row, const Value &value) {
#ifdef LONGBRIDGE_DUCKDB_V2
	(void)row;
	output.data[col].Append(value);
#else
	output.SetValue(col, row, value);
#endif
}

//! Close a table function's output after `count` rows were written with SetOutputValue.
inline void FinishOutput(DataChunk &output, idx_t count) {
#ifdef LONGBRIDGE_DUCKDB_V2
	output.CheckCardinality(count);
#else
	output.SetCardinality(count);
#endif
}

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
