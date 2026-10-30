import type AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import type DeclarationNode from "../../nodes/DeclarationNode.ts";
import type FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import type TraitNode from "../../nodes/TraitNode.ts";
import type ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import in_function from "./in_function.ts";
import { conforms_to_trait, is_trait_type } from "./trait_slot.ts";

/**
 * Devirtualization of trait calls (PERF_PLAN item 11).
 *
 * A trait-typed position dispatches through the conformer's vtable. When the
 * concrete conformer is STATICALLY VISIBLE — a bare local declared from a
 * direct constructor call of one known struct, never rebound anywhere in the
 * function — the dispatch can lower as a direct call to `<Class>_<method>`
 * (the same symbol the vtable slot holds): no two dependent vtable loads, no
 * indirect branch, and on the C backend an inlining opportunity clang cannot
 * recover through `_get_trait_func`.
 *
 * The proof is whole-function, not statement-ordered: a rebinding LATER in a
 * loop body retypes EARLIER call sites on the next iteration, so no amount of
 * in-order clearing can stamp calls inside a loop safely. `collect_rebound_names`
 * scans the body once at function entry for every form that could change a
 * binding's conformer — assignment, swap, and `ref`-argument passes (the callee
 * can reassign the caller's slot through the alias) — and a name in that set
 * never carries a known concrete conformer. Globals are excluded at the
 * declaration site (any function may rebind them, and each function is checked
 * against its own scan).
 */

/** AST fields that are back-references, not body — walking them loops. */
const WALK_SKIP_KEYS = new Set(["scope", "resolved_function"]);

function is_bare_name(node: BaseNode | undefined): node is ValueNode {
	return (
		!!node &&
		node.node_type === "value" &&
		typeof (node as ValueNode).value === "string" &&
		/^[A-Za-z_][A-Za-z0-9_]*$/.test((node as ValueNode).value)
	);
}

/**
 * Every name this statement list REBINDS in a way that could change a
 * binding's concrete conformer: assignment targets, swap operands (both
 * sides exchange instances), and `ref` arguments (the callee may write the
 * caller's slot). Deliberately name-based: a shadowing redeclaration in an
 * inner scope disqualifies the outer name too — a lost optimization, never
 * an unsound one.
 */
export function collect_rebound_names(statements: BaseNode[]): Set<string> {
	const names = new Set<string>();
	const visit = (node: unknown): void => {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		const n = node as BaseNode;
		if (n.node_type === "assign") {
			const assign = n as unknown as {
				left_value?: BaseNode;
				right_value?: BaseNode;
				swap?: BaseNode;
			};
			if (is_bare_name(assign.left_value)) names.add(assign.left_value.value);
			if (assign.swap) {
				// `a = <rhs> swap <repl>`: the moved-out SOURCE is rebound too —
				// the replacement takes its place in scope (the move-out
				// revalidation rule), so the source binding can change
				// conformer just like the target.
				if (is_bare_name(assign.right_value)) names.add(assign.right_value.value);
				if (is_bare_name(assign.swap)) names.add(assign.swap.value);
			}
		}
		// Swap call arguments (`f(mv a swap b)`): both the argument and the
		// swap expression's root name take the other's instance.
		const swap_params = (n as unknown as { swap_params?: Map<number, BaseNode> }).swap_params;
		if (swap_params instanceof Map) {
			const params = (n as unknown as { params?: BaseNode[] }).params;
			for (const [i, expr] of swap_params) {
				const arg = params?.[i];
				if (is_bare_name(arg)) names.add(arg.value);
				if (is_bare_name(expr)) names.add(expr.value);
			}
		}
		// `ref` arguments: the callee receives the caller's SLOT (a `T **`)
		// and may reassign it to a different conformer.
		const ref_indices = (n as unknown as { ref_param_indices?: number[] }).ref_param_indices;
		if (Array.isArray(ref_indices)) {
			const params = (n as unknown as { params?: BaseNode[] }).params;
			for (const i of ref_indices) {
				const arg = params?.[i];
				if (is_bare_name(arg)) names.add(arg.value);
			}
		}
		for (const [key, val] of Object.entries(n)) {
			if (WALK_SKIP_KEYS.has(key)) continue;
			if (Array.isArray(val)) {
				for (const item of val) visit(item);
			} else if (val && typeof val === "object" && (val as BaseNode).node_type) {
				visit(val);
			}
		}
	};
	for (const statement of statements) visit(statement);
	return names;
}

/**
 * The known concrete conformer for a trait-typed declaration, or undefined.
 * Provable shapes: a direct constructor call of a conforming struct (the
 * checker stamps the call's `.type` with the struct name), or a bare-value
 * binding whose donor itself carries a known concrete (the handle moves with
 * it — trait donors move via `mv`, value-struct conformers box a copy whose
 * struct is the donor's). Everything else — method returns, field paths,
 * container reads — has an unknowable runtime type.
 */
export function trait_decl_concrete_struct(
	decl: DeclarationNode,
	status: CheckStatus,
): string | undefined {
	const trait_name = decl.type?.name;
	if (
		!trait_name ||
		!is_trait_type(trait_name, status) ||
		decl.type.is_array ||
		decl.type.is_ref ||
		decl.type.is_view ||
		decl.type.is_nullable
	) {
		return undefined;
	}
	// Globals are checked once but rebindable from any function — no
	// function-local scan can prove their concrete stable.
	if (!in_function(status)) return undefined;
	if (!decl.value) return undefined;
	if (decl.value.node_type === "func_call") {
		const call = decl.value as FunctionCallNode;
		const concrete_name = call.type?.name;
		if (!concrete_name || concrete_name === trait_name) return undefined;
		if (!conforms_to_trait(concrete_name, trait_name, status)) return undefined;
		const concrete = status.structs.find((s) => s.name === concrete_name);
		if (!concrete || concrete.is_simple_type || concrete.is_generic) return undefined;
		return concrete_name;
	}
	if (decl.value.node_type === "value") {
		const src = decl.value as ValueNode;
		if (!is_bare_name(src)) return undefined;
		const src_sv = status.values.findLast((v) => v.name === src.value);
		if (!src_sv) return undefined;
		if (src_sv.concrete_struct) return src_sv.concrete_struct;
		// A bare value-struct conformer boxes a copy — the box's concrete is
		// the donor's own struct (the mv/box ownership rules upstream guarantee
		// this shape transfers).
		if (
			src_sv.type?.name &&
			src_sv.type.name !== trait_name &&
			conforms_to_trait(src_sv.type.name, trait_name, status)
		) {
			const donor = status.structs.find(
				(s) => s.name === src_sv.type.name && !s.is_simple_type && !s.is_generic,
			);
			if (donor && !donor.is_class) return donor.name;
		}
	}
	return undefined;
}

/**
 * Stamp `node.devirtualized_class` when a trait-method dispatch on a
 * bare-local receiver can lower as a direct call: the local carries a known
 * concrete conformer, the trait and conformer are non-generic (the direct
 * symbol and its signature are the plain ones), and the call target exists
 * as a symbol — either the conformer DEFINES the method (`${Struct}_${method}`
 * — the exact label the vtable builder puts in the slot) or it inherits a
 * trait DEFAULT with a body (`${Trait}_${method}`, likewise the slot's
 * label). A bodyless trait function has no symbol to call, so that shape
 * keeps the vtable path. Overridden method sets (overloads mangle their
 * labels) and no-self (static) calls also keep the dispatch.
 */
export function stamp_devirtualized_trait_call(
	node: AccessFunctionCallNode,
	target: BaseNode,
	target_type_name: string | undefined,
	trait: TraitNode,
	status: CheckStatus,
): void {
	if (node.is_static || target_type_name !== trait.name) return;
	if (target.node_type !== "value") return;
	const name = (target as ValueNode).value;
	if (!is_bare_name(target)) return;
	if (status.devirt_rebound_names?.has(name)) return;
	const sv = status.values.findLast((v) => v.name === name && !v.is_global);
	if (!sv?.concrete_struct) return;
	if (trait.type_params.length > 0) return;
	const concrete = status.structs.find(
		(s) => s.name === sv.concrete_struct && !s.is_generic && !s.is_simple_type,
	);
	if (!concrete) return;
	const overrides = concrete.functions.filter((f) => f.name === node.name);
	if (overrides.length > 1) return; // overloaded: labels mangle per signature
	if (overrides.length === 0) {
		// Trait-default-only conformer: the vtable slot holds the trait's
		// default body. Callable only when that body exists.
		const trait_func = trait.functions.find((f) => f.name === node.name);
		if (!trait_func?.has_body) return;
	}
	node.devirtualized_class = concrete.name;
}
