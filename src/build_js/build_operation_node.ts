import type OperationNode from "../nodes/OperationNode.ts";
import { expr } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { method_label } from "./names.ts";
import { kind_of, stamped_type } from "./types.ts";

/** Emit a JS expression for a Nomen operator node. Ints are bigints and
 *  floats are numbers, so the same JS operator serves both; the one special
 *  case is string repetition (`"x" * n` → `.repeat(n)`). */
export default function build_operation_node(node: OperationNode, status: BuildStatus): string {
	const op = node.op;
	if (op === "u-") return `(-${expr(node.left_value, status)})`;
	if (op === "!") return `(!${expr(node.left_value, status)})`;

	let left = expr(node.left_value, status);
	let right = expr(node.right_value, status);
	const result_kind = kind_of(node);
	const left_kind = kind_of(node.left_value);
	const right_kind = kind_of(node.right_value);
	const arithmetic = ["+", "-", "*", "/", "%", "<<", ">>", "&", "|", "^"].includes(op);

	// Char operands in an int operation are byte values in Nomen (C promotes
	// a char to int); JS chars are one-character strings.
	if (arithmetic && result_kind === "int") {
		if (left_kind === "char") left = `BigInt(${left}.charCodeAt(0))`;
		if (right_kind === "char") right = `BigInt(${right}.charCodeAt(0))`;
	}
	if (arithmetic && result_kind === "char") {
		const l = left_kind === "char" ? `BigInt(${left}.charCodeAt(0))` : left;
		const r = right_kind === "char" ? `BigInt(${right}.charCodeAt(0))` : right;
		return `__char_from_code((${l} ${op} ${r}) & 255n)`;
	}

	if (op === "*" && kind_of(node.left_value) === "string") {
		return `(${left}.repeat(Number(${right})))`;
	}

	// Array concatenation (`[1, 2] + [3, 4]`) — JS `+` would stringify.
	if (op === "+" && kind_of(node.left_value) === "array") {
		return `(${left}.concat(${right}))`;
	}

	// A user struct operator (`Equatable`'s `eq`, `String`'s `add`, …): the
	// checker resolved the method; call it. Library structs (string) keep the
	// native lowering above — their Nomen bodies are not emitted.
	if (node.operator_func && !node.operator_func.deferred) {
		const { struct_name, func_name, invert } = node.operator_func;
		if (status.structs.some((s) => s.name === struct_name)) {
			const call = `${method_label(struct_name, func_name)}(${left}, ${right})`;
			return invert ? `(!${call})` : `(${call})`;
		}
	}

	// Enum values are objects: `==` compares tag + payload, not identity.
	if ((op === "==" || op === "!=") && is_enum(node.left_value, status)) {
		const compare = `__enum_eq(${left}, ${right})`;
		return op === "==" ? compare : `(!${compare})`;
	}

	// Value equality on the JS representations is exact (bigint vs bigint,
	// string vs string); use the strict forms so a null check can't be
	// satisfied by undefined.
	if (op === "==") return `(${left} === ${right})`;
	if (op === "!=") return `(${left} !== ${right})`;

	return `(${left} ${op} ${right})`;
}

function is_enum(node: Parameters<typeof kind_of>[0], status: BuildStatus): boolean {
	const type = stamped_type(node);
	if (!type?.name) return false;
	return status.enums.some((e) => e.name === type.name);
}
