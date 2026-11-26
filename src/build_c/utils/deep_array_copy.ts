import { element_copy_struct } from "../../build_common/element_copy.ts";
import type Type from "../../nodes/Type.ts";
import type BuildStatus from "../BuildStatus.ts";
import array_elem_c_type from "./array_elem_c_type.ts";

/**
 * A C expression that deep-copies the nested heap array `src` of `type`
 * (`xs.copy()` with `deep_array_copy`): a fresh buffer at every level, each
 * row copied recursively, and the innermost slots copied like the library
 * `Array.copy` does (strings get their own bytes, a struct element goes
 * through its own `copy()`, everything else byte-copies).
 */
export default function deep_array_copy_c(
	status: BuildStatus,
	type: Type,
	src: string,
	depth = 0,
): string {
	const s = `_dcs${depth}`;
	const d = `_dcd${depth}`;
	const n = `_dcn${depth}`;
	const k = `_dck${depth}`;
	const header = `sizeof(struct Array_${type.name})`;
	const slot = array_elem_c_type(type);
	let copy_slot: string;
	const from = `((${slot}*)((char*)${s} + ${header}))[${k}]`;
	if (type.elem) {
		copy_slot = deep_array_copy_c(status, type.elem, from, depth + 1);
	} else if (type.name === "string") {
		copy_slot = `nomen_str_dup(${from})`;
	} else if (element_copy_struct(type.name, status.structs)) {
		copy_slot = `${type.name}_copy(&${from})`;
	} else {
		copy_slot = from;
	}
	return (
		`({ struct Array_${type.name}* ${s} = (struct Array_${type.name}*)(${src}); ` +
		`long ${n} = ${s}->length; ` +
		`struct Array_${type.name}* ${d} = malloc(${header} + ${n} * sizeof(${slot})); ` +
		`${d}->_vt = 0; ${d}->length = ${n}; ` +
		`for (long ${k} = 0; ${k} < ${n}; ${k}++) { ` +
		`((${slot}*)((char*)${d} + ${header}))[${k}] = ${copy_slot}; } ` +
		`${d}; })`
	);
}
