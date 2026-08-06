import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import RootNode from "../nodes/RootNode.ts";
import StructNode from "../nodes/StructNode.ts";
import type CompileError from "../types/CompileError.ts";
import type CheckStatus from "./CheckStatus.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

/**
 * Lint pass run after a successful check. It walks the AST to surface three
 * kinds of warning:
 *
 *  - an unused value/parameter (declared but never read)
 *  - a `var` that is never reassigned (it could be a `const`)
 *  - a function or method that is never called
 *
 * The analysis is deliberately conservative: it biases towards not warning
 * when ownership (mov/ref/cp), trait vtables, library code or the `_`-discard
 * convention is involved, since those cases can look "unused" to a text walk
 * yet be required by the runtime.
 */
export default function emit_warnings(root: BaseNode, status: CheckStatus): void {
	if (!status.warnings) status.warnings = [];

	const referenced = collect_referenced_names(root);

	// Unused functions: non-library top-level functions, and methods of structs
	// that conform to no trait (a trait conformance makes any method reachable
	// through a vtable dispatch, so it can't be proven unused). `main` and
	// `#`-prefixed (init/destroy) entry points are exempt.
	for (const node of (root as RootNode).statements) {
		if (node.node_type === "func") warn_unused_function(node as FunctionNode, referenced, status);
		if (node.node_type === "struct") {
			const struct = node as StructNode;
			if (struct.is_library) continue;
			for (const func of struct.functions) warn_unused_function(func, referenced, status, struct);
		}
	}

	// Per-function: unused params/locals and `var`-never-changed. Analyse every
	// FunctionNode in the tree (top-level, methods, and lambdas).
	for_each_function(root, (func) => analyse_function(func, status));

	// Monomorphised clones share their original's offsets, so the same warning
	// can be emitted more than once — collapse exact duplicates.
	status.warnings = dedupe_warnings(status.warnings);
}

function dedupe_warnings(warnings: CompileError[]): CompileError[] {
	const seen = new Set<string>();
	const out: CompileError[] = [];
	for (const w of warnings) {
		const key = `${w.start}:${w.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(w);
	}
	return out;
}

// --- Unused functions --------------------------------------------------------

function warn_unused_function(
	func: FunctionNode,
	referenced: Set<string>,
	status: CheckStatus,
	struct?: StructNode,
): void {
	if (func.is_library || (struct && struct.is_library)) return;
	if (func.name === "main" || is_discard(func.name) || func.name.startsWith("#")) return;
	// A `pub` function/method is part of a module's public API — it may be
	// called from another file in the project, so it can't be proven unused.
	if (func.visibility === "pub") return;
	// A generic function is instantiated at each call site under a mangled
	// (monomorphized) name, so its generic definition can't be proven unused
	// by matching call names — never warn it.
	if (func.is_generic) return;
	// A trait conformance makes methods reachable through vtable dispatch.
	if (struct && struct.traits.length > 0) return;
	if (referenced.has(func.name)) return;
	add_warning(status, build_unused_function_message(func, struct), func.start);
}

function build_unused_function_message(func: FunctionNode, struct?: StructNode): string {
	const kind = struct ? "method" : "function";
	return `${kind[0].toUpperCase()}${kind.slice(1)} '${func.name}' is never called`;
}

// --- Per-function analysis ---------------------------------------------------

interface Locals {
	decls: DeclarationNode[];
	reads: Set<string>;
	assigned: Set<string>;
}

function analyse_function(func: FunctionNode, status: CheckStatus): void {
	// Library internals maintain their own invariants and are trusted, so don't
	// lint them. A method's library-ness may live on its enclosing struct (e.g.
	// monomorphized clones whose own flag wasn't copied), so check both.
	const scope = func.scope as StructNode | undefined;
	if (func.is_library || scope?.is_library) return;

	const locals: Locals = { decls: [], reads: new Set(), assigned: new Set() };

	// Reads come from the whole subtree (closures may capture outer locals),
	// but declarations are gathered only from this function's own body so a
	// nested function's locals aren't mistaken for ours.
	collect_reads(func, locals);
	collect_local_declarations(func, locals);

	for (const param of func.params) warn_unused_param(param, locals, func, status);
	for (const decl of locals.decls) {
		warn_unused_value(decl, locals, status);
		warn_var_not_changed(decl, locals, status);
	}
}

function warn_unused_param(
	param: ParameterNode,
	locals: Locals,
	func: FunctionNode,
	status: CheckStatus,
): void {
	if (func.is_library) return;
	// `main`'s parameters are mandated by the entry-point signature (e.g. the
	// runtime `Init init` handle) and can't be removed, so don't flag them.
	if (func.name === "main") return;
	if (param.is_self_param || param.is_moved || param.is_ref || param.is_copied || param.is_variadic)
		return;
	if (is_discard(param.name)) return;
	if (locals.reads.has(param.name)) return;
	add_warning(status, `Parameter '${param.name}' is never used`, param.name_start ?? param.start);
}

function warn_unused_value(decl: DeclarationNode, locals: Locals, status: CheckStatus): void {
	if (is_discard(decl.name)) return;
	if (locals.reads.has(decl.name)) return;
	add_warning(status, `Value '${decl.name}' is never used`, decl.name_start ?? decl.start);
}

function warn_var_not_changed(decl: DeclarationNode, locals: Locals, status: CheckStatus): void {
	// Only a `var` with an initialiser that is never reassigned is a candidate;
	// an uninitialised `var` that is later assigned *is* changed, and one that
	// is never set is already a different error.
	if (decl.declaration !== "var" || !decl.value) return;
	if (decl.is_loop_iterator) return;
	if (decl.type?.is_ref) return;
	if (is_discard(decl.name)) return;
	if (locals.assigned.has(decl.name)) return;
	// A `ref self` method call mutates the receiver even though the binding is
	// never reassigned, so `const` would fail — don't recommend it.
	if (status.mutated_local_names?.has(decl.name)) return;
	add_warning(
		status,
		`Variable '${decl.name}' is never changed, consider using const`,
		decl.name_start ?? decl.start,
	);
}

// --- Collection --------------------------------------------------------------

/** Names that count as a "use": call targets, method names, and value reads. */
function collect_referenced_names(root: BaseNode): Set<string> {
	const names = new Set<string>();
	for_each_node(root, (node) => {
		switch (node.node_type) {
			case "func_call":
				names.add((node as FunctionCallNode).name);
				return;
			case "access_func":
				names.add((node as AccessFunctionCallNode).name);
				return;
			case "value":
				names.add((node as unknown as { value: string }).value);
				return;
		}
	});
	return names;
}

/**
 * Gather every value read and assignment target reachable from `func`,
 * descending into nested functions so closure captures count as uses.
 */
function collect_reads(func: FunctionNode, locals: Locals): void {
	for_each_node(func, (node) => {
		if (node.node_type === "value") locals.reads.add((node as unknown as { value: string }).value);
		if (node.node_type === "assign") {
			const name = value_from_value_node((node as AssignmentNode).left_value);
			if (name !== "?") locals.assigned.add(name);
		}
	});
}

/**
 * Collect this function's own local declarations (descending into nested
 * blocks but stopping at nested functions, whose locals are their own).
 */
function collect_local_declarations(func: FunctionNode, locals: Locals): void {
	const visit = (node: BaseNode | undefined): void => {
		if (!node) return;
		if (node.node_type === "declare") locals.decls.push(node as DeclarationNode);
		// A nested function's body belongs to that function, not this one.
		if (node.node_type === "func" && node !== func) return;
		for (const child of children_of(node)) visit(child);
	};
	for (const stmt of func.statements) visit(stmt);
}

// --- Generic AST walk --------------------------------------------------------

/** Visit every node reachable from `root`, skipping `parent`/`scope` back-refs. */
function for_each_node(root: BaseNode, visit: (node: BaseNode) => void): void {
	const stack: BaseNode[] = [root];
	while (stack.length) {
		const node = stack.pop()!;
		visit(node);
		for (const child of children_of(node)) stack.push(child);
	}
}

function for_each_function(root: BaseNode, visit: (func: FunctionNode) => void): void {
	for_each_node(root, (node) => {
		if (node.node_type === "func") visit(node as FunctionNode);
	});
}

/** The child nodes of `node`, recursing into arrays and node-valued fields. */
function children_of(node: BaseNode): BaseNode[] {
	const out: BaseNode[] = [];
	for (const key of Object.keys(node)) {
		if (key === "parent" || key === "scope") continue;
		const value = (node as unknown as Record<string, unknown>)[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (is_node(item)) out.push(item);
			}
		} else if (is_node(value)) {
			out.push(value);
		}
	}
	return out;
}

function is_node(value: unknown): value is BaseNode {
	return (
		!!value &&
		typeof value === "object" &&
		"node_type" in value &&
		typeof (value as { node_type: unknown }).node_type === "string"
	);
}

function is_discard(name: string): boolean {
	return name.startsWith("_");
}

function add_warning(status: CheckStatus, message: string, start: number): void {
	if (!status.warnings) status.warnings = [];
	status.warnings.push({ message, start, line: 0, column: 0 });
}
