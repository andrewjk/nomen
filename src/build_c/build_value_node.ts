import reencode_hex_escapes from "../build_common/string_escapes.ts";
import string_literal_length from "../build_common/string_literal_length.ts";
import { is_int_literal } from "../int_literal.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_char_literal from "./utils/c_char_literal.ts";
import c_function_name from "./utils/c_function_name.ts";
import { materialize_func_value } from "./utils/closure.ts";

const INT_LITERAL_SUFFIX: Record<string, string> = {
	int: "L",
	uint: "UL",
	int64: "LL",
	uint64: "ULL",
};

export default function build_value_node(node: ValueNode, status: BuildStatus) {
	let value = node.value;
	// A top-level non-primitive `const` (e.g. geometry-type constants like
	// `DEFAULT_PARAMS`) is inlined at every use site rather than emitted as a
	// file-scope global — the initializer is typically a struct constructor
	// call, which is not a valid C file-scope constant expression. Build the
	// const's initializer in place; named-field overrides are applied by the
	// caller (build_declaration_node / build_assignment_node) via
	// `emit_field_overrides` once the destination slot is known.
	const inlined = status.top_level_consts?.get(value);
	if (inlined?.value) {
		build_node(inlined.value, status);
		return;
	}
	// Shorthand enum case `.case` (rewritten by the checker to `Enum_case`
	// with is_enum_shorthand=true). For an enum with associated data, the
	// no-arg case must still construct the tagged-union struct via its
	// `_init()` (matching `Enum.case` access calls); a simple enum emits the
	// tag constant directly.
	if (node.is_enum_shorthand) {
		const enum_node = status.enums.find((e) => value.startsWith(e.name + "_"));
		if (enum_node) {
			if (enum_node.has_associated_data) {
				status.code += `${value}_init()`;
			} else {
				status.code += value;
			}
			return;
		}
	}
	if (value === "null") value = "0";
	else if (value === "true") value = "1";
	else if (value === "false") value = "0";
	else if (value === "default") value = "_nomen_default";
	else if (is_int_literal(value)) {
		// Nomen integer literals default to `int` (C `long`, 64-bit). Emit the
		// matching C suffix so the literal is the right width: a bare `1` in C
		// is `int` (32-bit), making `1 << 63` undefined behavior. Hex/octal/
		// binary literals are passed through to C verbatim — C accepts the same
		// `0x`/`0o`/`0b` prefixes — with the width suffix appended. Underscore
		// digit separators are stripped (C uses `'`, not `_`).
		value = value.replace(/_/g, "") + (INT_LITERAL_SUFFIX[node.type?.name ?? "int"] ?? "");
	} else if (node.resolved_function) {
		// A bare function reference used as a VALUE (any resolved function —
		// nested or top-level). It materializes its closure DESCRIPTOR
		// (docs/CLOSURE_PLAN.md): a bare code pointer can't be invoked
		// through the { code, env } ABI. (A function CALL is a func_call
		// node and never reaches build_value_node.)
		status.code += materialize_func_value(node.resolved_function, status);
		return;
	} else if (value.startsWith("'") && value.endsWith("'")) {
		value = c_char_literal(value);
	} else value = c_function_name(value);
	// `self` is always a pointer in the generated C (matching aarch64):
	// regular methods receive `struct T *self`, and a custom #init uses a
	// local by-value `self` (self_is_local). The former `_self = *self` copy
	// is kept as dead code for compatibility with any code that still
	// references it, but all reads/writes now go through `self->field`.
	// A var/ref param is emitted as a pointer (see build_parameter_node), so
	// each use must dereference it to get the underlying value. Uses where the
	// address is needed (`&x` for forwarding to another ref param, `self` as a
	// pointer for method dispatch) prefix `&` themselves; `&*x` is valid C and
	// simplifies to `x`, so those callers stay correct.
	// Escape raw control characters in string literals so they are valid C
	// (multi-line Nomen strings have actual newlines that C rejects inside "...").
	// A string literal is a fat nomen_string VALUE: wrap it in a rodata
	// compound literal { ptr, sizeof-1 } — no allocation, no strlen, and the
	// NUL inside the C literal terminates the buffer for libc consumers.
	if (value.startsWith('"')) {
		value = `nomen_str_lit(${escape_c_string(value)}, ${string_literal_length(value)})`;
	}
	if (value !== "self" && status.function_ref_params?.has(value) && !status.suppress_dereference) {
		status.code += `*`;
	}
	// `self` is emitted as a pointer in regular methods (it lives in
	// function_ref_params — see build_struct_node). A value-use (e.g. the
	// RHS of `var T c = self`) must dereference it; callers that need the
	// address (field access `self.x` → `self->x`, method dispatch, ref-param
	// forwarding) set suppress_dereference, so they get the bare pointer.
	// A custom #init uses a local by-value `self` (self_is_local), which is
	// never in function_ref_params, so this branch is skipped there.
	if (value === "self" && status.function_ref_params?.has("self") && !status.suppress_dereference) {
		status.code += `*`;
	}
	// A `ref` class param is a double pointer (`struct T **`); a value-use
	// reads the underlying instance pointer, so dereference once. Callers that
	// need the address (`&h` write-back, forwarding) set suppress_dereference.
	if (value !== "self" && status.ref_class_params?.has(value) && !status.suppress_dereference) {
		status.code += `(*${value})`;
		return;
	}
	status.code += value;
}

function escape_c_string(s: string): string {
	// Escape RAW control characters (from multi-line strings), then
	// re-encode source `\xHH` hex escapes as 3-digit octal — clang consumes
	// `\x` greedily (all following hex digits), so `"\x01AMP"` would decode
	// `\x01A` as one byte and longer runs exceed the byte range (see
	// build_common/string_escapes.ts).
	return reencode_hex_escapes(s.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t"));
}
