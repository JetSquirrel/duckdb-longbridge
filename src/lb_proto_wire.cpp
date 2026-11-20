#include "lb_proto_wire.hpp"

#include "duckdb/common/exception.hpp"

namespace duckdb {

//===--------------------------------------------------------------------===//
// ProtoWriter
//===--------------------------------------------------------------------===//

void ProtoWriter::WriteVarint(std::vector<uint8_t> &out, uint64_t value) {
	while (value >= 0x80) {
		out.push_back(static_cast<uint8_t>((value & 0x7F) | 0x80));
		value >>= 7;
	}
	out.push_back(static_cast<uint8_t>(value));
}

void ProtoWriter::Tag(uint32_t field, uint32_t wire_type) {
	if (field == 0 || field > 0x1FFFFFFF) {
		throw IOException("lb_proto_wire: invalid protobuf field number %llu", static_cast<unsigned long long>(field));
	}
	WriteVarint(data_, (static_cast<uint64_t>(field) << 3) | wire_type);
}

void ProtoWriter::Varint(uint32_t field, uint64_t value) {
	Tag(field, 0);
	WriteVarint(data_, value);
}

void ProtoWriter::String(uint32_t field, const std::string &v) {
	Tag(field, 2);
	WriteVarint(data_, v.size());
	data_.insert(data_.end(), v.begin(), v.end());
}

void ProtoWriter::Message(uint32_t field, const std::vector<uint8_t> &nested) {
	Tag(field, 2);
	WriteVarint(data_, nested.size());
	data_.insert(data_.end(), nested.begin(), nested.end());
}

const std::vector<uint8_t> &ProtoWriter::Data() const {
	return data_;
}

//===--------------------------------------------------------------------===//
// ProtoReader
//===--------------------------------------------------------------------===//

ProtoReader::ProtoReader(const std::vector<uint8_t> &buf)
    : data_(buf.data()), size_(buf.size()), pos_(0), field_(0), wire_type_(0), varint_value_(0), len_data_(nullptr),
      len_size_(0) {
}

ProtoReader::ProtoReader(const uint8_t *data, size_t size)
    : data_(data), size_(size), pos_(0), field_(0), wire_type_(0), varint_value_(0), len_data_(nullptr), len_size_(0) {
}

bool ProtoReader::ReadVarint(uint64_t &value) {
	uint64_t result = 0;
	uint32_t shift = 0;
	while (pos_ < size_ && shift < 64) {
		uint8_t byte = data_[pos_++];
		result |= static_cast<uint64_t>(byte & 0x7F) << shift;
		if (!(byte & 0x80)) {
			value = result;
			return true;
		}
		shift += 7;
	}
	return false; // truncated or over-long varint
}

bool ProtoReader::Next() {
	while (pos_ < size_) {
		uint64_t tag = 0;
		if (!ReadVarint(tag)) {
			throw IOException("lb_proto_wire: malformed field tag (truncated varint)");
		}
		field_ = static_cast<uint32_t>(tag >> 3);
		wire_type_ = static_cast<uint32_t>(tag & 0x7);
		if (field_ == 0) {
			throw IOException("lb_proto_wire: invalid protobuf field number 0");
		}

		switch (wire_type_) {
		case 0: // varint
			if (!ReadVarint(varint_value_)) {
				throw IOException("lb_proto_wire: truncated varint value in field %llu",
				                  static_cast<unsigned long long>(field_));
			}
			return true;
		case 1: // fixed64: skip 8 bytes, keep iterating
			if (pos_ + 8 > size_) {
				throw IOException("lb_proto_wire: truncated fixed64 in field %llu",
				                  static_cast<unsigned long long>(field_));
			}
			pos_ += 8;
			continue;
		case 2: { // length-delimited
			uint64_t len = 0;
			if (!ReadVarint(len) || len > size_ - pos_) {
				throw IOException("lb_proto_wire: truncated length-delimited field %llu",
				                  static_cast<unsigned long long>(field_));
			}
			len_data_ = data_ + pos_;
			len_size_ = static_cast<size_t>(len);
			pos_ += len_size_;
			return true;
		}
		case 5: // fixed32: skip 4 bytes, keep iterating
			if (pos_ + 4 > size_) {
				throw IOException("lb_proto_wire: truncated fixed32 in field %llu",
				                  static_cast<unsigned long long>(field_));
			}
			pos_ += 4;
			continue;
		default: // 3/4 groups and 6/7 reserved
			throw IOException("lb_proto_wire: unsupported protobuf wire type %llu in field %llu",
			                  static_cast<unsigned long long>(wire_type_), static_cast<unsigned long long>(field_));
		}
	}
	return false;
}

uint32_t ProtoReader::Field() const {
	return field_;
}

uint32_t ProtoReader::WireType() const {
	return wire_type_;
}

uint64_t ProtoReader::GetVarint() const {
	if (wire_type_ != 0) {
		throw IOException("lb_proto_wire: field %llu is not a varint (wire type %llu)",
		                  static_cast<unsigned long long>(field_), static_cast<unsigned long long>(wire_type_));
	}
	return varint_value_;
}

std::string ProtoReader::GetString() const {
	if (wire_type_ != 2) {
		throw IOException("lb_proto_wire: field %llu is not length-delimited (wire type %llu)",
		                  static_cast<unsigned long long>(field_), static_cast<unsigned long long>(wire_type_));
	}
	return std::string(reinterpret_cast<const char *>(len_data_), len_size_);
}

std::vector<uint8_t> ProtoReader::GetBytes() const {
	if (wire_type_ != 2) {
		throw IOException("lb_proto_wire: field %llu is not length-delimited (wire type %llu)",
		                  static_cast<unsigned long long>(field_), static_cast<unsigned long long>(wire_type_));
	}
	return std::vector<uint8_t>(len_data_, len_data_ + len_size_);
}

} // namespace duckdb
