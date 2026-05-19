import add_error from "../../add_error.ts";
import Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";
import type_name from "./type_name.ts";

export default function check_type_exists(type: Type, status: CheckStatus, start: number): boolean {
	if (!status.types.includes(type.name)) {
		add_error(status, `Unknown type: ${type_name(type)}`, start);
		return false;
	}
	if (type.type_args) {
		for (const arg of type.type_args) {
			check_type_exists(arg, status, start);
		}
	}
	return true;
}
