import {
	enum_payload_deep_copy_struct,
	enum_payload_destroy_struct,
} from "../build_common/destroy_analysis.ts";
import EnumNode from "../nodes/EnumNode.ts";
import type Type from "../nodes/Type.ts";
import { emit_struct_destroys } from "./build_auto_free.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type, { c_typedef_name } from "./utils/c_type.ts";
import { begin_code_scratch, end_code_scratch } from "./utils/code_scratch.ts";

export default function build_enum_node(node: EnumNode, status: BuildStatus) {
	// Generic enums are templates — only their monomorphized forms (created
	// during check, registered as their own EnumNodes) have a concrete layout.
	if (node.is_generic) return;

	// Idempotency guard: an enum may be emitted early — pulled to root scope
	// as a dependency of a monomorphized enum (emit_enum_in_order) — before
	// the function body that declares it is built (emit_nested_declarations).
	// Without the guard the typedef would be emitted twice.
	if (!status.emitted_enums) status.emitted_enums = new Set();
	if (status.emitted_enums.has(node.name)) return;
	status.emitted_enums.add(node.name);

	status.headers += `// Enum ${node.name}\n`;
	status.code += `// Enum ${node.name}\n`;

	// A case mono's single case keeps the BASE enum's tag value (tag_index),
	// so a mono value's tag compares equal to the base case in match/==.
	const tag_value = (c: { name: string; tag_index?: number }, i: number): string =>
		c.tag_index !== undefined && c.tag_index !== i
			? `${node.name}_${c.name} = ${c.tag_index}`
			: `${node.name}_${c.name}`;

	if (node.has_associated_data) {
		build_tagged_union_enum(node, status, tag_value);
	} else {
		build_simple_enum(node, status, tag_value);
	}

	status.headers += "\n";
	status.code += "\n";
}

/**
 * Whether an enum case payload of this type is a REFERENCE value (a class
 * instance pointer or a trait object). Such a payload rides as
 * `struct Tag *` — a by-value `Tag` field would need the full typedef before
 * the enum's header block (and would byte-copy the instance, sharing
 * ownership). The tag form only needs the forward declaration the header
 * already carries, so mono enums referencing user classes order-independently.
 */
function payload_is_reference(type: Type, status: BuildStatus): boolean {
	if (!type.name || type.is_array) return false;
	const struct = status.structs.find((s) => s.name === type.name);
	if (struct?.is_class) return true;
	return !!status.traits.find((t) => t.name === type.name);
}

/** The C declaration spelling for a case payload. */
function payload_c_decl(type: Type, name: string, status: BuildStatus): string {
	if (payload_is_reference(type, status)) {
		return `struct ${type.name} *${name}`;
	}
	return `${c_type(type.name)} ${name}`;
}

function build_simple_enum(
	node: EnumNode,
	status: BuildStatus,
	tag_value: (c: { name: string; tag_index?: number }, i: number) => string,
) {
	// Emit the typedef enum only in the header (which the .m includes), so the
	// definition isn't duplicated between the two files. The typedef name is
	// mangled on GUI builds (MacTypes collision); the enum constants
	// (`Name_case`) are plain symbols, unaffected. A case's tag VALUE is its
	// original declaration index (case monos carry a base-enum tag).
	status.headers += `typedef enum { ${node.cases.map(tag_value).join(", ")} } ${c_typedef_name(node.name)};\n`;
}

function build_tagged_union_enum(
	node: EnumNode,
	status: BuildStatus,
	tag_value: (c: { name: string; tag_index?: number }, i: number) => string,
) {
	// Tagged-union enums: emit tag typedef + struct typedef only in the header
	// (the .m includes it), avoiding duplicate definitions across files. Both
	// the tag enum and the struct typedef names are mangled on GUI builds; the
	// struct TAG (`struct Foo`) and the case constants stay plain. A case's
	// tag VALUE is its original declaration index (case monos carry a
	// base-enum tag, so a mono value matches the base case in match/==).
	status.headers += `typedef enum { ${node.cases.map(tag_value).join(", ")} } ${c_typedef_name(node.name + "_tag")};\n`;
	status.headers += `struct ${node.name};\n`;
	status.headers += `typedef struct ${node.name}\n{\n`;
	status.headers += `${c_typedef_name(node.name + "_tag")} tag;\n`;
	status.headers += `union {\n`;
	for (const c of node.cases) {
		status.headers += `struct { ${c.params.map((p) => payload_c_decl(p.type, p.name, status)).join("; ")}${c.params.length ? ";" : ""} } _${c.name};\n`;
	}
	status.headers += `} _data;\n`;
	status.headers += `} ${c_typedef_name(node.name)};\n`;

	for (const c of node.cases) {
		const ctor_params = c.params.map((p) => payload_c_decl(p.type, p.name, status)).join(", ");
		const ctor = `${c_typedef_name(node.name)} ${node.name}_${c.name}_init(${ctor_params})`;
		status.headers += `${ctor};\n`;
		status.code += `${ctor}\n{\n`;
		status.code += `${c_typedef_name(node.name)} r;\n`;
		status.code += `r.tag = ${node.name}_${c.name};\n`;
		for (const p of c.params) {
			if (p.type.name === "string" && !payload_is_reference(p.type, status)) {
				// A string payload is an OWNED copy: strdup the argument so the
				// enum value's lifetime is independent of the producer's local
				// (which is freed at its own scope exit). Bitwise assignment
				// would leave the payload dangling after that free.
				status.code += `r._data._${c.name}.${p.name}.ptr = strdup(${p.name}.ptr);\n`;
				status.code += `r._data._${c.name}.${p.name}.len = ${p.name}.len;\n`;
			} else {
				// Scalars and value structs copy by value; a class/trait
				// payload copies the mv pointer (construction transfers
				// ownership — see the check-time borrow rejection).
				status.code += `r._data._${c.name}.${p.name} = ${p.name};\n`;
			}
		}
		status.code += `return r;\n`;
		status.code += `}\n`;
	}

	// Ownership helpers, emitted for EVERY data-carrying enum (struct fields
	// of this enum type call them at the store sites and in
	// `<Struct>_destroy`, so they must exist regardless of whether the
	// payloads happen to be mv — the mono call sites don't re-derive
	// that).
	const mv = true;
	if (mv) {
		status.headers += `void ${node.name}_free_payloads(${c_typedef_name(node.name)}* v);\n`;
		status.code += `void ${node.name}_free_payloads(${c_typedef_name(node.name)}* v)\n{\n`;
		let first = true;
		for (const c of node.cases) {
			const stmts: string[] = [];
			for (const p of c.params) {
				const ref = payload_is_reference(p.type, status);
				if (p.type.name === "string" && !ref) {
					stmts.push(`free(v->_data._${c.name}.${p.name}.ptr);`);
				} else if (ref) {
					stmts.push(`${p.type.name}_destroy(v->_data._${c.name}.${p.name});`);
					stmts.push(`free(v->_data._${c.name}.${p.name});`);
				} else {
					// A mv-STRUCT payload owns its heap state (case construction
					// transfers it — enforce_case_payload_ownership): reclaim it
					// through the struct's destroy walk — the user `#destroy`
					// (side effects), the uniformly-heap string fields, and the
					// nested owned fields recursively — the same treatment a
					// struct local gets at scope exit (emit_struct_destroys).
					const p_struct = enum_payload_destroy_struct(p, status);
					if (!p_struct) continue;
					const saved = begin_code_scratch(status);
					emit_struct_destroys(status, p_struct, `v->_data._${c.name}.${p.name}`);
					const captured = end_code_scratch(status, saved);
					if (captured.trim()) stmts.push(captured.trim());
				}
			}
			if (!stmts.length) continue;
			status.code += `${first ? "if" : "else if"} (v->tag == ${node.name}_${c.name}) {\n${stmts.join("\n")}\n}\n`;
			first = false;
		}
		status.code += `}\n`;

		status.headers += `${c_typedef_name(node.name)} ${node.name}_copy(${c_typedef_name(node.name)} src);\n`;
		status.code += `${c_typedef_name(node.name)} ${node.name}_copy(${c_typedef_name(node.name)} src)\n{\n`;
		status.code += `${c_typedef_name(node.name)} r = src;\n`;
		for (const c of node.cases) {
			for (const p of c.params) {
				const ref = payload_is_reference(p.type, status);
				if (p.type.name === "string" && !ref) {
					status.code += `if (r.tag == ${node.name}_${c.name}) { r._data._${c.name}.${p.name}.ptr = strdup(r._data._${c.name}.${p.name}.ptr); }\n`;
				} else if (!ref) {
					// A mv-STRUCT payload: byte-copying the blob would share the
					// payload's owned heap state with the source — both deaths
					// destroy it (free_payloads). Deep-copy through the
					// payload's `copy` when it has one; an owning payload
					// WITHOUT a copy story keeps the enum non-deep-copyable
					// (enum_copy_is_deep reports false — the same posture as
					// reference payloads) and callers transfer instead.
					const p_struct = enum_payload_deep_copy_struct(p, status);
					if (!p_struct) continue;
					status.code += `if (r.tag == ${node.name}_${c.name}) { r._data._${c.name}.${p.name} = ${p_struct.name}_copy(&r._data._${c.name}.${p.name}); }\n`;
				}
			}
		}
		status.code += `return r;\n`;
		status.code += `}\n`;
	}
}

/**
 * Emit the `<Enum>_<case>_init_take` variant the enum-payload in-place
 * tranche (PERF_PLAN item 7) calls at a stamped construction site: the
 * checker proved every string payload's argument is a direct call, and the
 * C backend's string-return convention hands every call result a fresh heap
 * buffer the caller owns — so the take variant assigns each string payload
 * RAW (no strdup; the produced buffer IS the payload, freeing the hoisted
 * `_param_N` temp and its scope-exit free) while every other payload copies
 * exactly like `_init`. An unstamped site keeps calling `_init` (its strdup
 * makes the payload independent of the argument's storage), so both
 * variants coexist.
 *
 * Discovered at construction sites — inside function bodies — so the
 * definition buffers into `status.enum_case_take_definitions` (flushed at
 * file scope by build_root_node, mirroring `box_clone_definitions`) with the
 * prototype in headers. Deduped per TU via `emitted_enum_case_takes`.
 */
export function ensure_enum_case_take_c(
	enum_node: EnumNode,
	case_index: number,
	status: BuildStatus,
): void {
	const c = enum_node.cases[case_index];
	if (!c) return;
	if (!status.emitted_enum_case_takes) status.emitted_enum_case_takes = new Set();
	const key = `${enum_node.name}_${c.name}`;
	if (status.emitted_enum_case_takes.has(key)) return;
	status.emitted_enum_case_takes.add(key);
	const take = `${key}_init_take`;
	const ctor_params = c.params.map((p) => payload_c_decl(p.type, p.name, status)).join(", ");
	status.headers += `${c_typedef_name(enum_node.name)} ${take}(${ctor_params});\n`;
	const out: string[] = [];
	out.push(`${c_typedef_name(enum_node.name)} ${take}(${ctor_params})\n{\n`);
	out.push(`${c_typedef_name(enum_node.name)} r;\n`);
	out.push(`r.tag = ${enum_node.name}_${c.name};\n`);
	for (const p of c.params) {
		// A string payload takes its argument's fresh heap buffer raw (the
		// whole point of the variant); every other payload — scalar, value
		// struct, class/trait handle — copies exactly like `_init`
		// (construction transfers mv pointers — see
		// enforce_case_payload_ownership).
		out.push(`r._data._${c.name}.${p.name} = ${p.name};\n`);
	}
	out.push(`return r;\n`);
	out.push(`}\n`);
	status.enum_case_take_definitions = (status.enum_case_take_definitions ?? "") + out.join("");
}
