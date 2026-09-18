import { is_int_literal } from "../../int_literal.ts";
import Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";
import { maybe_record_capture } from "./captures.ts";
import resolve_declared_type from "./resolve_declared_type.ts";

export default function type_from_value(value: string, status: CheckStatus): Type {
	// `unsafe`-code generic constants: inside a generic struct's method, the
	// per-instantiation element size and representation flags are compile-time
	// constants named after the type parameter (`T_SIZE`, `T_NEEDS_STRDUP`,
	// `T_FAT`). The monomorphizer substitutes them with literals; here they
	// just need a type so the generic form of the body checks. Library-only:
	// these expose core representation facts (element layout, string-ness),
	// so a user generic's `T_SIZE` stays an unknown value.
	for (const tp of status.type_params) {
		if (value === `${tp}_SIZE` || value === `${tp}_NEEDS_STRDUP` || value === `${tp}_FAT`) {
			const in_library = status.stack.some(
				(n) => n.node_type === "func" && (n as { is_library?: boolean }).is_library,
			);
			if (in_library) {
				if (value.endsWith("_SIZE")) return new Type("int", true);
				return new Type("bool", true);
			}
			return new Type("");
		}
	}

	// Is it a value that's been declared in a var/const or param?
	const decl_index = status.values.findLastIndex((v) => v.name === value);
	const decl_value = decl_index >= 0 ? status.values[decl_index] : undefined;
	if (decl_value) {
		// A reference to an ENCLOSING function's value from a closure lambda is
		// a capture; recording here covers every reference form (reads, method
		// receivers, assignment targets) — see check/utils/captures.ts.
		maybe_record_capture(value, decl_value, decl_index, status);
		return decl_value.type;
	}

	// Is it a declared struct/enum/bitset? Resolve by SOURCE name so a nested
	// type on a scope-unique emission label still resolves here (and only
	// while its declaring function is in scope).
	const declared = resolve_declared_type(value, status);
	if (declared) {
		return new Type(declared.name);
	}

	const func_value = status.functions.findLast((f) => f.name === value);
	if (func_value) {
		return new Type("func");
	}

	// Is it an enum/bitset shorthand? (e.g. Direction_east)
	for (const e of status.enums) {
		if (value.startsWith(e.name + "_")) {
			const case_name = value.substring(e.name.length + 1);
			if (e.cases.some((c) => c.name === case_name)) {
				return new Type(e.name);
			}
		}
	}
	for (const b of status.bitsets) {
		if (value.startsWith(b.name + "_")) {
			const case_name = value.substring(b.name.length + 1);
			if (b.cases.includes(case_name)) {
				return new Type(b.name);
			}
		}
	}

	if (value === "null") {
		const t = new Type("null", true);
		t.is_nullable = true;
		return t;
	} else if (value === "true" || value === "false") {
		return new Type("bool", true);
	} else if (value.startsWith('"') && value.endsWith('"')) {
		return new Type("string", true);
	} else if (value.startsWith("'") && value.endsWith("'")) {
		return new Type("char", true);
	} else if (is_int_literal(value)) {
		return new Type("int", true);
	} else if (/^(\+|-)*\d+.\d+([eE](\+|-)?\d+)?$/.test(value)) {
		return new Type("float", true);
	} else {
		return new Type("");
	}
}
