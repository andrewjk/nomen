import FunctionNode from "../../nodes/FunctionNode.ts";
import type ParameterNode from "../../nodes/ParameterNode.ts";
import type RawNode from "../../nodes/RawNode.ts";
import type StructNode from "../../nodes/StructNode.ts";
import { parse_raw_directives } from "../../raw_directives.ts";
import type BuildStatus from "../BuildStatus.ts";
import c_function_name from "./c_function_name.ts";
import c_type from "./c_type.ts";

/**
 * Raw-block string ABI marshalling.
 *
 * A fat `string` is a 16-byte nomen_string value, but raw `#arch: c` bodies
 * (String.nm's libc calls, every `*_to_string`, File/Http/Directory FFI,
 * Console printf) are written against the thin `char*` representation. For a
 * raw-only function whose signature involves a `string` param or return, the
 * body is emitted verbatim under a `_raw_<name>` label with the THIN ABI
 * (string → char*, ref string → char**), and a compiler-generated adapter
 * carries the real fat name:
 *
 *   nomen_string f(nomen_string s) {
 *       char* _r = _raw_f(s.ptr);
 *       return (nomen_string){ _r, (long)strlen(_r) };
 *   }
 *
 * so the length is synthesized exactly once, at the creation boundary. A
 * `ref string` param passes `&p.ptr` (the raw body writes bytes in place
 * through the same buffer; the pointer value itself never changes). Buffers
 * stay NUL-terminated at ptr[len] for libc/FFI.
 *
 * Methods of monomorphized generic containers (Buffer_<T>, Array_<T>,
 * ClassBuffer_<T>, List_<T>) are EXEMPT: their raw bodies are written against
 * the generic `T`, and the checker's raw-type substitution (raw_c_type_name)
 * rewrites T to `nomen_string`, making the body natively fat-correct.
 */

/** Struct name prefixes whose raw bodies are written against generic `T`. */
const T_GENERIC_PREFIXES = ["Buffer_", "Array_", "ClassBuffer_", "List_", "Map_", "Set_"];

export function is_t_generic_struct(name: string | undefined): boolean {
	return !!name && T_GENERIC_PREFIXES.some((p) => name.startsWith(p));
}

function signature_has_string(func: FunctionNode): boolean {
	if (
		func.return_type?.name === "string" &&
		!func.return_type.is_array &&
		!func.return_type.is_view
	)
		return true;
	return func.params.some(
		(p) =>
			!p.is_variadic &&
			!p.is_variadic_tuple &&
			p.type.name === "string" &&
			!p.type.is_array &&
			!p.type.is_view &&
			!p.type.is_nullable,
	);
}

/**
 * Whether this function's raw-only body must be emitted under the thin
 * `_raw_` ABI with a marshalling adapter (see the module doc). `false` for
 * non-raw bodies (normal codegen is natively fat), T-generic container
 * methods (native via substitution), and signatures with no string
 * involvement (nothing to marshal).
 */
export function raw_string_abi_needed(
	func: FunctionNode,
	struct: StructNode | undefined,
	platform: string,
): boolean {
	if (!func.statements.length || !func.statements.every((s) => s.node_type === "raw")) return false;
	if (is_t_generic_struct(struct?.name)) return false;
	if (!signature_has_string(func)) return false;
	// Only marshal when a block actually emits for this target — the sibling
	// arch variant (e.g. the aarch64 asm under the C backend) is skipped and
	// needs no adapter.
	return (func.statements as RawNode[]).some((s) => {
		const { should_emit, code } = parse_raw_directives(s.value, "c", platform);
		return should_emit && !!code;
	});
}

/**
 * Emit the fat adapter for a thin `_raw_` body plus its prototype in the
 * headers. `fat_label` is the real (unprefixed) C label; the thin body was
 * emitted as `_raw_${fat_label}`. Params are declared with build_parameter_node
 * (fat types), and the thin call args pass `.ptr` for strings.
 */
export function emit_raw_string_adapter(
	func: FunctionNode,
	fat_label: string,
	status: BuildStatus,
	param_emitter: (p: ParameterNode, status: BuildStatus) => void,
): void {
	const raw_label = `_raw_${fat_label}`;
	const returns_string =
		func.return_type?.name === "string" && !func.return_type.is_array && !func.return_type.is_view;
	const returns_void = !func.return_type?.name || func.return_type.name === "void";

	// Adapter signature (fat ABI) → code + header prototype.
	const sig_start = status.code.length;
	if (returns_string) {
		status.code += `nomen_string ${fat_label}(`;
	} else if (func.return_type?.is_view) {
		status.code += `nomen_view ${fat_label}(`;
	} else if (func.return_type?.name && !returns_void) {
		const rt = func.return_type.name;
		const rs = status.structs.find((s) => s.name === rt && !s.is_simple_type);
		status.code += rs ? `struct ${rt} ${fat_label}(` : `${c_type(rt)} ${fat_label}(`;
	} else {
		status.code += `void ${fat_label}(`;
	}
	let first = true;
	for (const param of func.params) {
		if (!first) status.code += ", ";
		first = false;
		param_emitter(param, status);
	}
	status.code += `)`;
	status.headers += `${status.code.substring(sig_start)};\n`;

	status.code += `\n{\n`;
	const call_args = func.params
		.map((p) => {
			const pname = c_function_name(p.name);
			if (p.type.name === "string" && !p.type.is_array && !p.type.is_view) {
				// A by-value fat param passes its thin ptr half; a `ref
				// string` param is a `nomen_string *` — take the address of
				// the ptr field so the raw body can write bytes in place.
				return p.is_ref || p.type.is_ref ? `&${pname}->ptr` : `${pname}.ptr`;
			}
			return pname;
		})
		.join(", ");
	if (returns_string) {
		status.code += `char* _r = ${raw_label}(${call_args});\n`;
		status.code += `return (nomen_string){ _r, (long)strlen(_r) };\n`;
	} else if (returns_void) {
		status.code += `${raw_label}(${call_args});\n`;
	} else {
		status.code += `return ${raw_label}(${call_args});\n`;
	}
	status.code += `}\n`;
}
