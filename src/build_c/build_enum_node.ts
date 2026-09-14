import EnumNode from "../nodes/EnumNode.ts";
import type Type from "../nodes/Type.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type, { c_typedef_name } from "./utils/c_type.ts";

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

	if (node.has_associated_data) {
		build_tagged_union_enum(node, status);
	} else {
		build_simple_enum(node, status);
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

function build_simple_enum(node: EnumNode, status: BuildStatus) {
	// Emit the typedef enum only in the header (which the .m includes), so the
	// definition isn't duplicated between the two files. The typedef name is
	// mangled on GUI builds (MacTypes collision); the enum constants
	// (`Name_case`) are plain symbols, unaffected.
	status.headers += `typedef enum { ${node.cases.map((c) => `${node.name}_${c.name}`).join(", ")} } ${c_typedef_name(node.name)};\n`;
}

function build_tagged_union_enum(node: EnumNode, status: BuildStatus) {
	// Tagged-union enums: emit tag typedef + struct typedef only in the header
	// (the .m includes it), avoiding duplicate definitions across files. Both
	// the tag enum and the struct typedef names are mangled on GUI builds; the
	// struct TAG (`struct Foo`) and the case constants stay plain.
	status.headers += `typedef enum { ${node.cases.map((c) => `${node.name}_${c.name}`).join(", ")} } ${c_typedef_name(node.name + "_tag")};\n`;
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
				// payload copies the owning pointer (construction transfers
				// ownership — see the check-time borrow rejection).
				status.code += `r._data._${c.name}.${p.name} = ${p.name};\n`;
			}
		}
		status.code += `return r;\n`;
		status.code += `}\n`;
	}
}
