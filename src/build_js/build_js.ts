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
import { emit_library_queue } from "./library_queue.ts";
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
 * Covered: literals, variables, every operator, casts, if/switch/match (as
 * statements and expressions), while/for (including `for ref`), free and
 * nested functions, lambdas and closures, structs (value/owning, `#init`,
 * methods, traits, generics), enums/bitsets, destructuring, tuples, string
 * interpolation and custom format patterns, the native containers, and
 * on-demand lowering of plain-Nomen library code. Constructs that need raw
 * memory or concurrency fail at runtime through `__unsupported` rather than
 * producing wrong output.
 */
export default function build_js(root: BaseNode): BuildResult {
	const status = create_status(root);
	collect_types(root, status);
	index_allocations(root, status);
	build_root_node(root as RootNode, status);
	// Library code referenced by the program is lowered on demand into its own
	// top-level buffer (function declarations hoist, so it can precede `main()`).
	emit_library_queue(status);
	const code = `${runtime()}${status.library_code}${status.code}`;
	return {
		headers: "",
		code,
		errors: status.errors.length ? status.errors : undefined,
	};
}

/** Index every checker-hoisted temp by name so `build_value_node` can inline
 *  its initializer at the reference site. */
function index_allocations(root: BaseNode, status: BuildStatus): void {
	status.allocations = new Map();
	const visit = (node: BaseNode): void => {
		for (const allocation of (node as unknown as { allocations?: BaseNode[] }).allocations ?? []) {
			const name = (allocation as unknown as { name?: string }).name;
			const value = (allocation as unknown as { value?: BaseNode }).value;
			if (name && value) status.allocations?.set(name, value);
		}
		for (const child of child_nodes(node)) visit(child);
	};
	visit(root);
}

/** Pre-collect every user struct/enum in the tree (declarations may be
 *  nested inside function bodies and are emitted where they appear, but the
 *  expression builders need the full type table up front). Library types are
 *  skipped — the runtime provides the supported slice of their surface. */
function collect_types(root: BaseNode, status: BuildStatus): void {
	const visit = (node: BaseNode): void => {
		const is_library = (node as unknown as { is_library?: boolean }).is_library === true;
		if (node.node_type === "struct") {
			if (is_library) status.library_structs.push(node as StructNode);
			else status.structs.push(node as StructNode);
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
