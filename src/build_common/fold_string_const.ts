import type BaseNode from "../nodes/BaseNode.ts";
import type DeclarationNode from "../nodes/DeclarationNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";

/**
 * Fold a top-level `const`'s string `+` chain into a single string literal.
 *
 * Module-level `const` declarations are inlined at every use site (see
 * `top_level_consts` in both backends' BuildStatus): the build replays the
 * const's initializer expression wherever the name appears. For a composed
 * pattern like `pub const HTML_TAG_REGEX = "^(" + TAG_NAME + "|…)"` that
 * replay lowers to a malloc/copy/free `string_add` chain PER USE — the
 * allmark port's inline-token loop rebuilt its ~1 KB pattern on every
 * attempt, and the chain's calls were also the trigger for the aarch64
 * ref-argument clobber (PORT.md).
 *
 * When the initializer is a pure `+` chain of plain string literals and
 * references to other foldable consts, this returns one merged literal
 * ValueNode — semantically the string the source spells — that the use site
 * emits as rodata instead. Anything else (a runtime operand, a struct ctor,
 * an operator overload) returns null and the tree builds as before.
 *
 * Raw token merging is byte-preserving: escape sequences are self-contained
 * within a part's content (a content ending in a lone `\` would have
 * escaped that part's closing quote, so it cannot occur), and both
 * emitters' `\x`-as-octal re-encoding plus the 2/3-digit caps keep merged
 * escapes from absorbing a following part's text.
 */

const fold_cache = new WeakMap<DeclarationNode, BaseNode | null>();

export default function fold_string_const(
	decl: DeclarationNode,
	consts: Map<string, DeclarationNode>,
): BaseNode | null {
	if (fold_cache.has(decl)) return fold_cache.get(decl)!;
	const folded = fold_value(decl.value, consts, new Set<string>());
	fold_cache.set(decl, folded);
	return folded;
}

function fold_value(
	node: BaseNode | undefined,
	consts: Map<string, DeclarationNode>,
	active: Set<string>,
): ValueNode | null {
	if (!node) return null;
	if (node.node_type === "value") {
		const raw = (node as ValueNode).value;
		if (typeof raw !== "string") return null;
		if (raw.startsWith('"')) {
			// A plain literal. Interpolated strings parse to a
			// `_string_interpolate_N` call, never to a literal value node, so
			// no interpolation can hide in here.
			return literal(raw, node.start);
		}
		// A reference to another top-level const: resolve transitively (the
		// htmlPatterns style composes part consts into the final pattern).
		if (active.has(raw)) return null;
		const ref = consts.get(raw);
		if (!ref) return null;
		active.add(raw);
		const folded = fold_value(ref.value, consts, active);
		active.delete(raw);
		return folded;
	}
	if (node.node_type === "op") {
		const op = node as OperationNode;
		// String `+` resolves through the core `string` struct's `#op_add`
		// (pure concat; users cannot declare a struct named after the
		// primitive, so this operator_func is always the library's). Any
		// other operator_func is a user-defined operator — never fold it.
		const is_string_concat =
			op.op === "+" && (!op.operator_func || op.operator_func.struct_name === "string");
		if (!is_string_concat) return null;
		const left = fold_value(op.left_value, consts, active);
		if (!left) return null;
		const right = fold_value(op.right_value, consts, active);
		if (!right) return null;
		return literal(left.value.slice(0, -1) + right.value.slice(1), node.start);
	}
	return null;
}

function literal(raw: string, start: number): ValueNode {
	return new ValueNode(start, raw, new Type("string", true));
}
