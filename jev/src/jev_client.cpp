#include "yyjson.hpp"

#include "jev_client.hpp"
#include "duckdb/common/exception.hpp"
#include "duckdb/common/http_util.hpp"
#include <mutex>
#include <atomic>
#include <chrono>
#include <thread>
#include <unordered_map>

namespace duckdb {

using namespace duckdb_yyjson; // NOLINT

static constexpr const char *SYSTEMONE_PATH = "/v1/systemone";
//! The question key inside the request. One question per request in this slice.
static constexpr const char *QUESTION_KEY = "q";
//! Crude bound: when the cache reaches this many entries it is cleared. Enough for
//! any single query to dedupe itself; not a persistent store.
static constexpr size_t CACHE_MAX_ENTRIES = 100000;
//! Retry budget for 429 and 5xx. The API documents 429 with no quota numbers, so
//! back off and try again. Other 4xx mean the request is wrong; retrying cannot help.
static constexpr int MAX_ATTEMPTS = 4;
static constexpr int FIRST_BACKOFF_MS = 200;

static bool IsRetryable(int status) {
	return status == 429 || (status >= 500 && status < 600);
}

namespace {
std::mutex cache_lock;
std::unordered_map<string, string> cache;
std::atomic<int64_t> usage_requests(0), usage_cache_hits(0), usage_input_tokens(0), usage_output_tokens(0);
} // namespace

JevUsage JevClient::Usage() {
	JevUsage u;
	u.requests = usage_requests.load();
	u.cache_hits = usage_cache_hits.load();
	u.input_tokens = usage_input_tokens.load();
	u.output_tokens = usage_output_tokens.load();
	return u;
}

//! Adds a fresh response's usage block to the counters. Missing or malformed usage
//! is not an error: the answer is still good, the bill is just unknown for it.
static void RecordUsage(const string &body) {
	unique_ptr<yyjson_doc, void (*)(yyjson_doc *)> doc(yyjson_read(body.c_str(), body.size(), 0), &yyjson_doc_free);
	if (!doc) {
		return;
	}
	auto usage = yyjson_obj_get(yyjson_doc_get_root(doc.get()), "usage");
	if (!usage) {
		return;
	}
	auto in = yyjson_obj_get(usage, "input_tokens");
	auto out = yyjson_obj_get(usage, "output_tokens");
	if (in && yyjson_is_int(in)) {
		usage_input_tokens += yyjson_get_sint(in);
	}
	if (out && yyjson_is_int(out)) {
		usage_output_tokens += yyjson_get_sint(out);
	}
}

bool JevClient::CacheGet(const string &key, string &body) {
	std::lock_guard<std::mutex> guard(cache_lock);
	auto it = cache.find(key);
	if (it == cache.end()) {
		return false;
	}
	body = it->second;
	return true;
}

void JevClient::CachePut(const string &key, const string &body) {
	std::lock_guard<std::mutex> guard(cache_lock);
	if (cache.size() >= CACHE_MAX_ENTRIES) {
		cache.clear();
	}
	cache[key] = body;
}

static const char *TypeName(JevQuestionType type) {
	switch (type) {
	case JevQuestionType::CHOICE:
		return "choice";
	case JevQuestionType::SCORE:
		return "score";
	default:
		return "noul";
	}
}

string JevClient::BuildRequest(const string &state, const JevQuestions &questions) {
	unique_ptr<yyjson_mut_doc, void (*)(yyjson_mut_doc *)> doc(yyjson_mut_doc_new(nullptr), &yyjson_mut_doc_free);
	auto root = yyjson_mut_obj(doc.get());
	yyjson_mut_doc_set_root(doc.get(), root);

	yyjson_mut_obj_add_strn(doc.get(), root, "state", state.c_str(), state.size());
	yyjson_mut_obj_add_str(doc.get(), root, "model", settings.model.c_str());

	auto questions_obj = yyjson_mut_obj(doc.get());
	for (auto &named : questions) {
		auto &question = named.second;
		auto q = yyjson_mut_obj(doc.get());
		yyjson_mut_obj_add_str(doc.get(), q, "type", TypeName(question.type));
		if (question.type == JevQuestionType::SCORE) {
			auto criteria = yyjson_mut_arr(doc.get());
			for (auto &level : question.criteria_list) {
				yyjson_mut_arr_add_strn(doc.get(), criteria, level.c_str(), level.size());
			}
			yyjson_mut_obj_add_val(doc.get(), q, "criteria", criteria);
		} else {
			auto criteria = yyjson_mut_obj(doc.get());
			for (auto &kv : question.criteria_map) {
				yyjson_mut_obj_add_strn(doc.get(), criteria, kv.first.c_str(), kv.second.c_str(), kv.second.size());
			}
			yyjson_mut_obj_add_val(doc.get(), q, "criteria", criteria);
		}
		yyjson_mut_obj_add_val(doc.get(), questions_obj, named.first.c_str(), q);
	}
	yyjson_mut_obj_add_val(doc.get(), root, "questions", questions_obj);

	size_t len = 0;
	auto json = yyjson_mut_write(doc.get(), 0, &len);
	if (!json) {
		throw InternalException("jev: failed to serialise request");
	}
	string out(json, len);
	free(json);
	return out;
}

string JevClient::Post(const string &body) {
	// duckdb::HTTPUtil is the one HTTP stack that exists in both targets: natively
	// the httpfs extension provides the POST-capable client (LOAD httpfs first), in
	// duckdb-wasm the globally overridden sync-XHR implementation handles it. Raw
	// sockets do not exist in browser wasm, so no direct httplib client is possible.
	auto url = settings.endpoint + SYSTEMONE_PATH;
	auto &http_util = HTTPUtil::Get(db);
	auto params = http_util.InitializeParameters(db, url);
	// HTTPParams carries a single timeout, applied by the client to connect, read
	// and write; the 10s connect / 30s read split of the old httplib client cannot
	// be expressed. 30s keeps slow answers readable.
	params->timeout = 30;
	// One attempt per Request call: the retry policy (attempts, backoff, which
	// statuses) lives in the loop below so it is identical on every HTTP stack.
	params->retries = 0;

	HTTPHeaders headers;
	headers.Insert("Authorization", "Bearer " + settings.api_key);
	headers.Insert("Content-Type", "application/json");

	unique_ptr<HTTPClient> client;
	int backoff_ms = FIRST_BACKOFF_MS;
	for (int attempt = 1;; attempt++) {
		PostRequestInfo request(url, headers, *params, const_data_ptr_cast(body.c_str()), body.size());
		// Return failed requests instead of throwing so the status drives the retry.
		request.try_request = true;
		unique_ptr<HTTPResponse> res;
		try {
			res = http_util.Request(request, client);
		} catch (NotImplementedException &) {
			// DuckDB's core built-in HTTPUtil (no httpfs loaded) cannot POST.
			throw IOException("jev: POST requires the httpfs extension: run INSTALL httpfs; LOAD httpfs first");
		}
		// Every POST-capable HTTPUtil client (httpfs httplib/curl, duckdb-wasm XHR)
		// delivers the response body in buffer_out; httpfs even overwrites
		// response->body with the request body, so buffer_out is the only portable
		// success channel.
		auto status = static_cast<int>(res->status);
		if (!res->HasRequestError() && status == 200) {
			return request.buffer_out;
		}
		// A connection closed before any status is as transient as a 503: a proxy
		// recycling, a keep-alive expiring, a server restarting. Retry both.
		auto retryable = res->HasRequestError() || IsRetryable(status);
		if (!retryable || attempt >= MAX_ATTEMPTS) {
			if (res->HasRequestError()) {
				throw IOException("jev: request to %s failed after %d attempt(s): %s", settings.endpoint, attempt,
				                  res->GetRequestError());
			}
			auto &error_body = !request.buffer_out.empty() ? request.buffer_out : res->body;
			throw IOException("jev: HTTP %d from %s after %d attempt(s): %s", status, settings.endpoint, attempt,
			                  error_body.empty() ? res->reason : error_body);
		}
		std::this_thread::sleep_for(std::chrono::milliseconds(backoff_ms));
		backoff_ms *= 2;
	}
}

static JevAnswer ParseAnswer(yyjson_val *answer, const string &name, JevQuestionType type) {
	JevAnswer out;
	auto confidence = yyjson_obj_get(answer, "confidence");
	if (confidence && yyjson_is_num(confidence)) {
		out.confidence = yyjson_get_num(confidence);
	}
	const char *field = type == JevQuestionType::CHOICE ? "choice" : type == JevQuestionType::SCORE ? "score" : "noul";
	auto value = yyjson_obj_get(answer, field);
	if (type == JevQuestionType::CHOICE) {
		if (!value || !yyjson_is_str(value)) {
			throw IOException("jev: response has no string answers.%s.choice", name);
		}
		out.choice = yyjson_get_str(value);
	} else {
		if (!value || !yyjson_is_num(value)) {
			throw IOException("jev: response has no numeric answers.%s.%s", name, field);
		}
		out.number = yyjson_get_num(value);
	}
	return out;
}

JevAnswers JevClient::ParseResponse(const string &body, const JevQuestions &questions) {
	unique_ptr<yyjson_doc, void (*)(yyjson_doc *)> doc(yyjson_read(body.c_str(), body.size(), 0), &yyjson_doc_free);
	if (!doc) {
		throw IOException("jev: response is not valid JSON");
	}
	auto root = yyjson_doc_get_root(doc.get());
	auto answers = yyjson_obj_get(root, "answers");
	if (!answers) {
		throw IOException("jev: response has no answers");
	}
	JevAnswers out;
	for (auto &named : questions) {
		auto answer = yyjson_obj_get(answers, named.first.c_str());
		if (!answer) {
			throw IOException("jev: response has no answers.%s", named.first);
		}
		out[named.first] = ParseAnswer(answer, named.first, named.second.type);
	}
	return out;
}

JevAnswers JevClient::Ask(const string &state, const JevQuestions &questions) {
	auto request = BuildRequest(state, questions);
	// The request body already encodes state, model, types and criteria; add the
	// endpoint so two services never share an answer.
	auto key = settings.endpoint + "\x1f" + request;
	string response;
	if (CacheGet(key, response)) {
		usage_cache_hits++;
	} else {
		response = Post(request);
		usage_requests++;
		RecordUsage(response);
		CachePut(key, response);
	}
	return ParseResponse(response, questions);
}

JevAnswer JevClient::Ask(const string &state, const JevQuestion &question) {
	JevQuestions one;
	one.emplace_back(QUESTION_KEY, question);
	return Ask(state, one)[QUESTION_KEY];
}

} // namespace duckdb
