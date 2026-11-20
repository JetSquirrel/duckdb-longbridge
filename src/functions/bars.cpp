#include "longbridge_extension.hpp"

#include "longbridge_client.hpp"

#include "duckdb/common/exception.hpp"
#include "duckdb/common/string_util.hpp"
#include "duckdb/common/types/date.hpp"
#include "duckdb/common/types/timestamp.hpp"
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

using duckdb_yyjson::unsafe_yyjson_get_next;
using duckdb_yyjson::yyjson_arr_get_first;
using duckdb_yyjson::yyjson_arr_size;
using duckdb_yyjson::yyjson_doc;
using duckdb_yyjson::yyjson_doc_free;
using duckdb_yyjson::yyjson_doc_get_root;
using duckdb_yyjson::yyjson_get_num;
using duckdb_yyjson::yyjson_get_sint;
using duckdb_yyjson::yyjson_get_str;
using duckdb_yyjson::yyjson_is_arr;
using duckdb_yyjson::yyjson_is_num;
using duckdb_yyjson::yyjson_is_obj;
using duckdb_yyjson::yyjson_is_str;
using duckdb_yyjson::yyjson_obj_get;
using duckdb_yyjson::yyjson_val;

namespace {

// Period string -> Longbridge Period enum value (see quote/objects.md, "Period - K 线周期").
int32_t ParsePeriod(const std::string &raw) {
	static const std::vector<std::pair<const char *, int32_t>> PERIODS = {
	    {"1m", 1},      {"2m", 2},       {"3m", 3},         {"5m", 5},      {"10m", 10}, {"15m", 15},
	    {"20m", 20},    {"30m", 30},     {"45m", 45},       {"60m", 60},    {"1h", 60},  {"120m", 120},
	    {"2h", 120},    {"180m", 180},   {"3h", 180},       {"240m", 240},  {"4h", 240}, {"day", 1000},
	    {"week", 2000}, {"month", 3000}, {"quarter", 3500}, {"year", 4000},
	};
	const auto period = StringUtil::Lower(raw);
	for (const auto &kv : PERIODS) {
		if (period == kv.first) {
			return kv.second;
		}
	}
	throw InvalidInputException("longbridge: invalid period '%s'. Valid values: 1m, 5m, 15m, 30m, 60m, day, week, "
	                            "month, year (also: 2m, 3m, 10m, 20m, 45m, 1h, 2h, 3h, 4h, quarter)",
	                            raw);
}

// AdjustType enum (see quote/objects.md): 0 = no adjust, 1 = forward adjust.
int32_t ParseAdjustType(const std::string &raw) {
	const auto adjust = StringUtil::Lower(raw);
	if (adjust == "no") {
		return 0;
	}
	if (adjust == "forward") {
		return 1;
	}
	throw InvalidInputException("longbridge: invalid adjust_type '%s'. Valid values: 'no', 'forward'", raw);
}

Value JsonDouble(yyjson_val *obj, const char *key) {
	auto val = yyjson_obj_get(obj, key);
	if (!val) {
		return Value(LogicalType::DOUBLE);
	}
	if (yyjson_is_str(val)) {
		// Prices/amounts arrive as JSON strings, e.g. "338.000".
		const char *str = yyjson_get_str(val);
		if (!str || str[0] == '\0') {
			return Value(LogicalType::DOUBLE);
		}
		try {
			return Value::DOUBLE(std::stod(str));
		} catch (...) {
			return Value(LogicalType::DOUBLE);
		}
	}
	if (yyjson_is_num(val)) {
		return Value::DOUBLE(yyjson_get_num(val));
	}
	return Value(LogicalType::DOUBLE);
}

Value JsonBigInt(yyjson_val *obj, const char *key) {
	auto val = yyjson_obj_get(obj, key);
	if (!val) {
		return Value(LogicalType::BIGINT);
	}
	if (yyjson_is_num(val)) {
		return Value::BIGINT(yyjson_get_sint(val));
	}
	if (yyjson_is_str(val)) {
		const char *str = yyjson_get_str(val);
		if (!str || str[0] == '\0') {
			return Value(LogicalType::BIGINT);
		}
		try {
			return Value::BIGINT(static_cast<int64_t>(std::stoll(str)));
		} catch (...) {
			return Value(LogicalType::BIGINT);
		}
	}
	return Value(LogicalType::BIGINT);
}

Value JsonInteger(yyjson_val *obj, const char *key) {
	auto val = yyjson_obj_get(obj, key);
	if (!val) {
		return Value(LogicalType::INTEGER);
	}
	if (yyjson_is_num(val)) {
		return Value::INTEGER(static_cast<int32_t>(yyjson_get_sint(val)));
	}
	return Value(LogicalType::INTEGER);
}

Value JsonTimestamp(yyjson_val *obj, const char *key) {
	auto val = yyjson_obj_get(obj, key);
	if (!val || !yyjson_is_num(val)) {
		return Value(LogicalType::TIMESTAMP);
	}
	// Unix-seconds epoch timestamp.
	return Value::TIMESTAMP(Timestamp::FromEpochSeconds(yyjson_get_sint(val)));
}

struct BarsBindData : public TableFunctionData {
	std::vector<std::vector<Value>> rows;
};

struct BarsGlobalState : public GlobalTableFunctionState {
	idx_t offset = 0;
};

// Performs the (single) HTTP request and buffers every candlestick as a row of 9 Values:
// symbol VARCHAR, timestamp TIMESTAMP, open/high/low/close DOUBLE, volume BIGINT, turnover DOUBLE,
// trade_session INTEGER.
unique_ptr<FunctionData> BarsBindCommon(ClientContext &context, const std::string &endpoint,
                                        const std::vector<std::pair<std::string, std::string>> &params,
                                        vector<LogicalType> &return_types, ColumnNames &names) {
	names = {"symbol", "timestamp", "open", "high", "low", "close", "volume", "turnover", "trade_session"};
	return_types = {LogicalType::VARCHAR, LogicalType::TIMESTAMP, LogicalType::DOUBLE,
	                LogicalType::DOUBLE,  LogicalType::DOUBLE,    LogicalType::DOUBLE,
	                LogicalType::BIGINT,  LogicalType::DOUBLE,    LogicalType::INTEGER};

	LongbridgeClient client(*context.db);
	std::unique_ptr<yyjson_doc, decltype(&yyjson_doc_free)> doc(client.Get(endpoint, params), yyjson_doc_free);

	auto result = make_uniq<BarsBindData>();
	auto root = yyjson_doc_get_root(doc.get());
	if (!root || !yyjson_is_obj(root)) {
		return std::move(result);
	}
	std::string symbol;
	auto symbol_val = yyjson_obj_get(root, "symbol");
	if (symbol_val && yyjson_is_str(symbol_val)) {
		symbol = yyjson_get_str(symbol_val);
	}
	auto candlesticks = yyjson_obj_get(root, "candlesticks");
	if (!candlesticks || !yyjson_is_arr(candlesticks)) {
		return std::move(result);
	}
	size_t idx, max;
	yyjson_val *item;
	yyjson_arr_foreach(candlesticks, idx, max, item) {
		if (!yyjson_is_obj(item)) {
			continue;
		}
		std::vector<Value> row;
		row.reserve(9);
		row.push_back(symbol.empty() ? Value(LogicalType::VARCHAR) : Value(symbol));
		row.push_back(JsonTimestamp(item, "timestamp"));
		row.push_back(JsonDouble(item, "open"));
		row.push_back(JsonDouble(item, "high"));
		row.push_back(JsonDouble(item, "low"));
		row.push_back(JsonDouble(item, "close"));
		row.push_back(JsonBigInt(item, "volume"));
		row.push_back(JsonDouble(item, "turnover"));
		row.push_back(JsonInteger(item, "trade_session"));
		result->rows.push_back(std::move(row));
	}
	return std::move(result);
}

std::string CheckedStringArg(const Value &value, const char *name) {
	if (value.IsNull()) {
		throw InvalidInputException("longbridge: %s must not be NULL", name);
	}
	auto result = value.GetValue<std::string>();
	if (result.empty()) {
		throw InvalidInputException("longbridge: %s must not be empty", name);
	}
	return result;
}

date_t CheckedDateArg(const Value &value, const char *name) {
	if (value.IsNull()) {
		throw InvalidInputException("longbridge: %s must not be NULL", name);
	}
	return value.GetValue<date_t>();
}

// "YYYY-MM-DD" -> "YYYYMMDD" (the format the history candlestick API expects).
std::string FormatDateParam(date_t date) {
	auto str = Date::ToString(date);
	str.erase(std::remove(str.begin(), str.end(), '-'), str.end());
	return str;
}

unique_ptr<FunctionData> BarsBind(ClientContext &context, TableFunctionBindInput &input,
                                  vector<LogicalType> &return_types, ColumnNames &names) {
	auto symbol = CheckedStringArg(input.inputs[0], "symbol");
	const auto period = ParsePeriod(CheckedStringArg(input.inputs[1], "period"));
	int32_t count = 100;
	if (input.inputs.size() > 2 && !input.inputs[2].IsNull()) {
		count = input.inputs[2].GetValue<int32_t>();
	}
	if (count < 1 || count > 1000) {
		throw InvalidInputException("longbridge: count must be between 1 and 1000, got %d", count);
	}
	int32_t adjust_type = 0;
	if (input.inputs.size() > 3 && !input.inputs[3].IsNull()) {
		adjust_type = ParseAdjustType(input.inputs[3].GetValue<std::string>());
	}
	std::vector<std::pair<std::string, std::string>> params = {{"symbol", std::move(symbol)},
	                                                           {"period", std::to_string(period)},
	                                                           {"count", std::to_string(count)},
	                                                           {"adjust_type", std::to_string(adjust_type)}};
	return BarsBindCommon(context, "/v1/quote/candlestick", params, return_types, names);
}

unique_ptr<FunctionData> HistoryBarsBind(ClientContext &context, TableFunctionBindInput &input,
                                         vector<LogicalType> &return_types, ColumnNames &names) {
	auto symbol = CheckedStringArg(input.inputs[0], "symbol");
	const auto period = ParsePeriod(CheckedStringArg(input.inputs[1], "period"));
	const auto start_date = CheckedDateArg(input.inputs[2], "start_date");
	const auto end_date = CheckedDateArg(input.inputs[3], "end_date");
	if (start_date > end_date) {
		throw InvalidInputException("longbridge: start_date (%s) must not be after end_date (%s)",
		                            Date::ToString(start_date), Date::ToString(end_date));
	}
	int32_t adjust_type = 0;
	if (input.inputs.size() > 4 && !input.inputs[4].IsNull()) {
		adjust_type = ParseAdjustType(input.inputs[4].GetValue<std::string>());
	}
	// Date-range query: query_type 2 with start_date/end_date in YYYYMMDD format
	// (see quote/stocks/history-candlestick.md, SecurityHistoryCandlestickRequest.DateQuery).
	std::vector<std::pair<std::string, std::string>> params = {{"symbol", std::move(symbol)},
	                                                           {"period", std::to_string(period)},
	                                                           {"adjust_type", std::to_string(adjust_type)},
	                                                           {"query_type", "2"},
	                                                           {"start_date", FormatDateParam(start_date)},
	                                                           {"end_date", FormatDateParam(end_date)}};
	return BarsBindCommon(context, "/v1/quote/history_candlestick", params, return_types, names);
}

unique_ptr<GlobalTableFunctionState> BarsInitGlobal(ClientContext &context, TableFunctionInitInput &input) {
	return make_uniq<BarsGlobalState>();
}

void BarsScan(ClientContext &context, TableFunctionInput &input, DataChunk &output) {
	auto &bind_data = input.bind_data->Cast<BarsBindData>();
	auto &state = input.global_state->Cast<BarsGlobalState>();
	idx_t count = 0;
	while (state.offset < bind_data.rows.size() && count < STANDARD_VECTOR_SIZE) {
		const auto &row = bind_data.rows[state.offset++];
		for (idx_t col = 0; col < row.size(); col++) {
			SetOutputValue(output, col, count, row[col]);
		}
		count++;
	}
	FinishOutput(output, count);
}

} // namespace

void RegisterBarsFunctions(ExtensionLoader &loader) {
	TableFunctionSet bars("longbridge_bars");
	bars.AddFunction(TableFunction("longbridge_bars", {LogicalType::VARCHAR, LogicalType::VARCHAR}, BarsScan, BarsBind,
	                               BarsInitGlobal));
	bars.AddFunction(TableFunction("longbridge_bars",
	                               {LogicalType::VARCHAR, LogicalType::VARCHAR, LogicalType::INTEGER}, BarsScan,
	                               BarsBind, BarsInitGlobal));
	bars.AddFunction(TableFunction(
	    "longbridge_bars", {LogicalType::VARCHAR, LogicalType::VARCHAR, LogicalType::INTEGER, LogicalType::VARCHAR},
	    BarsScan, BarsBind, BarsInitGlobal));
	loader.RegisterFunction(bars);

	TableFunctionSet history_bars("longbridge_history_bars");
	history_bars.AddFunction(TableFunction(
	    "longbridge_history_bars", {LogicalType::VARCHAR, LogicalType::VARCHAR, LogicalType::DATE, LogicalType::DATE},
	    BarsScan, HistoryBarsBind, BarsInitGlobal));
	history_bars.AddFunction(TableFunction(
	    "longbridge_history_bars",
	    {LogicalType::VARCHAR, LogicalType::VARCHAR, LogicalType::DATE, LogicalType::DATE, LogicalType::VARCHAR},
	    BarsScan, HistoryBarsBind, BarsInitGlobal));
	loader.RegisterFunction(history_bars);
}

} // namespace duckdb
