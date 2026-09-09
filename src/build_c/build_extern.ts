import emission_label from "../build_common/emission_label.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";
import c_type from "./utils/c_type.ts";

/**
 * Emit an `extern func`: a marshalling adapter under the function's normal
 * emission label that forwards to the C symbol (named by the declared Nomen
 * name). Call sites need no special handling — they emit a normal call to
 * the label.
 *
 * Marshalling rules (first cut, see CORE_RAW.md):
 * - string params stay FAT at the adapter boundary (call sites pass
 *   nomen_string by value); the symbol call marshals to the thin `char*`
 *   (`.ptr`). The buffer is NUL-terminated at ptr[len], so libc consumers
 *   work unchanged.
 * - a string RETURN wraps the symbol's char* result into a fat
 *   nomen_string with `strlen` for the len half — the caller receives an
 *   owned, correctly-sized string.
 * - scalars pass through 1:1 (float widens to double via c_type).
 *
 * The C symbol needs no prototype here: the prelude includes
 * stdio/stdlib/string/math, so libc declarations are already visible.
 */
export default function build_extern(node: FunctionNode, status: BuildStatus) {
	const label = c_function_name(emission_label(node));
	const symbol = node.name.replace(/#/g, "");

	const param_texts: string[] = [];
	const arg_texts: string[] = [];
	for (const param of node.params) {
		const pname = c_function_name(param.name);
		if (param.type.name === "string") {
			param_texts.push(`nomen_string ${pname}`);
			arg_texts.push(`${pname}.ptr`);
		} else {
			param_texts.push(`${c_type(param.type.name)} ${pname}`);
			arg_texts.push(pname);
		}
	}

	const returns_string = node.return_type.name === "string";
	let ret_text: string;
	if (!node.return_type.name) {
		ret_text = "void";
	} else if (returns_string) {
		ret_text = "nomen_string";
	} else {
		ret_text = c_type(node.return_type.name);
	}

	const signature = `${ret_text} ${label}(${param_texts.join(", ")})`;
	status.headers += `// Extern ${node.name} -> ${symbol}\n${signature};\n`;
	status.code += `${signature} {\n`;
	const call_args = arg_texts.join(", ");
	if (returns_string) {
		status.code += `char* _r = ${symbol}(${call_args});\n`;
		status.code += `return (nomen_string){ _r, (long)strlen(_r) };\n`;
	} else if (node.return_type.name) {
		status.code += `return ${symbol}(${call_args});\n`;
	} else {
		status.code += `${symbol}(${call_args});\n`;
	}
	status.code += `}\n\n`;
}
