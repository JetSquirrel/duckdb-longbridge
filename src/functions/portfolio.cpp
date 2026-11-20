#include "longbridge_extension.hpp"

#include "longbridge_client.hpp"

#include "duckdb/common/exception.hpp"
#include "duckdb/function/table_function.hpp"

#include "yyjson.hpp"

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
using duckdb_yyjson::yyjson_is_null;
using duckdb_yyjson::yyjson_is_num;
using duckdb_yyjson::yyjson_is_str;
using duckdb_yyjson::yyjson_obj_get;
using duckdb_yyjson::yyjson_val;

namespace {

struct DocGuard {
	explicit DocGuard(yyjson_doc *doc_p) : doc(doc_p) {
	}
	~DocGuard() {
		if (doc) {
			yyjson_doc_free(doc);
		}
	}
	yyjson_doc *doc;
};

// All rows are buffered in the bind data after a single HTTP request; the
// function callback just streams them out.
struct BufferedRowsBindData : public TableFunctionData {
	std::vector<std::vector<Value>> rows;
};

struct BufferedRowsGlobalState : public GlobalTableFunctionState {
	idx_t offset = 0;
};

Value JsonStringValue(yyjson_val *obj, const char *key) {
	if (!obj) {
		return Value(LogicalType::VARCHAR);
	}
	auto *val = yyjson_obj_get(obj, key);
	if (!val || !yyjson_is_str(val)) {
		return Value(LogicalType::VARCHAR);
	}
	return Value(yyjson_get_str(val));
}

Value JsonDoubleValue(yyjson_val *obj, const char *key) {
	if (!obj) {
		return Value(LogicalType::DOUBLE);
	}
	auto *val = yyjson_obj_get(obj, key);
	if (!val || yyjson_is_null(val)) {
		return Value(LogicalType::DOUBLE);
	}
	if (yyjson_is_num(val)) {
		return Value::DOUBLE(yyjson_get_num(val));
	}
	if (yyjson_is_str(val)) {
		std::string str = yyjson_get_str(val);
		if (str.empty()) {
			return Value(LogicalType::DOUBLE);
		}
		try {
			return Value::DOUBLE(std::stod(str));
		} catch (const std::exception &) {
			throw InvalidInputException("Longbridge: cannot parse numeric value \"%s\" for field \"%s\"", str, key);
		}
	}
	return Value(LogicalType::DOUBLE);
}

Value JsonBigIntValue(yyjson_val *obj, const char *key) {
	if (!obj) {
		return Value(LogicalType::BIGINT);
	}
	auto *val = yyjson_obj_get(obj, key);
	if (!val || yyjson_is_null(val)) {
		return Value(LogicalType::BIGINT);
	}
	if (yyjson_is_num(val)) {
		return Value::BIGINT(yyjson_get_sint(val));
	}
	if (yyjson_is_str(val)) {
		std::string str = yyjson_get_str(val);
		if (str.empty()) {
			return Value(LogicalType::BIGINT);
		}
		try {
			return Value::BIGINT(std::stoll(str));
		} catch (const std::exception &) {
			throw InvalidInputException("Longbridge: cannot parse integer value \"%s\" for field \"%s\"", str, key);
		}
	}
	return Value(LogicalType::BIGINT);
}

unique_ptr<GlobalTableFunctionState> BufferedRowsInitGlobal(ClientContext &context, TableFunctionInitInput &input) {
	return make_uniq<BufferedRowsGlobalState>();
}

void BufferedRowsFunction(ClientContext &context, TableFunctionInput &data_p, DataChunk &output) {
	auto &bind_data = data_p.bind_data->CastNoConst<BufferedRowsBindData>();
	auto &state = data_p.global_state->Cast<BufferedRowsGlobalState>();
	idx_t count = 0;
	while (state.offset < bind_data.rows.size() && count < STANDARD_VECTOR_SIZE) {
		const auto &row = bind_data.rows[state.offset];
		for (idx_t col = 0; col < row.size(); col++) {
			SetOutputValue(output, col, count, row[col]);
		}
		state.offset++;
		count++;
	}
	FinishOutput(output, count);
}

unique_ptr<FunctionData> AccountBind(ClientContext &context, TableFunctionBindInput &input,
                                     vector<LogicalType> &return_types, ColumnNames &names) {
	names = {"currency",        "total_cash",         "available_cash",
	         "withdraw_cash",   "frozen_cash",        "settling_cash",
	         "redemption_cash", "max_finance_amount", "remaining_finance_amount",
	         "risk_level",      "margin_call",        "net_assets",
	         "init_margin",     "maintenance_margin", "buy_power",
	         "market"};
	return_types = {LogicalType::VARCHAR, LogicalType::DOUBLE,  LogicalType::DOUBLE, LogicalType::DOUBLE,
	                LogicalType::DOUBLE,  LogicalType::DOUBLE,  LogicalType::DOUBLE, LogicalType::DOUBLE,
	                LogicalType::DOUBLE,  LogicalType::VARCHAR, LogicalType::DOUBLE, LogicalType::DOUBLE,
	                LogicalType::DOUBLE,  LogicalType::DOUBLE,  LogicalType::DOUBLE, LogicalType::VARCHAR};

	auto result = make_uniq<BufferedRowsBindData>();
	LongbridgeClient client(*context.db);
	DocGuard doc(client.Get("/v1/asset/account", {}));

	auto *root = yyjson_doc_get_root(doc.doc);
	auto *list = root ? yyjson_obj_get(root, "list") : nullptr;
	if (!list || !yyjson_is_arr(list)) {
		return std::move(result);
	}
	size_t list_idx, list_max;
	yyjson_val *entry;
	yyjson_arr_foreach(list, list_idx, list_max, entry) {
		// Account-level scalars, repeated on every cash_infos row of this entry.
		auto total_cash = JsonDoubleValue(entry, "total_cash");
		auto max_finance_amount = JsonDoubleValue(entry, "max_finance_amount");
		auto remaining_finance_amount = JsonDoubleValue(entry, "remaining_finance_amount");
		auto risk_level = JsonStringValue(entry, "risk_level");
		auto margin_call = JsonDoubleValue(entry, "margin_call");
		auto net_assets = JsonDoubleValue(entry, "net_assets");
		auto init_margin = JsonDoubleValue(entry, "init_margin");
		auto maintenance_margin = JsonDoubleValue(entry, "maintenance_margin");
		auto buy_power = JsonDoubleValue(entry, "buy_power");
		auto market = JsonStringValue(entry, "market");

		auto *cash_infos = yyjson_obj_get(entry, "cash_infos");
		if (!cash_infos || !yyjson_is_arr(cash_infos) || yyjson_arr_size(cash_infos) == 0) {
			result->rows.push_back({Value(LogicalType::VARCHAR), total_cash, Value(LogicalType::DOUBLE),
			                        Value(LogicalType::DOUBLE), Value(LogicalType::DOUBLE), Value(LogicalType::DOUBLE),
			                        Value(LogicalType::DOUBLE), max_finance_amount, remaining_finance_amount,
			                        risk_level, margin_call, net_assets, init_margin, maintenance_margin, buy_power,
			                        market});
			continue;
		}
		size_t cash_idx, cash_max;
		yyjson_val *cash_info;
		yyjson_arr_foreach(cash_infos, cash_idx, cash_max, cash_info) {
			result->rows.push_back(
			    {JsonStringValue(cash_info, "currency"), total_cash, JsonDoubleValue(cash_info, "available_cash"),
			     JsonDoubleValue(cash_info, "withdraw_cash"), JsonDoubleValue(cash_info, "frozen_cash"),
			     JsonDoubleValue(cash_info, "settling_cash"), JsonDoubleValue(cash_info, "redemption_cash"),
			     max_finance_amount, remaining_finance_amount, risk_level, margin_call, net_assets, init_margin,
			     maintenance_margin, buy_power, market});
		}
	}
	return std::move(result);
}

unique_ptr<FunctionData> PositionsBind(ClientContext &context, TableFunctionBindInput &input,
                                       vector<LogicalType> &return_types, ColumnNames &names) {
	names = {"symbol",     "symbol_name", "quantity",      "available_quantity", "currency",
	         "cost_price", "market",      "init_quantity", "account_channel"};
	return_types = {LogicalType::VARCHAR, LogicalType::VARCHAR, LogicalType::BIGINT,
	                LogicalType::BIGINT,  LogicalType::VARCHAR, LogicalType::DOUBLE,
	                LogicalType::VARCHAR, LogicalType::BIGINT,  LogicalType::VARCHAR};

	auto result = make_uniq<BufferedRowsBindData>();
	LongbridgeClient client(*context.db);
	DocGuard doc(client.Get("/v1/asset/stock", {}));

	auto *root = yyjson_doc_get_root(doc.doc);
	auto *list = root ? yyjson_obj_get(root, "list") : nullptr;
	if (!list || !yyjson_is_arr(list)) {
		return std::move(result);
	}
	size_t list_idx, list_max;
	yyjson_val *channel;
	yyjson_arr_foreach(list, list_idx, list_max, channel) {
		auto account_channel = JsonStringValue(channel, "account_channel");
		auto *stock_info = yyjson_obj_get(channel, "stock_info");
		if (!stock_info || !yyjson_is_arr(stock_info)) {
			continue;
		}
		size_t stock_idx, stock_max;
		yyjson_val *position;
		yyjson_arr_foreach(stock_info, stock_idx, stock_max, position) {
			result->rows.push_back(
			    {JsonStringValue(position, "symbol"), JsonStringValue(position, "symbol_name"),
			     JsonBigIntValue(position, "quantity"), JsonBigIntValue(position, "available_quantity"),
			     JsonStringValue(position, "currency"), JsonDoubleValue(position, "cost_price"),
			     JsonStringValue(position, "market"), JsonBigIntValue(position, "init_quantity"), account_channel});
		}
	}
	return std::move(result);
}

} // namespace

void RegisterPortfolioFunctions(ExtensionLoader &loader) {
	TableFunction account_function("longbridge_account", {}, BufferedRowsFunction, AccountBind, BufferedRowsInitGlobal);
	loader.RegisterFunction(account_function);

	TableFunction positions_function("longbridge_positions", {}, BufferedRowsFunction, PositionsBind,
	                                 BufferedRowsInitGlobal);
	loader.RegisterFunction(positions_function);
}

} // namespace duckdb
