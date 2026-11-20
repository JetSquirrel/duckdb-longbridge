#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace duckdb {

// Minimal protobuf wire-format (proto3) helpers covering varint (wire type 0)
// and length-delimited (wire type 2) fields only. Fixed32/fixed64 (types 1/5)
// are skipped when reading; groups (types 3/4) are unsupported and throw.
// Throws duckdb::IOException on malformed input.

// Builds a serialized protobuf message.
class ProtoWriter {
public:
	// Wire type 0. Also used for int32/int64/enum/bool fields (proto3
	// sign-extends int64 negatives to 10-byte varints, which this emits correctly).
	void Varint(uint32_t field, uint64_t value);
	// Wire type 2, length-delimited UTF-8/bytes.
	void String(uint32_t field, const std::string &v);
	// Wire type 2, embedded message.
	void Message(uint32_t field, const std::vector<uint8_t> &nested);

	const std::vector<uint8_t> &Data() const;

private:
	void Tag(uint32_t field, uint32_t wire_type);
	static void WriteVarint(std::vector<uint8_t> &out, uint64_t value);

	std::vector<uint8_t> data_;
};

// Iterates the fields of a serialized protobuf message. Usage:
//   ProtoReader r(buf);
//   while (r.Next()) { switch (r.Field()) { ... } }
class ProtoReader {
public:
	explicit ProtoReader(const std::vector<uint8_t> &buf);
	ProtoReader(std::vector<uint8_t> &&buf) = delete; // would dangle: the reader does not own the buffer
	ProtoReader(const uint8_t *data, size_t size);

	// Advance to the next field; returns false at end of buffer.
	bool Next();
	uint32_t Field() const;
	// 0 = varint, 2 = LEN. Fixed 1/5 are skipped by Next(); groups 3/4 throw.
	uint32_t WireType() const;

	uint64_t GetVarint() const;
	std::string GetString() const;
	std::vector<uint8_t> GetBytes() const;

private:
	bool ReadVarint(uint64_t &value);

	const uint8_t *data_;
	size_t size_;
	size_t pos_;
	uint32_t field_;
	uint32_t wire_type_;
	uint64_t varint_value_;
	const uint8_t *len_data_;
	size_t len_size_;
};

} // namespace duckdb
