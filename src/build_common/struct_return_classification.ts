import type BuildStatus from "../build_c/BuildStatus.ts";
import emission_label from "../build_common/emission_label.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import StructNode from "../nodes/StructNode.ts";
import { struct_needs_destroy } from "./destroy_analysis.ts";
import { direct_string_fields } from "./has_string_fields.ts";

/**
 * Pre-build classification of which functions return value structs whose
 * string fields are UNIFORMLY heap-owned via return-boundary normalization.
 * Populates `status.normalized_struct_returners`; a caller binding a call
 * result of a registered function records the struct's string fields and
 * frees them at scope exit, while bindings of unregistered callees keep the
 * pre-existing borrow behavior (never recorded, never freed — sound, though
 * it may leak on slot overwrites, which is the documented status quo).
 *
 * The rule is deliberately narrow: a function normalizes iff EVERY
 * struct-return statement returns a BARE VARIABLE (a local or parameter).
 * That is the transfer shape — the returned variable dies at the return, so
 * the boundary normalization (transfer recorded heap fields, strdup the
 * rest) is sound and leak-free. Every other shape keeps the status quo:
 *
 *   - container borrow accessors (`at`/`first`/`slice`/`load` — e.g.
 *     `Map.get`'s `return self.values.load_T(idx)`) yield SLOT-owned bytes;
 *     normalizing them would leak in expression-temp consumers
 *     (`m.get(k).field`) that nobody records or frees;
 *   - owned accessors (`pop`/`move_T`/`copy`) transfer slot-owned heap
 *     buffers — the caller's recording is sound WITHOUT normalization, so
 *     they record via the owned-accessor rule (see
 *     call_init_string_fields.ts) and the callee skips the copy;
 *   - forwarded calls (`return make()`) are skipped when the callee is
 *     registered (its result is already uniformly owned — copying it would
 *     leak the inner buffers) and keep the status quo when it is not.
 *
 * This runs as a WHOLE-PROGRAM AST PRE-PASS (before any function body is
 * built) because a build-order-sensitive registry cannot work: nested
 * functions are built after their enclosing function's body, so a runtime
 * registration would be invisible to the caller's earlier lookup.
 */

/** Collect every function and struct declaration under the AST (including
 *  nested functions, struct methods, and function bodies at any depth). */
function collect(node: BaseNode, fns: FunctionNode[], structs: StructNode[], seen: Set<BaseNode>) {
	if (!node || typeof node !== "object" || seen.has(node)) return;
	seen.add(node);
	if ((node as FunctionNode).node_type === "func") fns.push(node as FunctionNode);
	if ((node as StructNode).node_type === "struct") structs.push(node as StructNode);
	for (const key of Object.keys(node)) {
		if (key === "parent" || key === "scope") continue;
		const value = (node as unknown as Record<string, unknown>)[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (item && typeof item === "object" && "node_type" in item) {
					collect(item as BaseNode, fns, structs, seen);
				}
			}
		} else if (value && typeof value === "object" && "node_type" in value) {
			collect(value as BaseNode, fns, structs, seen);
		}
	}
}

/** The DIRECT `return <expr>` statements of a function body (nested function
 *  declarations are not descended into — their returns belong to them). */
function direct_returns(fn: FunctionNode): ReturnNode[] {
	const out: ReturnNode[] = [];
	const seen = new Set<BaseNode>();
	const walk = (node: BaseNode) => {
		if (!node || typeof node !== "object" || seen.has(node)) return;
		seen.add(node);
		if ((node as FunctionNode).node_type === "func" && node !== (fn as unknown as BaseNode)) {
			return;
		}
		if (node.node_type === "return") out.push(node as ReturnNode);
		for (const key of Object.keys(node)) {
			if (key === "parent" || key === "scope") continue;
			const value = (node as unknown as Record<string, unknown>)[key];
			if (Array.isArray(value)) {
				for (const item of value) {
					if (item && typeof item === "object" && "node_type" in item) {
						walk(item as BaseNode);
					}
				}
			} else if (value && typeof value === "object" && "node_type" in value) {
				walk(value as BaseNode);
			}
		}
	};
	for (const statement of fn.statements ?? []) walk(statement);
	return out;
}

/** Whether the function is a FREE function: not a method of a struct (whose
 *  element/slot params are passed by address for in-place access) and not a
 *  monomorphized container clone. */
export function is_free_function_node(fn: FunctionNode): boolean {
	const scope = fn.scope as { node_type?: string } | undefined;
	return !scope || scope.node_type === "root" || scope.node_type === "func";
}

/**
 * Whole-program pre-pass: classify free functions that take an OWNING value
 * struct parameter (string fields) — those get pass-by-value semantics:
 *
 *   - the CALL SITE materializes a uniformly heap-owned shell (struct-copy
 *     + per-string-field strdup) and passes its address;
 *   - the CALLEE seeds the param's string-field records at entry and frees
 *     the surviving fields (and the shell) at scope exit.
 *
 * Writes through the param then stay local to the callee; the caller's
 * variable is never aliased or mutated. Functions whose address escapes
 * into a func-typed value (`var f = g`, `apply(g, …)`, `b.modify(0, touch)`)
 * are EXCLUDED: they may be invoked through a pointer with a borrowed
 * argument, and keep the status quo (borrow + the documented write leak).
 *
 * Populates `status.normalized_struct_returners` (the materializing set) and
 * `status.func_address_taken` (the excluded set) for the call-site and
 * function-definition builders.
 */
export function gather_normalized_struct_returners(root: BaseNode, status: BuildStatus): void {
	const fns: FunctionNode[] = [];
	const structs: StructNode[] = [];
	collect(root, fns, structs, new Set());

	// Functions whose address escapes into a func-typed VALUE (`var f = g`,
	// `apply(g, …)`, `b.modify(0, touch)`) may be invoked through a pointer
	// with a BORROWED argument — pass-by-value must not apply to them.
	const address_taken = new Set<string>();
	const value_walk = (node: BaseNode) => {
		if (!node || typeof node !== "object") return;
		if (node.node_type === "value") {
			const v = node as unknown as {
				value?: unknown;
				type?: { name?: string };
			};
			if (typeof v.value === "string" && v.type?.name === "func" && /^[A-Za-z_]/.test(v.value)) {
				address_taken.add(v.value);
			}
		}
		for (const key of Object.keys(node)) {
			if (key === "parent" || key === "scope") continue;
			const child = (node as unknown as Record<string, unknown>)[key];
			if (Array.isArray(child)) {
				for (const item of child) {
					if (item && typeof item === "object" && "node_type" in item) value_walk(item as BaseNode);
				}
			} else if (child && typeof child === "object" && "node_type" in child) {
				value_walk(child as BaseNode);
			}
		}
	};
	value_walk(root);

	// Func-typed DECLARATIONS (`var func … f = …`) escape too: the variable
	// can be reassigned or invoked through a pointer.
	const decl_walk = (node: BaseNode) => {
		if (!node || typeof node !== "object") return;
		const d = node as unknown as {
			name?: unknown;
			node_type?: string;
			type?: { name?: string };
		};
		if (d.node_type === "declaration" && typeof d.name === "string" && d.type?.name === "func") {
			address_taken.add(d.name);
		}
		for (const key of Object.keys(node)) {
			if (key === "parent" || key === "scope") continue;
			const child = (node as unknown as Record<string, unknown>)[key];
			if (Array.isArray(child)) {
				for (const item of child) {
					if (item && typeof item === "object" && "node_type" in item) decl_walk(item as BaseNode);
				}
			} else if (child && typeof child === "object" && "node_type" in child) {
				decl_walk(child as BaseNode);
			}
		}
	};
	decl_walk(root);

	// RETURN-side candidates: functions whose struct-typed returns are ALL
	// bare locals/params (the transfer shape — e1a9c122), so the caller can
	// record the returned binding's string fields. Fixpoint: forwarded calls
	// (`return make()`) are owned iff the callee is normalizing.
	const return_candidates: FunctionNode[] = [];
	for (const fn of fns) {
		if (!is_free_function_node(fn)) continue;
		if (address_taken.has(fn.name)) continue;
		const ret = fn.return_type;
		if (!ret || ret.is_array || ret.is_view) continue;
		const ret_struct = structs.find(
			(st) => st.name === ret.name && !st.is_simple_type && !st.is_class,
		);
		if (!ret_struct || direct_string_fields(ret_struct).length === 0) continue;
		return_candidates.push(fn);
	}
	const return_normalizing = new Set<string>(return_candidates.map((c) => c.name));
	let changed = true;
	while (changed) {
		changed = false;
		for (const fn of return_candidates) {
			if (!return_normalizing.has(fn.name)) continue;
			const ret_struct = structs.find(
				(st) => st.name === fn.return_type?.name && !st.is_simple_type && !st.is_class,
			);
			for (const ret of direct_returns(fn)) {
				// A base-bearing anonymous struct literal (`[ .. <base>, f = v ]`)
				// is classed by its BASE: a non-ctor base keeps the literal node
				// (only ctor-call bases are rewritten to `field_overrides`), and
				// a registered-normalizer base is the forwarded-override shape —
				// the boundary strdups the overridden fields.
				let value = ret.value ?? undefined;
				if (value?.node_type === "anon_struct") {
					const base = (value as unknown as { base?: BaseNode }).base;
					if (base?.node_type === "func_call") value = base;
				}
				if (value && value.node_type === "value") continue;
				if (
					value &&
					value.node_type === "func_call" &&
					return_normalizing.has((value as unknown as { name?: string }).name ?? "")
				) {
					continue;
				}
				// A USER struct CONSTRUCTOR return (`return R(a, b)`) — including
				// the override-constructor form (`return [ .. R(a), f = v ]`, a
				// func_call with `field_overrides`) — is normalizable: the return
				// boundary strdups the returned struct's non-owned string fields
				// (override-aware), so the caller can uniformly own them. A
				// FORWARDED call carrying overrides (`return [ .. make(), f = v ]`)
				// is normalizable when the forwarded callee is itself registered:
				// the base's fields are already uniformly owned and the boundary
				// strdups the overridden ones. Synthetic returns (`_Tuple_…`,
				// `_Anon…`) carry their own normalization and are excluded.
				if (
					value &&
					value.node_type === "func_call" &&
					!!ret_struct &&
					!ret_struct.name.startsWith("_") &&
					((value as unknown as { name?: string }).name === ret_struct.name ||
						(!!(value as unknown as { field_overrides?: unknown[] }).field_overrides?.length &&
							return_normalizing.has((value as unknown as { name?: string }).name ?? "")))
				) {
					continue;
				}
				return_normalizing.delete(fn.name);
				changed = true;
				break;
			}
		}
	}

	for (const fn of fns) {
		if (!is_free_function_node(fn)) continue;
		if (address_taken.has(fn.name)) continue;
		// A struct METHOD (self param) — including monomorphized method
		// clones, whose `scope` back-pointer may be unset — receives its
		// receiver by address for in-place access: never pass-by-value, and
		// its `move T` params keep the plain callee-copies convention.
		if (fn.params.some((p) => p.is_self_param)) continue;
		// The checker's node-level escape flag is authoritative: a function
		// whose address escapes (a func-typed binding, a spawn-wrapped call)
		// is invoked through a pointer with a BORROWED argument — the env /
		// caller's storage is the ownership boundary, and neither the call
		// sites nor the callee may apply pass-by-value. (The name walk above
		// catches the direct `var f = g` shape; this covers lambda and spawn
		// targets whose source names never appear as func-typed values.)
		if (fn.address_escaped) continue;
		// A body-less function (extern / forward declaration) has no callee
		// side to seed the param's records — its parameter keeps the plain
		// by-address convention, so callers must not materialize for it.
		if (!fn.has_body) continue;
		for (const param of fn.params ?? []) {
			// A `move`-declared pass-by-value owning-struct param registers
			// too: the TRANSFER row — the callee seeds (and frees) the
			// argument's string records, callers drop instead of materialize.
			// The struct-shape conjunction below still excludes structs with
			// non-string ownership (a transfer of those can't be seeded).
			if (param.is_self_param || param.is_variadic) continue;
			if (param.type.is_ref || param.type.is_nullable || param.type.is_view || param.type.is_array)
				continue;
			const struct = param.type.name
				? structs.find((st) => st.name === param.type.name && !st.is_simple_type && !st.is_class)
				: undefined;
			if (!struct) continue;
			if (
				direct_string_fields(struct).length > 0 &&
				!(struct.traits ?? []).length &&
				!struct_needs_destroy(struct, status as never)
			) {
				if (!status.normalized_struct_returners) status.normalized_struct_returners = new Set();
				// Register under BOTH the emission label and the source name:
				// call sites look the callee up by its emission label (nested
				// functions emit under `<parent>_<name>`), while source-level
				// references (address-taken checks) use the source name.
				status.normalized_struct_returners.add(fn.name);
				status.normalized_struct_returners.add(emission_label(fn));
				break;
			}
		}
		// The RETURN-side set: bare-local struct returns transfer ownership
		// to the caller, so the caller records the returned binding's fields.
		if (return_normalizing.has(fn.name)) {
			if (!status.normalized_struct_returners) status.normalized_struct_returners = new Set();
			status.normalized_struct_returners.add(fn.name);
			status.normalized_struct_returners.add(emission_label(fn));
		}
	}

	// Struct `copy` methods (synthesized for owning value structs, or
	// user-written): their bare-local `return c` is normalized at the return
	// boundary like any function, so a binding of the result records the
	// struct's string fields. Method calls register under their EMISSION
	// LABEL (`<Struct>_copy`) — the bare method name would conflate
	// unrelated types' methods (is_normalized_struct_call resolves the
	// receiver's type to the mono name before looking the label up).
	for (const struct of structs) {
		if (struct.is_class || struct.is_generic || struct.is_simple_type) continue;
		if (!struct.functions.some((f) => f.name === "copy" && f.has_body)) continue;
		if (direct_string_fields(struct).length === 0) continue;
		if (!status.normalized_struct_returners) status.normalized_struct_returners = new Set();
		status.normalized_struct_returners.add(`${struct.name}_copy`);
	}
	if (!status.func_address_taken) status.func_address_taken = new Set();
	for (const name of address_taken) status.func_address_taken.add(name);
}
