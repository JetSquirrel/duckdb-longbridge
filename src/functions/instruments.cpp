#include "longbridge_extension.hpp"

#include "longbridge_client.hpp"

#include "duckdb/common/exception.hpp"
#include "duckdb/function/function_set.hpp"
#include "duckdb/function/table_function.hpp"
#include "duckdb/main/database.hpp"
#include "duckdb/main/extension/extension_loader.hpp"

#include "yyjson.hpp"

#include <algorithm>
#include <string>
#include <utility>
#include <vector>

namespace duckdb {

using duckdb_yyjson::unsafe_yyjson_get_next;
using duckdb_yyjson::yyjson_arr_get_first;
using duckdb_yyjson::yyjson_arr_size;
using duckdb_yyjson::yyjson_doc;
using duckdb_yyjson::yyjson_doc_free;
using duckdb_yyjson::yyjson_doc_get_root;
using duckdb_yyjson::yyjson_get_num;
using duckdb_yyjson::yyjson_get_str;
using duckdb_yyjson::yyjson_is_arr;
using duckdb_yyjson::yyjson_is_null;
using duckdb_yyjson::yyjson_is_num;
using duckdb_yyjson::yyjson_is_obj;
using duckdb_yyjson::yyjson_is_str;
using duckdb_yyjson::yyjson_obj_get;
using duckdb_yyjson::yyjson_val;

namespace {

// The static-info API accepts at most 500 symbols per request.
constexpr idx_t LONGBRIDGE_STATIC_MAX_SYMBOLS = 500;

Value GetStringValue(yyjson_val *obj, const char *key) {
	auto val = yyjson_obj_get(obj, key);
	if (!val || !yyjson_is_str(val)) {
		return Value(LogicalType::VARCHAR);
	}
	return Value(yyjson_get_str(val));
}

// Numeric price/amount fields arrive as JSON strings (e.g. "103.40413"); tolerate numbers,
// empty strings, null and missing keys.
Value GetDoubleValue(yyjson_val *obj, const char *key) {
	auto val = yyjson_obj_get(obj, key);
	if (!val || yyjson_is_null(val)) {
		return Value(LogicalType::DOUBLE);
	}
	if (yyjson_is_num(val)) {
		return Value::DOUBLE(yyjson_get_num(val));
	}
	if (yyjson_is_str(val)) {
		auto str = yyjson_get_str(val);
		if (str[0] == '\0') {
			return Value(LogicalType::DOUBLE);
		}
		try {
			return Value::DOUBLE(std::stod(str));
		} catch (std::exception &) {
			return Value(LogicalType::DOUBLE);
		}
	}
	return Value(LogicalType::DOUBLE);
}

Value GetIntegerValue(yyjson_val *obj, const char *key) {
	auto val = yyjson_obj_get(obj, key);
	if (!val || yyjson_is_null(val)) {
		return Value(LogicalType::INTEGER);
	}
	if (yyjson_is_num(val)) {
		return Value::INTEGER(static_cast<int32_t>(yyjson_get_num(val)));
	}
	if (yyjson_is_str(val)) {
		try {
			return Value::INTEGER(static_cast<int32_t>(std::stol(yyjson_get_str(val))));
		} catch (std::exception &) {
			return Value(LogicalType::INTEGER);
		}
	}
	return Value(LogicalType::INTEGER);
}

Value GetBigintValue(yyjson_val *obj, const char *key) {
	auto val = yyjson_obj_get(obj, key);
	if (!val || yyjson_is_null(val)) {
		return Value(LogicalType::BIGINT);
	}
	if (yyjson_is_num(val)) {
		return Value::BIGINT(static_cast<int64_t>(yyjson_get_num(val)));
	}
	if (yyjson_is_str(val)) {
		try {
			return Value::BIGINT(static_cast<int64_t>(std::stoll(yyjson_get_str(val))));
		} catch (std::exception &) {
			return Value(LogicalType::BIGINT);
		}
	}
	return Value(LogicalType::BIGINT);
}

struct InstrumentsBindData : public TableFunctionData {
	// Buffered result rows, one Value per output column.
	vector<vector<Value>> rows;

	unique_ptr<FunctionData> Copy() const override {
		return make_uniq<InstrumentsBindData>(*this);
	}
	bool Equals(const FunctionData &other) const override {
		return this == &other;
	}
};

struct InstrumentsGlobalState : public GlobalTableFunctionState {
	idx_t offset = 0;
};

unique_ptr<FunctionData> InstrumentsBind(ClientContext &context, TableFunctionBindInput &input,
                                         vector<LogicalType> &return_types, ColumnNames &names) {
	names = {"symbol",
	         "name_cn",
	         "name_en",
	         "name_hk",
	         "exchange",
	         "currency",
	         "lot_size",
	         "total_shares",
	         "circulating_shares",
	         "eps",
	         "eps_ttm",
	         "bps",
	         "dividend_yield",
	         "board"};
	return_types = {LogicalType::VARCHAR, LogicalType::VARCHAR, LogicalType::VARCHAR, LogicalType::VARCHAR,
	                LogicalType::VARCHAR, LogicalType::VARCHAR, LogicalType::INTEGER, LogicalType::BIGINT,
	                LogicalType::BIGINT,  LogicalType::DOUBLE,  LogicalType::DOUBLE,  LogicalType::DOUBLE,
	                LogicalType::DOUBLE,  LogicalType::VARCHAR};

	// Collect symbols from either the VARCHAR or the LIST(VARCHAR) overload.
	auto &arg = input.inputs[0];
	if (arg.IsNull()) {
		throw InvalidInputException("longbridge_instruments: symbol argument must not be NULL");
	}
	vector<std::string> symbols;
	if (arg.type().id() == LogicalTypeId::LIST) {
		auto &children = ListValue::GetChildren(arg);
		if (children.empty()) {
			throw InvalidInputException("longbridge_instruments: at least one symbol is required");
		}
		for (auto &child : children) {
			if (child.IsNull()) {
				throw InvalidInputException("longbridge_instruments: symbols must not be NULL");
			}
			symbols.push_back(StringValue::Get(child));
		}
	} else {
		symbols.push_back(StringValue::Get(arg));
	}
	for (auto &symbol : symbols) {
		if (symbol.empty()) {
			throw InvalidInputException("longbridge_instruments: symbols must not be empty");
		}
	}

	auto result = make_uniq<InstrumentsBindData>();

	// Fetch once per chunk of 500 symbols (the API limit) and buffer every row.
	LongbridgeClient client(DatabaseInstance::GetDatabase(context));
	for (idx_t offset = 0; offset < symbols.size(); offset += LONGBRIDGE_STATIC_MAX_SYMBOLS) {
		idx_t end = std::min(offset + LONGBRIDGE_STATIC_MAX_SYMBOLS, static_cast<idx_t>(symbols.size()));
		std::vector<std::pair<std::string, std::string>> params;
		params.reserve(end - offset);
		for (idx_t i = offset; i < end; i++) {
			params.emplace_back("symbol", symbols[i]);
		}

		unique_ptr<yyjson_doc, decltype(&yyjson_doc_free)> doc(client.Get("/v1/quote/static", params),
		                                                       &yyjson_doc_free);
		auto root = yyjson_doc_get_root(doc.get());
		if (!root || !yyjson_is_obj(root)) {
			throw IOException("Longbridge: unexpected response for /v1/quote/static (not a JSON object)");
		}
		// The gateways answer {"list": [...]}; LongPort's SecurityStaticInfoResponse names
		// the array secu_static_info.
		auto info = yyjson_obj_get(root, "list");
		if (!info) {
			info = yyjson_obj_get(root, "secu_static_info");
		}
		if (!info || !yyjson_is_arr(info)) {
			continue;
		}
		size_t arr_idx, arr_max;
		yyjson_val *item;
		yyjson_arr_foreach(info, arr_idx, arr_max, item) {
			if (!yyjson_is_obj(item)) {
				continue;
			}
			vector<Value> row;
			row.reserve(names.size());
			row.push_back(GetStringValue(item, "symbol"));
			row.push_back(GetStringValue(item, "name_cn"));
			row.push_back(GetStringValue(item, "name_en"));
			row.push_back(GetStringValue(item, "name_hk"));
			row.push_back(GetStringValue(item, "exchange"));
			row.push_back(GetStringValue(item, "currency"));
			row.push_back(GetIntegerValue(item, "lot_size"));
			row.push_back(GetBigintValue(item, "total_shares"));
			row.push_back(GetBigintValue(item, "circulating_shares"));
			row.push_back(GetDoubleValue(item, "eps"));
			row.push_back(GetDoubleValue(item, "eps_ttm"));
			row.push_back(GetDoubleValue(item, "bps"));
			row.push_back(GetDoubleValue(item, "dividend_yield"));
			row.push_back(GetStringValue(item, "board"));
			result->rows.push_back(std::move(row));
		}
	}
	return std::move(result);
}

unique_ptr<GlobalTableFunctionState> InstrumentsInitGlobal(ClientContext &context, TableFunctionInitInput &input) {
	return make_uniq<InstrumentsGlobalState>();
}

void InstrumentsFunction(ClientContext &context, TableFunctionInput &data_p, DataChunk &output) {
	auto &bind_data = data_p.bind_data->Cast<InstrumentsBindData>();
	auto &state = data_p.global_state->Cast<InstrumentsGlobalState>();

	idx_t count = 0;
	while (state.offset < bind_data.rows.size() && count < STANDARD_VECTOR_SIZE) {
		auto &row = bind_data.rows[state.offset++];
		for (idx_t col = 0; col < row.size(); col++) {
			SetOutputValue(output, col, count, row[col]);
		}
		count++;
	}
	FinishOutput(output, count);
}

} // namespace

void RegisterInstrumentFunctions(ExtensionLoader &loader) {
	TableFunctionSet instruments("longbridge_instruments");
	instruments.AddFunction(
	    TableFunction({LogicalType::VARCHAR}, InstrumentsFunction, InstrumentsBind, InstrumentsInitGlobal));
	instruments.AddFunction(TableFunction({LogicalType::LIST(LogicalType::VARCHAR)}, InstrumentsFunction,
	                                      InstrumentsBind, InstrumentsInitGlobal));
	loader.RegisterFunction(instruments);
}

} // namespace duckdb
