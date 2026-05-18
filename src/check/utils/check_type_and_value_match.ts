import add_error from "../../add_error.ts";
import Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";
import type_name from "./type_name.ts";

export default function check_type_and_value_match(
	/** The target type, which is being assigned to */
	target_type: Type,
	/** The value type, which is being assigned */
	value_type: Type,
	value: string,
	status: CheckStatus,
	i: number,
	/** The type of node that is being checked, for showing in error messages */
	node_type: string,
) {
	if (!target_type.name && !value_type.name) {
		// Trying to assign an unknown value to an unknown type e.g. const x = y
		add_error_message(status, i, node_type, `unknown value ${value}`);
	} else if (!target_type.name && value_type.name) {
		// Trying to assign a known value to an unknown type -- that's actually ok e.g. const x = 5
	} else if (target_type.name && !value_type.name) {
		// Trying to assign an unknown value to a known type e.g. const x: int = y
		add_error_message(status, i, node_type, `unknown value ${value}`, type_name(target_type));
	} else if (target_type.name && value_type.name) {
		if (target_type.is_array !== value_type.is_array) {
			// Trying to assign a non-array to an array or vice-versa
			add_error_message(status, i, node_type, type_name(value_type), type_name(target_type));
		} else if (value_type.name === "null" && target_type.is_nullable) {
			// Assigning null to a nullable type is ok
			return;
		} else if (target_type.name !== value_type.name) {
			// It might be a type that can be coerced
			if (can_coerce(target_type.name, value_type.name, value)) {
				return;
			}

			// It might be a struct with a matching trait
			// TODO: Check this in more places
			const struct = status.structs.find((f) => f.name === value_type.name);
			if (struct?.traits.includes(target_type.name)) {
				return;
			}

			// null assigned to non-nullable?
			if (value_type.name === "null" && !target_type.is_nullable) {
				add_error_message(status, i, node_type, "null", type_name(target_type));
				return;
			}
			// Trying to assign an invalid type
			add_error_message(status, i, node_type, type_name(value_type), type_name(target_type));
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

const INT_TYPES = ["int8", "int16", "int32", "int", "int64"];
const UINT_TYPES = ["uint8", "uint16", "uint32", "uint", "uint64"];
const ALL_INT_TYPES = [...INT_TYPES, ...UINT_TYPES];

function can_coerce(target_type: string, value_type: string, value: string) {
	if (value === "?") {
		return can_coerce_type(target_type, value_type);
	}
	const num = parseInt(value);
	if (!Number.isNaN(num)) {
		switch (target_type) {
			case "bool":
				return false;
			case "int":
				return int_is_valid(num, 32);
			case "uint":
				return uint_is_valid(num, 32);
			case "int8":
				return int_is_valid(num, 8);
			case "uint8":
				return uint_is_valid(num, 8);
			case "int16":
				return int_is_valid(num, 16);
			case "uint16":
				return uint_is_valid(num, 16);
			case "int32":
				return int_is_valid(num, 32);
			case "uint32":
				return uint_is_valid(num, 32);
			case "int64":
				return int_is_valid(num, 64);
			case "uint64":
				return uint_is_valid(num, 64);
		}
	}
	return can_coerce_type(target_type, value_type);
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
	if (target_idx === -1 || value_idx === -1) return false;
	const target_is_uint = UINT_TYPES.includes(target_type);
	const value_is_uint = UINT_TYPES.includes(value_type);
	if (value_is_uint && !target_is_uint) {
		const target_bits = type_bits(target_type);
		const value_bits = type_bits(value_type);
		return target_bits > value_bits;
	}
	return target_idx >= value_idx;
}

function type_bits(t: string): number {
	switch (t) {
		case "int8":
		case "uint8":
			return 8;
		case "int16":
		case "uint16":
			return 16;
		case "int32":
		case "uint32":
		case "int":
		case "uint":
			return 32;
		case "int64":
		case "uint64":
			return 64;
		default:
			return 0;
	}
}
