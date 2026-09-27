import string_literal_length from "../build_common/string_literal_length.ts";
import type { NirExpr } from "../nir/nir.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import { escape_c_string } from "./build_value_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { emit_expr_from_nir } from "./emit_nir.ts";

/**
 * Build an array literal's `{a, b, c}` initializer text. Under NIR-driven
 * emission the index-aligned lowered element exprs ride in (`nir_elements`,
 * from `nir_array_elements`) and each element descends the expression seam;
 * without them — or for an element whose lowered expr doesn't carry that
 * exact AST node — it is exactly the historical `build_node(value)`.
 */
export default function build_array_values_node(
	node: ArrayValuesNode,
	status: BuildStatus,
	nir_elements?: readonly NirExpr[],
) {
	status.code += `{`;
	const elem_is_string = node.type?.name === "string";
	// A FILE-SCOPE fixed-size string array initializes statically: a
	// `nomen_str_dup` call is not a constant expression, so it is rejected
	// in a static initializer. Each literal element lowers to a plain
	// `{ ptr, len }` brace pair — the C string literal is an address
	// constant, so the whole initializer is constant. The elements are
	// rodata borrows: globals have no scope exit and own nothing.
	const static_init = status.static_string_array_inits === true;
	node.values.forEach((value, i) => {
		if (i > 0) status.code += ", ";
		// A string-literal element (`"hello"`) is a read-only C string literal.
		// An array of strings takes ownership of its elements, so it must hold
		// heap copies — otherwise the scope-exit free would `free` rodata and
		// crash. strdup it (and bump the audit counter) so the element is
		// heap-owned and freeable. Mirrors the `var string x = "lit"` → strdup
		// rule in build_declaration_node. (The static-initializer form above
		// is the exception: a global owns nothing and cannot call strdup.)
		const is_string_literal =
			elem_is_string &&
			value.node_type === "value" &&
			(value as ValueNode).value.length >= 2 &&
			(value as ValueNode).value.startsWith('"') &&
			(value as ValueNode).value.endsWith('"');
		const nir_elem = nir_elements?.[i];
		if (is_string_literal && static_init) {
			status.code += `{ ${escape_c_string((value as ValueNode).value)}, ${string_literal_length((value as ValueNode).value)} }`;
		} else if (is_string_literal) {
			status.code += `nomen_str_dup(`;
			if (nir_elem && nir_elem.node === value) {
				emit_expr_from_nir(nir_elem, status);
			} else {
				build_node(value, status);
			}
			status.code += `)`;
		} else if (nir_elem && nir_elem.node === value) {
			emit_expr_from_nir(nir_elem, status);
		} else {
			build_node(value, status);
		}
	});
	status.code += `}`;
}
