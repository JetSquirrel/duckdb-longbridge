#include "longbridge_extension.hpp"

#include "longbridge_client.hpp"

#include "duckdb/common/exception.hpp"
#include "duckdb/common/types/timestamp.hpp"
#include "duckdb/common/types/value.hpp"
#include "duckdb/function/function_set.hpp"
#include "duckdb/function/table_function.hpp"
#include "duckdb/main/client_context.hpp"
#include "duckdb/main/database.hpp"

#include "yyjson.hpp"

#include <algorithm>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace duckdb {

namespace {

// GET /v1/quote/quote accepts at most 500 symbols per request.
constexpr idx_t LONGBRIDGE_QUOTE_MAX_SYMBOLS_PER_REQUEST = 500;

struct YyjsonDocDeleter {
	void operator()(yyjson_doc *doc) const {
		if (doc) {
			duckdb_yyjson::yyjson_doc_free(doc);
		}
	}
};
using YyjsonDocPtr = std::unique_ptr<yyjson_doc, YyjsonDocDeleter>;

struct QuoteBindData : public TableFunctionData {
	std::vector<std::string> symbols;

	unique_ptr<FunctionData> Copy() const override {
		auto result = make_uniq<QuoteBindData>();
		result->symbols = symbols;
		return std::move(result);
	}
	bool Equals(const FunctionData &other_p) const override {
		auto &other = other_p.Cast<QuoteBindData>();
		return symbols == other.symbols;
	}
};

struct QuoteRow {
	Value symbol;
	Value last_done;
	Value prev_close;
	Value open;
	Value high;
	Value low;
	Value timestamp;
	Value volume;
	Value turnover;
	Value trade_status;
};

struct QuoteGlobalState : public GlobalTableFunctionState {
	std::vector<QuoteRow> rows;
	idx_t offset = 0;
};

// Numeric price/amount fields are returned as JSON strings (e.g. "338.000").
Value GetDoubleField(duckdb_yyjson::yyjson_val *obj, const char *key) {
	auto val = duckdb_yyjson::yyjson_obj_get(obj, key);
	if (!val || duckdb_yyjson::yyjson_is_null(val)) {
		return Value(LogicalType::DOUBLE);
	}
	if (duckdb_yyjson::yyjson_is_str(val)) {
		auto str = duckdb_yyjson::yyjson_get_str(val);
		if (!str || str[0] == '\0') {
			return Value(LogicalType::DOUBLE);
		}
		try {
			return Value::DOUBLE(std::stod(str));
		} catch (...) {
			return Value(LogicalType::DOUBLE);
		}
	}
	if (duckdb_yyjson::yyjson_is_num(val)) {
		return Value::DOUBLE(duckdb_yyjson::yyjson_get_num(val));
	}
	return Value(LogicalType::DOUBLE);
}

bool TryGetInt64(duckdb_yyjson::yyjson_val *obj, const char *key, int64_t &result) {
	auto val = duckdb_yyjson::yyjson_obj_get(obj, key);
	if (!val || duckdb_yyjson::yyjson_is_null(val)) {
		return false;
	}
	if (duckdb_yyjson::yyjson_is_int(val)) {
		result = duckdb_yyjson::yyjson_get_sint(val);
		return true;
	}
	if (duckdb_yyjson::yyjson_is_num(val)) {
		result = static_cast<int64_t>(duckdb_yyjson::yyjson_get_num(val));
		return true;
	}
	return false;
}

unique_ptr<FunctionData> LongbridgeQuoteBind(ClientContext &, TableFunctionBindInput &input,
                                             vector<LogicalType> &return_types, ColumnNames &names) {
	auto result = make_uniq<QuoteBindData>();

	auto &arg = input.inputs[0];
	if (arg.IsNull()) {
		throw InvalidInputException("longbridge_quote: symbol must not be NULL");
	}
	if (arg.type().id() == LogicalTypeId::LIST) {
		for (auto &child : ListValue::GetChildren(arg)) {
			if (child.IsNull()) {
				throw InvalidInputException("longbridge_quote: symbol list must not contain NULL elements");
			}
			result->symbols.push_back(child.ToString());
		}
		if (result->symbols.empty()) {
			throw InvalidInputException("longbridge_quote: symbol list must contain at least one symbol");
		}
	} else {
		result->symbols.push_back(arg.ToString());
	}

	names.emplace_back("symbol");
	return_types.emplace_back(LogicalType::VARCHAR);
	names.emplace_back("last_done");
	return_types.emplace_back(LogicalType::DOUBLE);
	names.emplace_back("prev_close");
	return_types.emplace_back(LogicalType::DOUBLE);
	names.emplace_back("open");
	return_types.emplace_back(LogicalType::DOUBLE);
	names.emplace_back("high");
	return_types.emplace_back(LogicalType::DOUBLE);
	names.emplace_back("low");
	return_types.emplace_back(LogicalType::DOUBLE);
	names.emplace_back("timestamp");
	return_types.emplace_back(LogicalType::TIMESTAMP);
	names.emplace_back("volume");
	return_types.emplace_back(LogicalType::BIGINT);
	names.emplace_back("turnover");
	return_types.emplace_back(LogicalType::DOUBLE);
	names.emplace_back("trade_status");
	return_types.emplace_back(LogicalType::INTEGER);

	return std::move(result);
}

unique_ptr<GlobalTableFunctionState> LongbridgeQuoteInitGlobal(ClientContext &context, TableFunctionInitInput &input) {
	auto result = make_uniq<QuoteGlobalState>();
	auto &bind_data = input.bind_data->Cast<QuoteBindData>();

	LongbridgeClient client(DatabaseInstance::GetDatabase(context));

	// Chunk into requests of at most 500 symbols; rows are concatenated in request order.
	for (idx_t base = 0; base < bind_data.symbols.size(); base += LONGBRIDGE_QUOTE_MAX_SYMBOLS_PER_REQUEST) {
		std::vector<std::pair<std::string, std::string>> params;
		const idx_t end = std::min<idx_t>(base + LONGBRIDGE_QUOTE_MAX_SYMBOLS_PER_REQUEST, bind_data.symbols.size());
		params.reserve(end - base);
		for (idx_t i = base; i < end; i++) {
			params.emplace_back("symbol", bind_data.symbols[i]);
		}

		YyjsonDocPtr doc(client.Get("/v1/quote/quote", params));
		auto root = duckdb_yyjson::yyjson_doc_get_root(doc.get());
		// The gateways (demo/sidecar, the Worker) answer {"list": [...]}; LongPort's own
		// QuoteResponse names the array secu_quote.
		auto secu_quote = root ? duckdb_yyjson::yyjson_obj_get(root, "list") : nullptr;
		if (!secu_quote && root) {
			secu_quote = duckdb_yyjson::yyjson_obj_get(root, "secu_quote");
		}
		if (!secu_quote || !duckdb_yyjson::yyjson_is_arr(secu_quote)) {
			continue;
		}

		const size_t arr_size = duckdb_yyjson::yyjson_arr_size(secu_quote);
		for (size_t arr_idx = 0; arr_idx < arr_size; arr_idx++) {
			auto entry = duckdb_yyjson::yyjson_arr_get(secu_quote, arr_idx);
			if (!duckdb_yyjson::yyjson_is_obj(entry)) {
				continue;
			}
			QuoteRow row;
			auto symbol = duckdb_yyjson::yyjson_obj_get(entry, "symbol");
			if (symbol && duckdb_yyjson::yyjson_is_str(symbol)) {
				row.symbol = Value(duckdb_yyjson::yyjson_get_str(symbol));
			}
			row.last_done = GetDoubleField(entry, "last_done");
			row.prev_close = GetDoubleField(entry, "prev_close");
			row.open = GetDoubleField(entry, "open");
			row.high = GetDoubleField(entry, "high");
			row.low = GetDoubleField(entry, "low");
			int64_t int_value;
			if (TryGetInt64(entry, "timestamp", int_value)) {
				row.timestamp = Value::TIMESTAMP(Timestamp::FromEpochSeconds(int_value));
			}
			if (TryGetInt64(entry, "volume", int_value)) {
				row.volume = Value::BIGINT(int_value);
			}
			row.turnover = GetDoubleField(entry, "turnover");
			if (TryGetInt64(entry, "trade_status", int_value)) {
				row.trade_status = Value::INTEGER(static_cast<int32_t>(int_value));
			}
			// TODO: expose pre_market_quote / post_market_quote / overnight_quote sub-objects.
			result->rows.push_back(std::move(row));
		}
	}

	return std::move(result);
}

void LongbridgeQuoteFunc(ClientContext &, TableFunctionInput &data, DataChunk &output) {
	auto &state = data.global_state->Cast<QuoteGlobalState>();

	idx_t count = 0;
	while (state.offset < state.rows.size() && count < STANDARD_VECTOR_SIZE) {
		auto &row = state.rows[state.offset];
		SetOutputValue(output, 0, count, row.symbol);
		SetOutputValue(output, 1, count, row.last_done);
		SetOutputValue(output, 2, count, row.prev_close);
		SetOutputValue(output, 3, count, row.open);
		SetOutputValue(output, 4, count, row.high);
		SetOutputValue(output, 5, count, row.low);
		SetOutputValue(output, 6, count, row.timestamp);
		SetOutputValue(output, 7, count, row.volume);
		SetOutputValue(output, 8, count, row.turnover);
		SetOutputValue(output, 9, count, row.trade_status);
		state.offset++;
		count++;
	}
	FinishOutput(output, count);
}

} // namespace

void RegisterQuoteFunctions(ExtensionLoader &loader) {
	TableFunctionSet quote_set("longbridge_quote");
	quote_set.AddFunction(
	    TableFunction({LogicalType::VARCHAR}, LongbridgeQuoteFunc, LongbridgeQuoteBind, LongbridgeQuoteInitGlobal));
	quote_set.AddFunction(TableFunction({LogicalType::LIST(LogicalType::VARCHAR)}, LongbridgeQuoteFunc,
	                                    LongbridgeQuoteBind, LongbridgeQuoteInitGlobal));
	loader.RegisterFunction(quote_set);
}

} // namespace duckdb
