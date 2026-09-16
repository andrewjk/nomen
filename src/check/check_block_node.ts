import add_error from "../add_error.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import BitsetNode from "../nodes/BitsetNode.ts";
import type BlockNode from "../nodes/BlockNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import EnumNode from "../nodes/EnumNode.ts";
import ExtendNode from "../nodes/ExtendNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import LetNode from "../nodes/LetNode.ts";
import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import Type from "../nodes/Type.ts";
import { instantiate_generic_type } from "./check_function_call_node.ts";
import check_node from "./check_node.ts";
import { resolve_struct_field_types } from "./check_struct_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import { synthesize_auto_derived_methods } from "./utils/auto_derive.ts";
import { extract_length_equalities_at_registration } from "./utils/flow_bounds.ts";
import materialize_type from "./utils/materialize_type.ts";
import { register_extern_for_ownership } from "./utils/ownership.ts";
import type_name from "./utils/type_name.ts";

export default function check_block_node(node: BlockNode, status: CheckStatus) {
	gather_structs(node, status);

	// Pre-register root-level `extern func` declarations so ANY earlier code
	// (user structs checked before the appended library) can resolve calls to
	// them. The extern adapter label (`extern_<name>`) and the ownership
	// classifier (a `#destroy` that calls an extern releases a resource) both
	// depend on the call's resolved function being findable regardless of
	// statement order — struct TYPES get the same treatment via
	// gather_structs. check_function_node still checks each extern in
	// statement order; the duplicate registration is harmless (findLast).
	if (node.node_type === "root") {
		for (const child of node.statements) {
			if (child.node_type === "func" && (child as FunctionNode).is_extern) {
				status.functions.push(child as FunctionNode);
				register_extern_for_ownership(child as FunctionNode);
			}
		}
	}

	// Merge each `extend struct/class Name { ... }` block's methods into the
	// named target struct, so the upcoming statement-order walk checks them
	// (and the build emits them) exactly like methods declared in the body.
	// Runs after gather_structs so the target is registered regardless of
	// source order, and regardless of whether the extend sits before or after
	// the struct (or extends a library type appended after user source).
	apply_extensions(node, status);

	// At the root, pre-register every top-level `const` so its name is visible
	// to functions compiled earlier in statement order — mirroring how
	// `gather_structs` exposes types. Without this, a `const` declared in an
	// imported library (appended after the user source) is unreachable from
	// `main`, surfacing as "Unknown value: NAME". The full entry (borrow info,
	// flow bounds, …) is recomputed when the declaration is checked in
	// statement order; this placeholder only carries the type so the name
	// resolves.
	if (node.node_type === "root") {
		gather_top_level_consts(node, status);
		// Resolve inferred struct field types upfront so they're visible to
		// functions checked before the struct that declares them (notably user
		// code that runs before the appended System library).
		resolve_struct_field_types(status);
	}

	// Auto-derive `to_string`, `#op_eq`, and `hash` for structs that conform
	// to the matching trait but don't supply the method. Runs in every block
	// (after gather_structs) so structs declared inside a function body are
	// derived too. Like the auto `#init`, a hand-written method always wins,
	// and the "already has function" guard makes this idempotent across nested
	// blocks.
	synthesize_auto_derived_methods(status);

	status.scope_depth++;
	status.stack.push(node);
	for (let child of node.statements) {
		check_node(child, status);
		check_must_use_enum_discard(child, status);
	}
	status.stack.pop();
	status.scope_depth--;

	hoist_discarded_class_results(node, status);
}

/**
 * A `must_use` enum or bitset's values may not be silently discarded: a
 * statement-position call (`f.close()`, `File.write_all(...)`) whose result
 * type is a must_use type is a compile error. Bind the value
 * (`var _ = f.close()`) or match on it — ignoring is fine, it just has to be
 * deliberate. Runs after `check_node` so the call's result `type` is
 * resolved. Declarations, assignments, returns and match scrutinees are all
 * uses and never reach this.
 */
function check_must_use_enum_discard(child: BaseNode, status: CheckStatus) {
	// Statement-position calls arrive in three shapes: a bare `f(...)` is a
	// func_call; `a.b(...)` and `File.delete(...)` are an access node wrapping
	// the call (the "(" tail is folded into parse_access). A `let`-prefixed
	// expression evaluates and discards, so its wrapped call counts too.
	let node: BaseNode = child;
	if (node.node_type === "let") node = (node as LetNode).value;
	let call: BaseNode | undefined;
	if (node.node_type === "func_call" || node.node_type === "access_func") {
		call = node;
	} else if (node.node_type === "access") {
		const inner = (node as AccessNode).access;
		if (inner?.node_type === "access_func") call = inner;
	}
	if (!call) return;
	const type = (call as AccessFunctionCallNode | FunctionCallNode).type;
	if (!type?.name) return;
	const must_use_enum = status.enums.find((e) => e.must_use && e.name === type.name);
	const must_use_bitset = must_use_enum
		? undefined
		: status.bitsets.find((b) => b.must_use && b.name === type.name);
	if (!must_use_enum && !must_use_bitset) return;
	add_error(
		status,
		`Value of must_use ${must_use_enum ? "enum" : "bitset"} ${must_use_type_display_name(must_use_enum ?? must_use_bitset!, type)} is discarded; bind it (e.g. \`var _ = …\`) or match on it`,
		child.start,
	);
}

/**
 * Render a must_use enum/bitset result type for the discard error message,
 * preferring the generic template's spelling (`Result<int, string>`) over the
 * monomorphized name (`Result_int_string`). Bitsets are never generic.
 */
function must_use_type_display_name(en: EnumNode | BitsetNode, type: Type): string {
	if (en.node_type === "enum") {
		const e = en as EnumNode;
		if (e.template_name && e.template_args?.length) {
			return `${e.template_name}<${e.template_args.map((a) => type_name(a)).join(", ")}>`;
		}
	}
	return type_name(type);
}

/**
 * Push placeholder `status.values` entries for non-primitive top-level
 * `const` declarations (e.g. geometry-type constants like `DEFAULT_PARAMS`).
 *
 * These are the same declarations the build pass inlines at every use site
 * (see `top_level_consts` in `BuildStatus`); without this pre-registration
 * they would be unreachable from `main`, which is compiled before the
 * library source that declares them. Primitive-typed module-level
 * declarations (ints, floats, …) are left for the normal statement-order walk
 * — they were already reachable as forward-declared file-scope globals, and
 * pre-registering them would falsely trip the "Parameter already declared"
 * guard when a function param shadows the module-level name.
 *
 * `is_set` matches the entry the statement-order walk would later push (true
 * iff the declaration has an initializer) because some lookups
 * (`check_assignment_node`'s const-assignment guard) use `Array.find` rather
 * than `findLast` and would otherwise see the placeholder.
 */
/**
 * Push placeholder `status.values` entries for every top-level `const`
 * declaration (e.g. geometry-type constants like `DEFAULT_PARAMS`, or
 * primitive sentinels like `ALIGN_CENTER` / `INF`).
 *
 * These are the same declarations the build pass either inlines at every use
 * site (non-primitives; see `top_level_consts` in `BuildStatus`) or
 * forward-declares as `extern` file-scope globals (primitives; see
 * `build_block_node`). Without this pre-registration they would be
 * unreachable from `main`, which is compiled before the library source that
 * declares them — surfacing as "Unknown value: NAME". The full entry (borrow
 * info, flow bounds, `const_value`, …) is recomputed when the declaration is
 * checked in statement order; this placeholder only carries the type so the
 * name resolves.
 *
 * A function parameter may legitimately shadow a module-level `const`; the
 * "Parameter already declared" guard in `check_function_parameter_node`
 * ignores `const` entries, so pre-registering them is safe.
 *
 * `is_set` matches the entry the statement-order walk would later push (true
 * iff the declaration has an initializer) because some lookups
 * (`check_assignment_node`'s const-assignment guard) use `Array.find` rather
 * than `findLast` and would otherwise see the placeholder.
 */
function gather_top_level_consts(block: BlockNode, status: CheckStatus) {
	const seen = new Set<string>();
	for (const child of block.statements) {
		if (child.node_type !== "declare") continue;
		const decl = child as DeclarationNode;
		if (decl.declaration !== "const") continue;
		if (!decl.name || !decl.type?.name) continue;
		if (decl.type.is_array) continue;
		if (seen.has(decl.name)) continue;
		seen.add(decl.name);
		status.values.push({
			declaration: decl.declaration,
			name: decl.name,
			type: decl.type,
			is_set: !!decl.value,
			start: decl.start,
			is_global: true,
		});
	}
}

/**
 * A bare statement that constructs (or obtains) a class instance without
 * binding it to a variable would leak: classes are heap-allocated and freed
 * by the owning variable's scope-exit cleanup, so an unbound instance is
 * never reclaimed. Hoist such a statement into an anonymous
 * `var T _disc_N = <call>` so the existing scope-exit reclamation frees it
 * (running its `#destroy` and field destroys first).
 *
 * Free functions and constructors returning a class always yield an owned
 * value. Method calls are hoisted only when they have an owned (`move out T`)
 * return — a borrowed return (e.g. `list.at(0)`) is owned by its receiver and
 * must NOT be freed here.
 */
function hoist_discarded_class_results(block: BlockNode, status: CheckStatus) {
	for (let i = 0; i < block.statements.length; i++) {
		const child = block.statements[i];
		const result_type = discarded_class_result_type(child, status);
		if (!result_type) continue;
		const original = child as DeclarationNode["value"] & {
			allocations?: DeclarationNode[];
		};
		const decl = new DeclarationNode(
			child.start,
			"private",
			"var",
			`_disc_${status.var_name_counter.value++}`,
			clone_type(result_type),
			original,
		);
		// The call's hoisted param temporaries (if any) were attached to it by
		// promote_allocations (its parent was this block). Move them onto the
		// wrapping declaration so build_node emits them first — the constructor
		// declaration path doesn't recurse through build_node on its value, so
		// leaving them on the call would drop them.
		if (original.allocations) {
			decl.allocations = original.allocations;
			original.allocations = undefined;
		}
		block.statements[i] = decl;
	}
}

function discarded_class_result_type(
	child: BlockNode["statements"][number],
	status: CheckStatus,
): Type | undefined {
	// The call's result type lives on the call node itself: a free function
	// call carries it as `node.type`, while a method call (`access`/access_func)
	// carries it on the inner `access.type` (the wrapping AccessNode has none).
	const t =
		child.node_type === "access"
			? ((child as AccessNode).access as { type?: Type })?.type
			: (child as { type?: Type }).type;
	if (!t?.name) return undefined;
	if (!status.structs.find((s) => s.name === t.name && s.is_class)) return undefined;
	if (child.node_type === "func_call") return t;
	if (
		child.node_type === "access" &&
		(child as AccessNode).access.node_type === "access_func" &&
		((child as AccessNode).access as AccessFunctionCallNode).owned_return
	) {
		return t;
	}
	return undefined;
}

function clone_type(t: Type): Type {
	const c = new Type(t.name, t.is_static, t.is_array, t.length);
	c.is_ref = t.is_ref;
	c.is_nullable = t.is_nullable;
	c.type_args = t.type_args;
	return c;
}

/**
 * Strip parallel-length equality clauses (`a.length == b.length`) from every
 * parameter's constraint of `func` at SIGNATURE-GATHER time — before any call
 * site can observe the signature, regardless of declaration order. A
 * forward-referenced callee must not hand its caller a clause no call site
 * could ever prove; the clause becomes an assumed equality for the callee's
 * own body instead (stashed on the param, seeded into scope when its params
 * are checked). Idempotent: a constraint already stripped has no clauses
 * left to extract. `check_function_node` re-runs the same extraction at
 * registration for function clones that never pass through a gather pass
 * (generic monomorphizations).
 */
function strip_param_length_equalities(func: FunctionNode) {
	const param_names = new Set(func.params.map((p) => p.name));
	for (const param of func.params) {
		if (!param.constraint) continue;
		const { constraint, equalities } = extract_length_equalities_at_registration(
			param.constraint,
			param.name,
			param_names,
		);
		if (equalities.length) {
			param.constraint = constraint;
			param.stripped_length_equalities = equalities;
		}
	}
}

function gather_structs(block: BlockNode, status: CheckStatus) {
	const names_in_block = {
		structs: new Set<string>(),
		traits: new Set<string>(),
		functions: new Set<string>(),
		enums: new Set<string>(),
		bitsets: new Set<string>(),
	};

	for (let node of block.statements) {
		switch (node.node_type) {
			case "struct": {
				const struct = node as StructNode;
				if (names_in_block.structs.has(struct.name)) {
					add_error(status, `Struct already declared: ${struct.name}`, struct.start);
				} else {
					names_in_block.structs.add(struct.name);
					assign_type_label(struct, block, status);
					struct.scope = status.stack.at(-1) || block;
					struct.is_generic = struct.type_params.length > 0;
					// Strip parallel-length clauses from every method's params
					// at gather time — same reason as free functions below: a
					// caller declared before this struct must see the stripped
					// signature, not a clause no call site could ever prove
					// (stripping only in check_struct_node is file-order
					// dependent).
					for (const func of struct.functions) {
						strip_param_length_equalities(func);
					}
					status.types.push(struct.name);
					status.structs.push(struct);
				}
				break;
			}
			case "trait": {
				const trait = node as TraitNode;
				if (names_in_block.traits.has(trait.name)) {
					add_error(status, `Trait already declared: ${trait.name}`, trait.start);
				} else {
					names_in_block.traits.add(trait.name);
					status.types.push(trait.name);
					status.traits.push(trait);
					// Trait method signatures get the same gather-time
					// parallel-length strip as struct methods and free
					// functions, so call sites checked before this trait's
					// statement walk never see the unstripped clause.
					for (const func of trait.functions) {
						strip_param_length_equalities(func);
					}
				}
				break;
			}
			case "func": {
				const func = node as FunctionNode;
				if (names_in_block.functions.has(func.name)) {
					add_error(status, `Function already declared: ${func.name}`, func.start);
				} else {
					names_in_block.functions.add(func.name);
					func.scope = status.stack.at(-1) || block;
					// Materialize tuple / anonymous enum return types upfront so
					// callers that are checked before this function (e.g. a
					// sibling file earlier in the concatenation) see the
					// resolved generated type, not the unmaterialized
					// `tuple`/`anon_enum` placeholder. Generic enum return
					// types (`out Result<int, string>`) are instantiated here
					// for the same reason — the annotation is rewritten to the
					// mono name, which callers match against.
					func.return_type = materialize_type(func.return_type, status);
					instantiate_generic_type(func.return_type, status);
					// Gather-time parallel-length strip (see
					// strip_param_length_equalities): callers checked before this
					// function's statement walk must see the stripped
					// signature.
					strip_param_length_equalities(func);
					assign_function_label(func, block, status);
					status.functions.push(func);
				}
				break;
			}
			case "enum": {
				const enum_node = node as EnumNode;
				if (names_in_block.enums.has(enum_node.name)) {
					add_error(status, `Enum already declared: ${enum_node.name}`, enum_node.start);
				} else {
					names_in_block.enums.add(enum_node.name);
					assign_type_label(enum_node, block, status);
					enum_node.is_generic = enum_node.type_params.length > 0;
					status.types.push(enum_node.name);
					status.enums.push(enum_node);
				}
				break;
			}
			case "bitset": {
				const bitset_node = node as BitsetNode;
				if (names_in_block.bitsets.has(bitset_node.name)) {
					add_error(status, `Bitset already declared: ${bitset_node.name}`, bitset_node.start);
				} else {
					names_in_block.bitsets.add(bitset_node.name);
					assign_type_label(bitset_node, block, status);
					status.types.push(bitset_node.name);
					status.bitsets.push(bitset_node);
				}
				break;
			}
		}
	}
}

/** A declared type node whose emission name may be scoped. */
interface ScopedTypeNode {
	name: string;
	source_name?: string;
	/** Emission label of the function whose body declares this type. */
	emission_scope?: string;
}

/**
 * Give a NESTED type declaration a scope-unique emission name when its source
 * name is declared more than once in the program (the build flattens every type
 * into one name-keyed table, so a same-named type in another function scope
 * would otherwise poison init/destroy dispatch and monomorphization). Top-level
 * declarations keep their source name — only nested ones are renamed, and only
 * on an actual collision, so unique nested types (and library types) are
 * unchanged. The label is `<enclosing function label>_<source name>`, uniquified
 * against every assigned type emission name.
 */
function assign_type_label(node: ScopedTypeNode, block: BlockNode, status: CheckStatus) {
	const counts = status.type_name_counts;
	if (!counts || (counts.get(node.name) ?? 0) <= 1) return;
	if (block.node_type === "root") return;
	const taken = status.type_emission_names;
	if (!taken) return;
	const parent =
		block.node_type === "func"
			? (block as unknown as FunctionNode)
			: (status.stack.findLast((n) => n.node_type === "func") as FunctionNode | undefined);
	const source = node.name;
	const scope_key = parent?.label_name ?? parent?.name;
	const base = `${scope_key ?? "nested"}_${source}`;
	let label = base;
	let suffix = 2;
	while (taken.has(label) || status.types.includes(label)) label = `${base}_${suffix++}`;
	node.source_name = source;
	node.name = label;
	node.emission_scope = scope_key;
	taken.add(label);
}

/**
 * Assign `label_name` (the unique backend emission label) to a function at
 * gather time. Top-level functions (gathered from the ROOT block) keep their
 * source name — no label. A function declared inside another function body
 * gets `<parent>_<name>`: call resolution is parent-scoped during checking
 * (each body's cloned function table), but both backends hoist nested funcs
 * to file scope, so siblings sharing a bare name — or monomorphized clones
 * of the same generic parent — would emit colliding symbols. The label is
 * uniquified against every function emission name in the program (the shared
 * `function_emission_names` set); `name` stays the source name so calls keep
 * resolving. check_function_node registers the emission name of every
 * function that flows through it (covering clones that skip this gather).
 */
function assign_function_label(func: FunctionNode, block: BlockNode, status: CheckStatus) {
	const taken = status.function_emission_names;
	if (block.node_type === "root" || !taken) {
		if (taken) register_emission_name(func, taken);
		return;
	}
	// Parent: the body being gathered is the enclosing FunctionNode itself
	// (its check_block_node runs gather BEFORE pushing anything), or — for a
	// func declared in a deeper block (if/while/match) — the nearest function
	// already on the stack (pushed by its check_block_node before walking).
	const parent =
		block.node_type === "func"
			? (block as FunctionNode)
			: (status.stack.findLast((n) => n.node_type === "func") as FunctionNode | undefined);
	const base = `${parent?.name ?? "nested"}_${func.name}`;
	let label = base;
	let suffix = 2;
	while (taken.has(label)) label = `${base}_${suffix++}`;
	func.label_name = label;
	register_emission_name(func, taken);
}

function register_emission_name(func: FunctionNode, taken: Set<string>) {
	taken.add(func.label_name ?? func.name);
}

/**
 * Merge each top-level `extend struct Name { ... }` / `extend class Name`
 * block's methods — and any `: Trait1, Trait2` out-of-line conformances —
 * into the named target struct.
 *
 * The target must already be registered (gather_structs ran first), and the
 * extend's `is_class` flag must match the target's — `extend class` is only
 * valid on a class, `extend struct` only on a struct. After merging, the
 * methods are indistinguishable from methods declared in the original body:
 * check_struct_node checks them (including its duplicate-name guard, so an
 * extend that redeclares an existing method errors), and the build emits them
 * as `<Struct>_<method>`.
 *
 * Methods added here are also reachable through trait dispatch when the
 * struct conforms — nothing else needs to know they came from an extend.
 *
 * Traits declared on the extend (`extend struct S: Trait { ... }`) are
 * appended to the target's `traits` / `trait_args` arrays. A trait the
 * target already conforms to (whether from its body or a prior extend) is a
 * duplicate error rather than a silent re-merge, since it would otherwise
 * trip duplicate-vtable emission in the build. The merged traits flow into
 * the same conformance check, generic-default synthesis, and vtable build
 * as body-declared traits, so out-of-line conformance is first-class.
 */
function apply_extensions(block: BlockNode, status: CheckStatus) {
	for (const node of block.statements) {
		if (node.node_type !== "extend") continue;
		const ext = node as ExtendNode;
		const target = status.structs.find((s) => s.name === ext.name);
		if (!target) {
			add_error(status, `Cannot extend unknown type: ${ext.name}`, ext.start);
			continue;
		}
		if (!!target.is_class !== !!ext.is_class) {
			add_error(
				status,
				`Cannot extend ${target.is_class ? "class" : "struct"} '${ext.name}' with extend ${ext.is_class ? "class" : "struct"}`,
				ext.start,
			);
			continue;
		}
		ext.scope = target;
		for (const func of ext.functions) {
			// Extend-merged methods go through the same gather-time
			// parallel-length strip as methods declared in the struct body.
			strip_param_length_equalities(func);
			target.functions.push(func);
		}
		for (let i = 0; i < ext.traits.length; i++) {
			if (target.traits.includes(ext.traits[i])) {
				add_error(
					status,
					`Type '${ext.name}' already conforms to trait '${ext.traits[i]}'`,
					ext.start,
				);
				continue;
			}
			target.traits.push(ext.traits[i]);
			target.trait_args.push(ext.trait_args[i]);
		}
	}
}
