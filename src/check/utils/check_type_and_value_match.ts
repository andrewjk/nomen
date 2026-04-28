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

function can_coerce(target_type: string, value_type: string, value: string) {
	// TODO: Should we do this with a trait?
	// TODO: Also fix those bitwise operations, I just threw them in there
	// TODO: Also make sure ints aren't floats
	switch (target_type) {
		case "bool":
			return ["true", "false"].includes(value);
		case "int":
			return ["int8", "int16", "int32"].includes(value_type) || int_is_valid(parseInt(value), 32);
		case "uint":
			return ["int8", "int16", "int32"].includes(value_type) || uint_is_valid(parseInt(value), 32);
		case "int8":
			return int_is_valid(parseInt(value), 8);
		case "uint8":
			return uint_is_valid(parseInt(value), 8);
		case "int16":
			return ["int8", "int16"].includes(value_type) || int_is_valid(parseInt(value), 16);
		case "uint16":
			return ["int8", "int16"].includes(value_type) || uint_is_valid(parseInt(value), 16);
		case "int32":
			return ["int8", "int16", "int"].includes(value_type) || int_is_valid(parseInt(value), 32);
		case "uint32":
			return ["int8", "int16", "int"].includes(value_type) || uint_is_valid(parseInt(value), 32);
		case "int64":
			return (
				["int8", "int16", "int32", "int"].includes(value_type) || int_is_valid(parseInt(value), 64)
			);
		case "uint64":
			return (
				["int8", "int16", "int32", "int"].includes(value_type) || uint_is_valid(parseInt(value), 64)
			);
		//case "float":
		//  return "float";
		//case "ufloat":
		//  // TODO: Uh
		//  return "unsigned float";
		//case "float32":
		//  return "float";
		//case "ufloat32":
		//  return "unsigned float";
		//case "float64":
		//  return "double";
		//case "ufloat64":
		//  return "unsigned double";
		//case "char":
		//  // TODO:
		//  return "char";
		//case "string":
		//  return "char*";
		default:
			return false;
	}
}

function int_is_valid(int: number, bits: number) {
	const max = Math.pow(2, bits - 1);
	return int > -1 * max && int < max;
}

function uint_is_valid(uint: number, bits: number) {
	const max = Math.pow(2, bits);
	return uint >= 0 && uint < max;
}
