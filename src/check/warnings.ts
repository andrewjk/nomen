import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import { child_nodes } from "../nodes/child_nodes.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import RootNode from "../nodes/RootNode.ts";
import StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";
import type CompileError from "../types/CompileError.ts";
import type CheckStatus from "./CheckStatus.ts";
import { is_box_type } from "./utils/box.ts";
import {
	drop_ref_self_quick_fix,
	field_set_quick_fix,
	type FieldSetQuickFix,
} from "./utils/field_effects.ts";
import { is_owning_struct_value_type } from "./utils/ownership.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

/**
 * Lint pass run after a successful check. It walks the AST to surface four
 * kinds of warning:
 *
 *  - an unused value/parameter (declared but never read)
 *  - a `var` that is never reassigned (it could be a `const`)
 *  - a function or method that is never called
 *  - a type annotation that repeats what the initializer already infers
 *
 * The analysis is deliberately conservative: it biases towards not warning
 * when ownership (mv/ref/cp), trait vtables, library code or the `_`-discard
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

	// Declared field sets and idle references (FIELD_EFFECTS.md):
	//  - a `ref` parameter that declares no heap field (an explicit `{}`, or an
	//    un-annotated parameter whose body provably displaces none) can declare
	//    `{}` so calls stop invalidating callers' borrows of the argument. A
	//    copyable parameter that is never written through is better taken by
	//    value; an owning (`mv`) struct has no by-value pass, so `{}` is the
	//    move there;
	//  - a `ref self` receiver that never writes through itself should be a bare
	//    `self` reader (the edit is local, so the warning carries a quick fix);
	//  - an un-annotated parameter whose body DOES displace heap fields keeps
	//    the wildcard, but the warning names the fields and carries a quick fix.
	//    An un-annotated `ref self` mutator stays the accepted norm (zero
	//    churn) — only its non-displacing cases are linted.
	if (status.ref_param_writes?.size) {
		const entries = [...status.ref_param_writes.values()].sort(
			(a, b) => a.param.start - b.param.start,
		);
		for (const entry of entries) {
			// Library internals maintain their own invariants and are trusted.
			if (entry.is_library) continue;
			const param = entry.param;
			// The `_`-prefix discard convention marks an intentionally unused
			// parameter (e.g. an unimplemented trait stub's `_state`).
			if (param.name.startsWith("_")) continue;
			const owning = is_owning_struct_value_type(param.type, status);
			// A `Box<T>` cannot be passed by value (boxing owns its pointee), so
			// the by-value spelling is not an alternative for it either.
			const box_param = is_box_type(param.type.name, status.structs);
			const by_value_possible = !owning && !box_param;
			const fields = [...entry.fields].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
			// A `whole` event means a wildcard callee may change ANY field — so
			// `{}` can never be suggested; the caller is silent only when the
			// unknown comes from coarse library code.
			const displaces = fields.length > 0 || entry.whole;

			if (param.field_set !== undefined) {
				// Only the empty set has a lint; a concrete set is doing its job.
				if (param.field_set.length !== 0) continue;
				if (entry.wrote) continue;
				if (param.is_self_param) {
					add_warning(
						status,
						`Method receiver 'self' is never mutated — use bare 'self' instead of 'ref self'`,
						param.name_start ?? param.start,
						drop_ref_self_quick_fix(param),
					);
				} else if (by_value_possible) {
					add_warning(
						status,
						`Ref parameter '${param.name}' declares the empty field set but is never written through — take it by value (or drop 'ref')`,
						param.name_start ?? param.start,
					);
				}
				// An owning reader with `{}` is exactly right — silent.
				continue;
			}

			// Un-annotated parameter.
			if (param.is_self_param) {
				if (!entry.wrote) {
					add_warning(
						status,
						`Method receiver 'self' is never mutated — use bare 'self' instead of 'ref self'`,
						param.name_start ?? param.start,
						drop_ref_self_quick_fix(param),
					);
				} else if (!displaces) {
					add_warning(
						status,
						`Method receiver 'self' mutates only value-type storage — declare '{}' so calls keep callers' borrows alive`,
						param.name_start ?? param.start,
						field_set_quick_fix(param, []),
					);
				}
				continue;
			}

			if (fields.length) {
				const whole = entry.whole ? `; calls through the bare parameter may change any field` : "";
				add_warning(
					status,
					`Ref parameter '${param.name}' changes ${fields
						.map((f) => `'${f}'`)
						.join(
							", ",
						)} through the alias without declaring it — add '{ ${fields.join(", ")} }' to narrow invalidation for callers${whole}`,
					param.start,
					field_set_quick_fix(param, fields),
				);
				continue;
			}
			if (displaces) {
				// Unknown effect: silent when the coarse callee is library code
				// (the design accepts coarse library mutators — there is
				// nothing the caller can declare to improve it).
				if (entry.library_unknown) continue;
				add_warning(
					status,
					`Ref parameter '${param.name}' may change any field of the aliased variable — declare a field set ('{ … }') to narrow invalidation for callers; calls through the bare parameter may change any field`,
					param.start,
				);
				continue;
			}
			if (entry.wrote) {
				// Scalar mutations only: `{}` is exact (they displace nothing).
				add_warning(
					status,
					`Ref parameter '${param.name}' displaces no heap field — declare '{}' so calls keep callers' borrows alive`,
					param.start,
					field_set_quick_fix(param, []),
				);
			} else if (!by_value_possible) {
				// A pure reader of an owning struct: `ref` is its borrow spelling.
				add_warning(
					status,
					`Ref parameter '${param.name}' is never written through — declare '{}' so calls keep callers' borrows alive`,
					param.start,
					field_set_quick_fix(param, []),
				);
			} else {
				// A copyable pure reader: taking it by value is the better shape.
				add_warning(
					status,
					`Ref parameter '${param.name}' is never written through — take it by value (or drop 'ref')`,
					param.name_start ?? param.start,
				);
			}
		}
	}

	// Redundant type annotations: a declaration whose annotation repeats what
	// its initializer already infers (see warn_redundant_annotation).
	for_each_node(root, (node) => {
		if (node.node_type === "declare") warn_redundant_annotation(node as DeclarationNode, status);
	});

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
	// Bodyless declarations have no body-level intent to judge: trait method
	// signatures, foreign declarations, and the compiler-synthesized `#init`
	// shapes (whose parameters are consumed by the generated construction,
	// not by a body — a generic struct's monomorphized init param used to be
	// reported as "never used"). Synthesized functions may also carry the
	// defining struct's source offset, so `has_body` is the reliable gate.
	if (!func.has_body || func.start < 0) return;
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
	if (param.is_self_param || param.is_moved || param.is_ref || param.is_variadic) return;
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
	// A `var view` that is never re-pointed should drop `var` to become a
	// bare `view` (const view) — suggesting `const` would be wrong, since a
	// const owned binding is a different type and is now rejected by rule 3.
	if (decl.type?.is_view) {
		add_warning(
			status,
			`View '${decl.name}' is never re-pointed, consider dropping 'var' (use 'view ${decl.name} = ...')`,
			decl.name_start ?? decl.start,
		);
		return;
	}
	add_warning(
		status,
		`Variable '${decl.name}' is never changed, consider using const`,
		decl.name_start ?? decl.start,
		decl.keyword_text === "var" && decl.keyword_start !== undefined
			? {
					title: "Use `const`",
					param_start: decl.start,
					replace_start: decl.keyword_start,
					replace_end: decl.keyword_start + "var".length,
					replace_text: "const",
				}
			: undefined,
	);
}

// --- Redundant type annotations ----------------------------------------------

/**
 * A declaration whose annotation repeats what its initializer already infers
 * (NOMEN_AGENTS.md, "Prefer implicit types"): `const Point p = Point(2, 3)`
 * or `var int x = 5`. The recognised forms mirror `nomen format`'s
 * conservative strip — a constructor call with every generic argument written
 * at the call, and a single self-describing literal — so everything the
 * warning flags is also what formatting removes. Forms whose annotation is
 * load-bearing stay silent: generic constructions the annotation instantiates
 * (`var List<int> v = List()`), enum shorthand (`.east`), wider/narrower
 * literals (`var int16 small = 300`), nullables, view/ref bindings, and
 * constrained declarations. Library code is exempt.
 */
function warn_redundant_annotation(decl: DeclarationNode, status: CheckStatus): void {
	if (decl.is_library || decl.is_loop_iterator || decl.is_readonly) return;
	// The `is_library` stamp misses declarations nested inside closures that
	// hang off an expression (mark_library_nodes only descends through
	// statements/allocations), so also compare the source offset against the
	// library boundary.
	if (status.library_boundary !== undefined && decl.start >= status.library_boundary) return;
	// A missing annotation parses as an empty type name; `type_start` is only
	// stamped for a source-written annotation, so checker-synthesized
	// declarations (hoisted temps, loop iterators) never qualify either.
	if (!decl.type.name || decl.type_start === undefined || decl.name_start === undefined) return;
	if (decl.type.is_view || decl.type.is_ref || decl.type.is_nullable || decl.type.is_array) return;
	if (decl.declaration === "view" || decl.declaration === "ref") return;
	// `format`'s line transform doesn't strip constrained declarations, so
	// neither does the lint.
	if (decl.constraint) return;
	const value = decl.value;
	if (!value) return;

	if (value.node_type === "func_call") {
		const call = value as FunctionCallNode;
		// Compiler-special constructions (Thread/Fiber/WeakHandle/…), enum
		// shorthand, and anon-struct conversions take their meaning from the
		// annotation or rewrite the written form — never strip those.
		if (
			call.is_thread_ctor ||
			call.is_fiber_ctor ||
			call.is_awaitable_ctor ||
			call.is_weak_ctor ||
			call.is_func_value_ctor ||
			call.is_enum_shorthand ||
			call.field_overrides?.length
		)
			return;
		if (call.resolved_function?.name !== "#init") return;
		const struct = status.structs.find((s) => s.name === call.name);
		if (!struct) return;
		// Type arguments the checker recovered from the annotation (or that
		// weren't written at the call) make the annotation load-bearing —
		// dropping it could change the program. Only fully-written generic
		// args qualify (`Map<int, int>()`), mirroring format's identical-text
		// rule.
		if (call.type_args_from_expected) return;
		if (struct.type_params.length && (call.type_args?.length ?? 0) !== struct.type_params.length)
			return;
	} else if (value.node_type === "value") {
		// A single self-describing literal only — an identifier or computed
		// initializer may rely on the annotation for mv/view/box semantics.
		const text = (value as unknown as { value: string }).value;
		if (literal_type_name(text) === undefined) return;
	} else {
		return;
	}

	if (type_display(decl.type) !== type_display(type_from_value_node(value, status))) return;

	add_warning(
		status,
		`Type annotation on '${decl.name}' is redundant — '${type_display(
			decl.type,
		)}' is already inferred; run 'nomen format' to drop it`,
		decl.type_start,
		{
			title: "Drop redundant type",
			param_start: decl.start,
			replace_start: decl.type_start,
			replace_end: decl.name_start,
			replace_text: "",
		},
	);
}

/** The type a literal value spells out on its own; undefined when it doesn't. */
function literal_type_name(text: string): string | undefined {
	if (text === "true" || text === "false") return "bool";
	if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return "string";
	if (text.length >= 3 && text.startsWith("'") && text.endsWith("'")) return "char";
	if (/^-?\d+$/.test(text)) return "int";
	if (/^-?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return "float";
	return undefined;
}

/** The user-visible spelling of a type (`List<int>`, `Map<string, int>`). */
function type_display(t: Type): string {
	if (!t.type_args?.length) return t.name ?? "?";
	return `${t.name}<${t.type_args.map(type_display).join(", ")}>`;
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
		for (const child of child_nodes(node)) visit(child);
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
		for (const child of child_nodes(node)) stack.push(child);
	}
}

function for_each_function(root: BaseNode, visit: (func: FunctionNode) => void): void {
	for_each_node(root, (node) => {
		if (node.node_type === "func") visit(node as FunctionNode);
	});
}

function is_discard(name: string): boolean {
	return name.startsWith("_");
}

function add_warning(
	status: CheckStatus,
	message: string,
	start: number,
	quick_fix?: FieldSetQuickFix,
): void {
	if (!status.warnings) status.warnings = [];
	status.warnings.push({ message, start, line: 0, column: 0, ...(quick_fix ? { quick_fix } : {}) });
}
