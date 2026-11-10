import type BaseNode from "../nodes/BaseNode.ts";
import type BitsetNode from "../nodes/BitsetNode.ts";
import { child_nodes } from "../nodes/child_nodes.ts";
import type EnumNode from "../nodes/EnumNode.ts";
import type RootNode from "../nodes/RootNode.ts";
import type StructNode from "../nodes/StructNode.ts";
import type TraitNode from "../nodes/TraitNode.ts";
import type BuildResult from "../types/BuildResult.ts";
import build_root_node from "./build_root_node.ts";
import { create_status } from "./BuildStatus.ts";
import type BuildStatus from "./BuildStatus.ts";
import runtime from "./runtime.ts";

/**
 * The JavaScript backend.
 *
 * It walks the CHECKED AST (so borrow/move/format-spec semantics come from
 * the real compiler) and emits a self-contained CommonJS script that Node
 * runs directly. Nomen values map onto JS: ints → `bigint`, floats →
 * `number`, strings/chars → `string`, bools → `boolean`, arrays → JS arrays,
 * structs → plain objects. Ownership and the audit runtime are native-memory
 * concerns with no JS analogue.
 *
 * The v1 subset covers literals, variables, arithmetic/comparison/logical
 * operators, casts, if/while/for, free and nested functions, structs
 * (constructor + field access + methods), string interpolation (including
 * the Format helpers), and Console I/O. Unsupported constructs fail at
 * runtime through `__unsupported` rather than producing wrong output.
 */
export default function build_js(root: BaseNode): BuildResult {
	const status = create_status(root);
	collect_types(root, status);
	build_root_node(root as RootNode, status);
	const code = `${runtime()}${status.code}`;
	return {
		headers: "",
		code,
		errors: status.errors.length ? status.errors : undefined,
	};
}

/** Pre-collect every user struct/enum in the tree (declarations may be
 *  nested inside function bodies and are emitted where they appear, but the
 *  expression builders need the full type table up front). Library types are
 *  skipped — the runtime provides the supported slice of their surface. */
function collect_types(root: BaseNode, status: BuildStatus): void {
	const visit = (node: BaseNode): void => {
		const is_library = (node as unknown as { is_library?: boolean }).is_library === true;
		if (!is_library && node.node_type === "struct") {
			status.structs.push(node as StructNode);
		}
		if (!is_library && node.node_type === "enum") {
			status.enums.push(node as EnumNode);
		}
		// Bitsets are pure constants, so library ones are collected too (a
		// program may use a System bitset case).
		if (node.node_type === "bitset") {
			status.bitsets.push(node as BitsetNode);
		}
		// Traits: only the NAMES matter — a trait-typed receiver dispatches on
		// its runtime struct tag.
		if (node.node_type === "trait") {
			status.traits.push(node as TraitNode);
		}
		for (const child of child_nodes(node)) visit(child);
	};
	visit(root);
}
