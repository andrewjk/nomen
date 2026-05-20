import Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";

export default function type_from_value(value: string, status: CheckStatus): Type {
	// Is it a value that's been declared in a var/const or param?
	const decl_value = status.values.findLast((v) => v.name === value);
	if (decl_value) {
		return decl_value.type;
	}

	// Is it a struct?
	const struct_value = status.structs.findLast((s) => s.name === value);
	if (struct_value) {
		// NOTE: Maybe we should be storing this type on the struct?
		return new Type(struct_value.name);
	}

	// Is it an enum?
	const enum_value = status.enums.findLast((e) => e.name === value);
	if (enum_value) {
		return new Type(enum_value.name);
	}

	// Is it a bitset?
	const bitset_value = status.bitsets.findLast((b) => b.name === value);
	if (bitset_value) {
		return new Type(bitset_value.name);
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
	} else if (/^(\+|-)*\d+$/.test(value)) {
		return new Type("int", true);
	} else if (/^(\+|-)*\d+.\d+$/.test(value)) {
		return new Type("float", true);
	} else {
		return new Type("");
	}
}
