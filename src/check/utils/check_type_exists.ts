import add_error from "../../add_error.ts";
import Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";
import type_name from "./type_name.ts";

export default function check_type_exists(type: Type, status: CheckStatus, start: number): boolean {
	// Tuple types are validated element-by-element; the auto-generated struct
	// is materialized later (see materialize_tuple_type).
	if (type.name === "tuple" && type.tuple_types?.length) {
		let ok = true;
		for (const elem of type.tuple_types) {
			if (!check_type_exists(elem, status, start)) ok = false;
		}
		return ok;
	}
	if (!status.types.includes(type.name)) {
		add_error(status, `Unknown type: ${type_name(type)}`, start);
		return false;
	}
	if (type.tuple_types) {
		for (const elem of type.tuple_types) {
			check_type_exists(elem, status, start);
		}
	}
	if (type.type_args) {
		for (const arg of type.type_args) {
			check_type_exists(arg, status, start);
		}
	}
	return true;
}
