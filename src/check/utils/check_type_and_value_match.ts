import add_error from "../../add_error.ts";
import { mono_type_name } from "../../build_common/mono_name.ts";
import {
	ALL_INT_TYPES,
	UINT_TYPES,
	is_float_type,
	is_int_type,
	is_signed_float_type,
	is_unsigned_int_type,
	type_bits,
} from "../../built_in_types.ts";
import { parse_int_literal, parse_int_literal_bigint } from "../../int_literal.ts";
import Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";
import { is_class_type } from "./ownership.ts";
import type_name from "./type_name.ts";

export default function check_type_and_value_match(
	target_type: Type,
	value_type: Type,
	value: string | undefined,
	status: CheckStatus,
	i: number,
	node_type: string,
) {
	const effective_target = target_type.is_ref
		? new Type(target_type.name, target_type.is_static, target_type.is_array, target_type.length)
		: target_type;
	if (effective_target !== target_type) {
		effective_target.is_nullable = target_type.is_nullable;
		effective_target.type_args = target_type.type_args;
	}
	if (!effective_target.name && !value_type.name) {
		add_error_message(status, i, node_type, `unknown value ${value}`);
	} else if (!effective_target.name && value_type.name) {
		// ok
	} else if (effective_target.name && !value_type.name) {
		add_error_message(status, i, node_type, `unknown value ${value}`, type_name(effective_target));
	} else if (effective_target.name && value_type.name) {
		if (effective_target.is_array !== value_type.is_array) {
			add_error_message(status, i, node_type, type_name(value_type), type_name(effective_target));
		} else if (value_type.name === "null" && effective_target.is_nullable) {
			return;
		} else if (effective_target.name === "null" && value_type.is_nullable) {
			return;
		} else if (effective_target.name !== value_type.name) {
			if (is_type_param(effective_target.name, status)) {
				return;
			}
			if (is_type_param(value_type.name, status)) {
				return;
			}
			if (can_coerce(effective_target.name, value_type.name, value)) {
				return;
			}

			if (
				node_type !== "swap" &&
				can_class_int_coerce(effective_target.name, value_type.name, status)
			) {
				return;
			}

			const struct = status.structs.find((f) => f.name === value_type.name);
			if (struct?.traits.includes(effective_target.name)) {
				return;
			}

			if (value_type.name === "null" && !effective_target.is_nullable) {
				add_error_message(status, i, node_type, "null", type_name(effective_target));
				return;
			}

			if (value_type.type_args?.length) {
				const mono_name = mono_type_name(value_type);
				if (mono_name === effective_target.name) return;
			}
			if (effective_target.type_args?.length) {
				const mono_name = mono_type_name(effective_target);
				if (mono_name === value_type.name) return;
			}

			add_error_message(status, i, node_type, type_name(value_type), type_name(effective_target));
		}
	}
}

function add_error_message(
	status: CheckStatus,
	i: number,
	node_type: string,
	value_type: string,
	expected_type?: string,
) {
	let message = `Type mismatch in ${node_type}: ${value_type}`;
	if (expected_type) {
		message += ` (expected ${expected_type})`;
	}
	add_error(status, message, i);
}

function can_coerce(target_type: string, value_type: string, value: string | undefined) {
	if (value === "?") {
		return can_coerce_type(target_type, value_type);
	}
	if (value === undefined) {
		return can_coerce_type(target_type, value_type);
	}
	const num = parse_int_literal(value);
	if (!Number.isNaN(num) && is_int_type(target_type)) {
		const bits = type_bits(target_type);
		// 64-bit range checks use BigInt so values near 2^63/2^64 (e.g.
		// 0xFFFFFFFFFFFFFFFF) aren't rounded by JS's double and wrongly rejected.
		if (bits === 64) {
			return is_unsigned_int_type(target_type) ? uint64_is_valid(value) : int64_is_valid(value);
		}
		return is_unsigned_int_type(target_type) ? uint_is_valid(num, bits) : int_is_valid(num, bits);
	}
	if (is_float_type(target_type) && is_numeric_literal(value)) {
		// A numeric literal coerces into any float width; unsigned floats
		// (`ufloat*`) only accept non-negative literals.
		return is_signed_float_type(target_type) || !value.trimStart().startsWith("-");
	}
	return can_coerce_type(target_type, value_type);
}

/** Integer or decimal literal (incl. sign/exponent), e.g. `2`, `-1.5`, `1e3`. */
function is_numeric_literal(value: string): boolean {
	return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value.trim());
}

// 64-bit range checks use BigInt so values near 2^63/2^64 (e.g.
// 0xFFFFFFFFFFFFFFFF) aren't rounded by JS's double and wrongly rejected.
function int64_is_valid(value: string): boolean {
	const n = parse_int_literal_bigint(value);
	if (n === null) return false;
	return n > -(2n ** 63n) && n < 2n ** 63n;
}

function uint64_is_valid(value: string): boolean {
	const n = parse_int_literal_bigint(value);
	if (n === null) return false;
	return n >= 0n && n < 2n ** 64n;
}

function int_is_valid(int: number, bits: number) {
	const max = Math.pow(2, bits - 1);
	return int > -1 * max && int < max;
}

function uint_is_valid(uint: number, bits: number) {
	const max = Math.pow(2, bits);
	return uint >= 0 && uint < max;
}

function can_coerce_type(target_type: string, value_type: string): boolean {
	const target_idx = ALL_INT_TYPES.indexOf(target_type);
	const value_idx = ALL_INT_TYPES.indexOf(value_type);
	if (target_idx === -1 || value_idx === -1) {
		// Floats: a signed float accepts any float; an unsigned float accepts
		// only unsigned floats (a signed one may be negative).
		if (is_float_type(target_type) && is_float_type(value_type)) {
			return is_signed_float_type(target_type) || !is_signed_float_type(value_type);
		}
		return false;
	}
	const target_is_uint = UINT_TYPES.includes(target_type);
	const value_is_uint = UINT_TYPES.includes(value_type);
	if (value_is_uint && !target_is_uint) {
		const target_bits = type_bits(target_type);
		const value_bits = type_bits(value_type);
		return target_bits > value_bits;
	}
	return target_idx >= value_idx;
}

function is_type_param(name: string, status: CheckStatus): boolean {
	if (status.type_params.includes(name)) return true;
	for (const s of status.structs) {
		if (s.type_params.includes(name)) return true;
	}
	return false;
}

function can_class_int_coerce(target: string, value: string, status: CheckStatus): boolean {
	if (target === "int" && is_class_type(value, status)) return true;
	if (is_class_type(target, status) && value === "int") return true;
	return false;
}
