import BaseNode from "../../nodes/BaseNode.ts";
import clone_node from "../../nodes/clone_node.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";
import StructNode from "../../nodes/StructNode.ts";
import TraitNode from "../../nodes/TraitNode.ts";
import Type from "../../nodes/Type.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import { substitute_param_signature, substitute_type } from "../check_function_call_node.ts";
import type CheckStatus from "../CheckStatus.ts";
import { rewrite_meta_name_chains, substitute_pragma_iterables } from "./comptime.ts";

/**
 * Trait-default binding — the derive migration (the Comptime II backlog's
 * "migrate the hardcoded derives onto `#for`" item).
 *
 * A trait default whose body references `Self` (the conformer) cannot be
 * emitted at the trait level — `META.info(Self)` and the `#for` walk over
 * its fields only mean something once the conformer is known. So the three
 * derive traits (`Stringable` / `Equatable` / `Hashable` in core/System)
 * carry their derivations as REFLECTION DEFAULTS, and conformance binds
 * the default: a struct that conforms and does not supply the method gets
 * a per-conformer clone, with `Self` substituted for the struct's name and
 * the deferred `#for` unrolling at the clone's own check. That is the same
 * deferral/expand shape the monomorphizer applies to generic bodies (R2:
 * generated code is ordinary AST to the checker — the clone is checked,
 * never stamped). The old checker synthesis (the retired auto_derive builders) is
 * gone; a hand-written method still wins, and a field that cannot derive
 * (`field.get(self).to_string()` resolving to nothing) is now a per-field
 * compile error in the generated body instead of a silent skip.
 */

/**
 * Whether a trait default body binds `Self` — a `Self` value node anywhere
 * in the body (the `META.info(Self)` chains and the `#for` iterables) or a
 * `Self`-typed parameter (`eq`'s `other`). Such a default is deferred at
 * the trait (R3: `Self` joins the function's type params) and expanded per
 * conformer.
 */
export function uses_comptime_self(func: FunctionNode): boolean {
	if (func.params.some((p) => p.type.name === "Self")) return true;
	const visit = (node: unknown): boolean => {
		if (!node || typeof node !== "object") return false;
		const n = node as BaseNode;
		if (n.node_type === "value" && (n as ValueNode).value === "Self") return true;
		for (const key of Object.keys(n)) {
			if (key === "parent" || key === "scope") continue;
			const value = (n as unknown as Record<string, unknown>)[key];
			if (Array.isArray(value)) {
				for (const item of value) if (visit(item)) return true;
			} else if (value && typeof value === "object" && "node_type" in value) {
				if (visit(value)) return true;
			}
		}
		return false;
	};
	for (const stmt of func.statements) {
		if (visit(stmt)) return true;
	}
	return false;
}

/**
 * Bind the reflection defaults of every trait `struct` conforms to: clone
 * each `Self`-bearing default body with `Self` → the struct's name, and
 * push the clone as a struct method UNLESS the struct supplies its own.
 * The clone is left UNCHECKED — check_struct_node's method walk checks it
 * (the `#for` unrolls there, `META.info(Name)` chains resolve, and every
 * ownership/last-use analysis runs on the generated body like on
 * hand-written code). Returns the clones so a caller that will not run a
 * later struct check (monomorphized structs) can check them itself.
 *
 * Monomorphized structs (source_type_args) are skipped here — they
 * materialize mid-check, when no struct walk will follow; monomorphize
 * binds and checks them explicitly.
 */
export function bind_trait_defaults(struct: StructNode, status: CheckStatus): FunctionNode[] {
	if (struct.is_generic || struct.is_simple_type) return [];
	if (struct.name.startsWith("_Tuple_") || struct.name.startsWith("_Anon_")) return [];
	if ((struct as unknown as { source_type_args?: unknown[] }).source_type_args?.length) return [];
	const bound: FunctionNode[] = [];
	for (let i = 0; i < struct.traits.length; i++) {
		const trait = status.traits.find((t) => t.name === struct.traits[i]);
		if (!trait || trait.type_params.length > 0) continue;
		for (const trait_func of trait.functions) {
			// Conformance without a hand-written method binds the default.
			if (!trait_func.has_body) continue;
			if (!uses_comptime_self(trait_func)) continue;
			if (struct.functions.find((f) => f.name === trait_func.name)) continue;
			bound.push(bind_default_clone(trait, trait_func, struct, status));
		}
	}
	return bound;
}

/** Clone one trait default onto its conformer with `Self` substituted. */
function bind_default_clone(
	trait: TraitNode,
	trait_func: FunctionNode,
	struct: StructNode,
	status: CheckStatus,
): FunctionNode {
	const substitution = new Map<string, string>([["Self", struct.name]]);
	const cloned = clone_node(trait_func) as FunctionNode;
	// The trait default is private (trait functions default to private);
	// as a struct method it must be callable like any other method.
	cloned.visibility = "pub";
	cloned.type_params = [];
	cloned.is_generic = false;
	cloned.return_type = substitute_type(cloned.return_type, substitution);
	for (const param of cloned.params) {
		substitute_param_signature(param, substitution);
	}
	// The trait's `self` param is typed as the trait name at parse; the
	// synthesized method belongs to the struct, so field access on `self`
	// must resolve against the struct's storage.
	const self_param = cloned.params.find((p) => p.is_self_param);
	if (self_param) {
		self_param.type = new Type(struct.name);
	}
	// The deferred comptime pieces resolve against the concrete conformer
	// now, so the clone's own check sees ordinary AST: the `#for` iterable
	// names the struct, and `META.info(Self)` chains (including inside the
	// arm, where the comptime `if`s fold) rewrite to literals. The same
	// order the monomorphizer applies to a specialized clone.
	substitute_pragma_iterables(cloned.statements, substitution);
	rewrite_meta_name_chains(cloned.statements, status, substitution);
	// The clone's nodes keep their TRAIT-source positions, so a compile
	// error inside the derived body points into the library file; the
	// marker lets the checker's diagnostics say what happened instead.
	cloned.is_trait_default_binding = true;
	struct.functions.push(cloned);
	return cloned;
}

/** Bind the reflection defaults for every registered struct — the
 *  block-level pre-pass (after gather_structs, before the walk), so a
 *  field whose type is a later-declared conformer resolves against that
 *  struct's bound clone. Idempotent: a re-run finds the method present. */
export function bind_trait_defaults_for_all(status: CheckStatus): void {
	for (const struct of status.structs) {
		bind_trait_defaults(struct, status);
	}
}
