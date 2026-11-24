import add_error from "../add_error.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_declaration_node from "./check_declaration_node.ts";
import {
	monomorphize,
	substitute_type,
	synthesize_generic_trait_defaults,
} from "./check_function_call_node.ts";
import check_function_node from "./check_function_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import { is_box_type } from "./utils/box.ts";
import check_init_assigns_all_fields from "./utils/check_init_fields.ts";
import { bind_comptime_self, expand_struct_member_pragmas } from "./utils/comptime.ts";
import { display_field_set } from "./utils/field_effects.ts";
import { slot_requires_mv } from "./utils/mv_rule.ts";
import {
	is_class_type,
	is_owning_struct_type_requiring_move,
	type_owns_heap,
} from "./utils/ownership.ts";
import type_from_value from "./utils/type_from_value.ts";
import type_name from "./utils/type_name.ts";

function params_differ(a: FunctionNode, b: FunctionNode): boolean {
	const a_params = a.params.filter((p) => !p.is_self_param);
	const b_params = b.params.filter((p) => !p.is_self_param);
	if (a_params.length !== b_params.length) return true;
	for (let i = 0; i < a_params.length; i++) {
		if (a_params[i].type.name !== b_params[i].type.name) return true;
	}
	return false;
}

/**
 * The auto-generated `#init`: one parameter per non-defaulted,
 * non-private field (func-typed fields carry their SIGNATURE so a lambda
 * argument can infer its parameter types). Ex-parse-time synthesis —
 * moved to check time so the constructor covers the FINAL member list
 * (`#if`-selected and `#for`-generated fields included; see the call
 * site in check_struct_node). Stamped `is_synthesized_init` so the
 * post-expansion re-synthesis can find and replace it.
 */
function build_auto_init(struct: StructNode): FunctionNode {
	const func = new FunctionNode(-1, struct.visibility, "#init", new Type(struct.name));
	func.is_synthesized_init = true;
	// The synthesized init belongs to the struct's namespace/file: a
	// mono's namespace resolves through it (docs/SCOPING.md).
	func.namespace = struct.namespace;
	func.file_id = struct.file_id;
	func.params = struct.fields
		.filter((f) => f.visibility !== "private" && !f.value)
		.map((f) => {
			const param = new ParameterNode(-1, f.name, f.func_params ? new Type("func") : f.type);
			if (f.func_params) {
				param.func_params = f.func_params;
				param.func_return_type = f.func_return_type;
			}
			if (f.declaration === "mv") {
				param.is_moved = true;
			}
			param.constraint = f.constraint;
			return param;
		});
	func.is_static = true;
	return func;
}

/**
 * Pre-synthesize the auto `#init` for every registered struct whose
 * constructor isn't written — a forward constructor call (`RxProg()` in a
 * function checked before the struct) must resolve. Runs after each
 * block's gather; check_struct_node re-synthesizes after member expansion
 * when the member list changed.
 */
export function synthesize_auto_inits(status: CheckStatus): void {
	for (const struct of status.structs) {
		if (struct.is_generic || struct.is_simple_type) continue;
		if (struct.name.startsWith("_Tuple_") || struct.name.startsWith("_Anon_")) continue;
		// A monomorphized struct's constructor is monomorphize's own synthesis
		// (pushed mid-loop — a pre-pass running inside that window must not
		// add a second one).
		if ((struct as unknown as { source_type_args?: unknown[] }).source_type_args?.length) {
			continue;
		}
		synthesize_auto_init_once(struct);
	}
}

/** Synthesize the auto `#init` unless a written one exists. Idempotent:
 *  an existing synthesized init is left alone here (check_struct_node
 *  replaces it when expansion changed the fields). */
function synthesize_auto_init_once(struct: StructNode): void {
	const existing = struct.functions.find((f) => f.name === "#init");
	if (existing && !existing.is_synthesized_init) return;
	if (struct.functions.some((f) => f.name === "#spawn")) return;
	if (existing?.is_synthesized_init) return;
	struct.functions.unshift(build_auto_init(struct));
}

/** Replace a pre-synthesized `#init` when expansion changed the member
 *  list (`#if`-selected / `#for`-generated fields): the fresh shape's
 *  parameter signature must match, or the constructor is rebuilt in place
 *  (never re-ordered — registration order is stable and the stale body is
 *  unchecked until the struct's own walk). */
function refresh_auto_init(struct: StructNode): void {
	const existing = struct.functions.find((f) => f.name === "#init");
	if (!existing?.is_synthesized_init) return;
	const fresh = build_auto_init(struct);
	const same_shape =
		existing.params.length === fresh.params.length &&
		existing.params.every((p, i) => p.name === fresh.params[i].name);
	if (same_shape) return;
	const index = struct.functions.indexOf(existing);
	struct.functions[index] = fresh;
}

export default function check_struct_node(struct: StructNode, status: CheckStatus) {
	// Stage 3: expand the body's `#for` member loops first, so every
	// downstream consumer (cycle detector, trait conformance, the auto
	// `#init`, field checks) sees the FINAL member list. `#if` member arms
	// were already folded (the check() pre-pass).
	expand_struct_member_pragmas(struct, status);

	// Synthesize the auto `#init` HERE rather than at parse time: the
	// constructor must cover the FINAL member list, including fields that
	// only exist for this target (`#if`-selected members folded at the
	// start of check) and `#for`-generated members (expanded above).
	// A `#spawn` construction hook (ASYNC.md) suppresses the default
	// `#init` too: the class constructs through the compiler's
	// deferred-call special form, not an ordinary constructor. The
	// pre-pass already placed one for forward references — replace it when
	// expansion changed the member shape.
	//
	// A destructor cannot be Copyable: copying a struct that declares
	// `#destroy` would run the destructor once per copy, and every copy would
	// release the same resource. The declaration is the ownership contract,
	// so the Copyable claim is rejected here, naming the fix — the same
	// posture as the mv-field verifier. Covers body-, extend-, `#if`-folded,
	// and `#for`-generated destructors (all present by this point).
	const destroy_func = struct.is_class
		? undefined
		: struct.functions.find((f) => f.name === "#destroy");
	if (!struct.is_class && !struct.is_owning && destroy_func) {
		add_error(
			status,
			`'${struct.name}' cannot be Copyable — it declares #destroy --> mark the struct \`mv struct ${struct.name}\`, or remove the destructor`,
			destroy_func.start,
		);
	}

	refresh_auto_init(struct);

	// STRUCT_PLAN_3 B1 full cutover — compiler-generated tuple / anonymous
	// struct declarations cannot be spelled `mv`, so their ownership is
	// re-derived here, at statement-check time: every referenced mono is
	// registered by now (the creation-time derive can run before a generic
	// element monomorphizes and so under-derives).
	if (struct.name.startsWith("_Tuple_") || struct.name.startsWith("_Anon_")) {
		struct.is_owning = struct.fields.some((f) => type_owns_heap(f.type, status));
	}
	// STRUCT_PLAN_3 B2 — the inline-containment cycle detector: a value
	// struct whose fields reach themselves through NON-Box value-struct
	// fields has no finite layout. The error prescribes the fix: declare the
	// closing field `Box<T>` (the box is a pointer — the cycle breaks).
	detect_inline_containment_cycle(struct, status);
	for (let i = 0; i < struct.traits.length; i++) {
		const trait_name = struct.traits[i];
		const trait = status.traits.find((t) => t.name === trait_name);
		if (!trait) {
			add_error(status, `Unknown trait: ${trait_name}`, struct.start);
			continue;
		}
		// Validate generic-trait conformance arity: `struct Users: Viewable<User>`
		// must supply exactly as many type args as the trait declares type
		// params. Missing args on a generic trait, or extra args on a plain
		// trait, are compile errors.
		const args = struct.trait_args[i];
		if (trait.type_params.length > 0 && !args) {
			add_error(
				status,
				`Trait '${trait_name}' expects ${trait.type_params.length} type argument(s) <${trait.type_params.join(", ")}>, got none`,
				struct.start,
			);
		} else if (args && args.length !== trait.type_params.length) {
			add_error(
				status,
				`Trait '${trait_name}' expects ${trait.type_params.length} type argument(s), got ${args.length}`,
				struct.start,
			);
		}
	}

	// Synthesize per-conformer default-method overrides for generic traits
	// (e.g. `trait Box<T> { func get = (self, out T) { return self.item } }`
	// cloned with T→int onto each `struct IB: Box<int>`). Must run after the
	// arity validation above so an invalid conformance doesn't synthesize
	// against missing args.
	synthesize_generic_trait_defaults(struct, status);

	// Enforce trait conformance: every required (bodyless) trait method must
	// be implemented, and any override must match the trait's signature.
	// Runs after synthesize_generic_trait_defaults (so generic-trait default
	// clones are present) and after the block-level auto-derive pre-pass
	// (so auto-derived to_string/eq/hash satisfy their traits).
	check_trait_conformance(struct, status);

	for (let i = 0; i < struct.fields.length; i++) {
		for (let j = i + 1; j < struct.fields.length; j++) {
			if (struct.fields[i].name === struct.fields[j].name) {
				add_error(
					status,
					`Field already declared: ${struct.fields[j].name}`,
					struct.fields[j].start,
				);
			}
		}
	}

	for (let i = 0; i < struct.functions.length; i++) {
		for (let j = i + 1; j < struct.functions.length; j++) {
			if (struct.functions[i].name === struct.functions[j].name) {
				if (!params_differ(struct.functions[i], struct.functions[j])) {
					add_error(
						status,
						`Function already declared: ${struct.functions[j].name}`,
						struct.functions[j].start,
					);
				}
			}
		}
	}

	const types_length_before = status.types.length;
	status.types.push(...struct.type_params);

	const type_params_length_before = status.type_params.length;
	status.type_params.push(...struct.type_params);

	// Validate trait bounds on type params: `struct Container<T: Control>`
	// requires each named bound to be a known trait. The actual conformance
	// check (that a concrete type arg conforms to the bound) happens at
	// monomorphization, once the type args are known.
	const bounds_parallel = struct.type_param_bounds.length === struct.type_params.length;
	for (let i = 0; i < struct.type_params.length; i++) {
		const bounds = bounds_parallel ? struct.type_param_bounds[i] : [];
		for (const bound of bounds) {
			if (!status.traits.find((t) => t.name === bound)) {
				add_error(status, `Unknown trait bound: ${bound}`, struct.start);
			}
		}
	}

	const values_length_before_fields = status.values.length;
	for (let decl of struct.fields) {
		decl.scope = struct;
		// A `ref` field would be a non-mv borrow stored in a struct with
		// no representation of its own (an 8-byte bare pointer), which could
		// outlive its target (UAF). Reject it at the field level — this
		// matches `MEMORY.md` and closes the gap where a `ref` field with a
		// default value or custom `#init` was accepted (cve-rs probe).
		//
		// `view T` fields ARE allowed: a view is a self-contained 16-byte
		// (ptr, len) pair, so storing it in a struct is a plain value copy —
		// sound to byte-copy, nothing to free (non-mv). The escape hazards
		// are closed structurally: a struct with `view` fields is a
		// scope-local bundle — it cannot cross a call boundary (see the
		// argument ban in check_function_call), cannot be returned
		// (check_return_node), and cannot be assigned to an outer scope
		// (the borrow-depth check). Enum case payloads and tagged unions
		// reject views outright (check_enum_node) — payloads have no borrow
		// tracking.
		if (decl.type.is_ref) {
			add_error(status, `struct fields cannot be 'ref'`, decl.start);
			continue;
		}
		// A func-typed field (e.g. `pub var func (int, out bool) test`) stores
		// an 8-byte code pointer. The parser leaves the type NAME empty and
		// puts the signature on func_params/func_return_type; give it an
		// explicit `func` type so struct layout, field emission, and call
		// resolution (`s.f(args)` — an indirect call through the field) all
		// see a concrete type. A nullable func field (`func? (...) f`) already
		// carries the nullable `func` marker from the parser — keep it so
		// `self.f != null` sees is_nullable. The field is non-mv (nothing
		// to destroy), so byte-copying the struct is sound.
		if (decl.func_params) {
			if (decl.type.name !== "func") {
				decl.type = new Type("func");
			}
			check_declaration_node(decl, status);
			continue;
		}
		// A trait-typed field is a mv handle too, but its FIELD lowering
		// (boxed handle storage + vtable dispatch through the field) is not
		// built yet — reject with the concrete-type fix until it lands (B5
		// remainder; the R shape menu holds fields by concrete type, Box, or
		// WeakHandle).
		const field_is_trait_type =
			!!decl.type.name &&
			!decl.type.is_ref &&
			!!status.traits.find((t) => t.name === decl.type.name);
		if (!struct.is_class && field_is_trait_type) {
			add_error(
				status,
				`a trait-typed field is not supported yet — declare '${decl.name}' with the concrete type, or \`Box<${decl.type.name}>\` once boxed`,
				decl.start,
			);
			continue;
		}
		// STRUCT_PLAN_3 B5 + B1 full cutover — the field restrictions collapse
		// into the Copyable verifier, verified over the CLOSED mv
		// predicate (`type_owns_heap`): a class-typed field (the field slot
		// owns the instance pointer), a `Box<T>` field, a `string` field or
		// string array (D3 — the fat pair owns its bytes), a declared-
		// `mv` struct/enum field, or a field whose type the inferred walk
		// flags (string fields, a resource-releasing `#destroy`, transitively)
		// all own heap state a byte-copy would alias. On a bare `struct` that
		// claim is false — the verifier error names the fix. On an
		// `mv struct` the declaration IS the contract: the field is an
		// mv slot (transfer-on-store), so the field is accepted.
		if (!struct.is_class && type_owns_heap(decl.type, status)) {
			if (!struct.is_owning) {
				add_error(
					status,
					`'${struct.name}' cannot be Copyable — field '${decl.name}' owns heap memory --> mark the struct \`mv struct ${struct.name}\`, or remove the field`,
					decl.start,
				);
			} else {
				check_declaration_node(decl, status);
			}
		} else {
			check_declaration_node(decl, status);
		}
	}
	status.values.length = values_length_before_fields;

	// Resolve generic field types on non-generic structs (e.g. Buffer<T> →
	// Buffer_T or HandleBuffer_T). Generic structs get this rewrite inside
	// monomorphize(); non-generic structs need it here so that downstream
	// build phases (especially the C companion typedef) see the concrete
	// monomorphized name rather than the unresolved generic.
	rewrite_generic_buffer_fields(struct, status);

	// The auto-generated #init's parameter for a non-defaulted field whose
	// type is a mv value struct (List/Map/Buffer/…) must be a `mv`
	// param: the init body byte-copies the param into the field, so a plain
	// by-value pass would leave the field and the caller's variable co-mv
	// the same backing storage (double-free at scope exit). Marking the param
	// moved makes `Struct(mv x)` the required (sound) call form — the build's
	// mv machinery then releases the caller's cleanup obligation — while a
	// fresh constructor arg (`Struct(List<int>())`) transfers implicitly.
	mark_owning_auto_init_params(struct, status);

	// The ownership-spelling rule, field side: an OWNING-typed field (string,
	// class/trait handle, mv struct — slot_requires_mv) must SPELL `mv`. The
	// keyword is the ownership declaration — it pairs with the inverted half
	// of the old lint, which warned the mv form redundant and preferred plain
	// `var`; the flip makes ownership explicit at every owning slot ("implicit
	// with type inference, explicit with memory management"). Classification
	// resolves the MONOMORPHIZED name (the field's default initializer has
	// been checked above, so the mono struct is registered). Type-param fields
	// stay implicit (slot_requires_mv — ownership is unknown until
	// monomorphization), as do borrows, fixed arrays, func-typed and const
	// fields (a const's value is fixed at its fresh initializer — no transfer
	// ever spells).
	for (const field of struct.fields) {
		if (field.declaration === "mv" || field.declaration === "const") continue;
		// A monomorphized clone stands down: the template was validated with
		// its type params in scope, and a substituted `mv T` field whose
		// concrete binding owns nothing keeps the documented no-op
		// degradation (Box<int>'s `mv int __value`). The clone re-check (the
		// mono struct joins root.statements) must not demand mv from fields
		// whose TEMPLATE spelling was implicit.
		if (struct.source_type_args?.length) continue;
		// A `#for`-generated member stands down the same way: the template's
		// spelling governs, and a per-iteration splice
		// (`mv #{field.type.name} stored`) cannot re-spell per concrete
		// field type. The generated TYPE carries spawn_of (its fields don't),
		// so both are checked.
		if (struct.spawn_of !== undefined || field.spawn_of !== undefined) continue;
		if (!slot_requires_mv(field.type, status)) continue;
		// Quick fix: swap the declaration keyword to `mv` — the same
		// keyword-token replace the const lint offers. A `readonly` field
		// parses with keyword_text "var" but no `var` token in the source,
		// so the replace span would corrupt it — bare error there.
		const fix =
			!field.is_readonly && field.keyword_text === "var" && field.keyword_start !== undefined
				? {
						title: `Declare it 'mv ${type_name(field.type)} ${field.name}'`,
						param_start: field.start,
						replace_start: field.keyword_start,
						replace_end: field.keyword_start + field.keyword_text.length,
						replace_text: "mv",
					}
				: undefined;
		add_error(
			status,
			`field '${field.name}' owns memory — declare it 'mv ${type_name(field.type)} ${field.name}' (plain 'var' is for non-owning types)`,
			field.start,
			fix,
		);
	}

	status.types.push(struct.name);
	status.structs.push(struct);

	// A `$`-generated type binds `Self` in its member bodies to its own
	// (now-registered) name before the walk checks them (stage 6).
	bind_comptime_self(struct, status);

	// A nested-array FIELD is legal: the field holds the heap outer-buffer
	// pointer (its slots are row pointers), owned by the struct — transfers
	// in via `mv`, and the destroy walks reclaim the rows recursively.
	for (const field of struct.fields) {
		if (field.type.is_array && field.type.elem && !field.type.is_array_heap) {
			field.type.is_array_heap = true;
		}
	}

	for (let func of struct.functions) {
		func.scope = struct;
		// A generic struct's custom #init is a template: its variadic tuple
		// params reference type params (e.g. `...[TK, TV]`) that can't be
		// materialized until monomorphization. Skip checking it here — the
		// cloned init is checked inside monomorphize() once the concrete type
		// args are known.
		if (struct.is_generic && func.name === "#init" && func.has_body) {
			func.checked = true;
			continue;
		}
		check_function_node(func, status);
	}

	// A custom #init that skips a non-defaulted field leaves it as raw
	// malloc/stack garbage for the instance's whole life (the scope-exit
	// destroy then frees garbage pointers). Generic structs are checked in
	// monomorphize() instead, against the cloned inits and substituted fields.
	if (!struct.is_generic) {
		check_init_assigns_all_fields(
			struct,
			struct.functions.filter((f) => f.name === "#init" && f.has_body),
			status,
		);
	}

	status.type_params.length = type_params_length_before;
	status.types.length = types_length_before;
	status.types.push(struct.name);
}

/**
 * Mark the auto-generated (bodyless) `#init`'s parameters as `mv` for every
 * non-defaulted field whose type is a mv value struct (e.g.
 * `var List<int> items`). The synthesized init byte-copies each param into its
 * field, so ownership must transfer with the call — a plain by-value argument
 * would leave the caller's variable and the field co-mv the backing heap
 * storage (a double-free at scope exit, mirroring the `var List b = a`
 * declaration rejection). Runs for both `var` and `mv`-declared fields: a
 * defaulted mv field never takes a param (its default constructs fresh),
 * and a non-defaulted one always needs the transfer. Generic structs are
 * skipped — their init params are rebuilt per-monormorphization in
 * `monomorphize()` with the same rule applied to the substituted field type.
 * Shared between check_struct_node (statement order) and the upfront
 * resolve_struct_field_types pass so the marker is set before any call site
 * is checked, regardless of declaration order.
 */
function mark_owning_auto_init_params(struct: StructNode, status: CheckStatus) {
	if (struct.is_generic) return;
	const auto_init = struct.functions.find((f) => f.name === "#init" && !f.has_body);
	if (!auto_init) return;
	for (const param of auto_init.params) {
		const field = struct.fields.find((f) => f.name === param.name);
		if (!field || field.value) continue;
		if (param.is_moved) continue;
		if (field.type.is_ref || field.type.is_view) continue;
		if (!field.type.name) continue;
		// STRUCT_PLAN_3 B5 — a mv struct's class-typed field is an
		// OWNED slot (ownership follows the field's type): construction
		// transfers, so the synthesized param must be `mv`. A plain
		// by-value pass would alias the caller's instance — the call temp is
		// destroyed at the caller's scope exit while the field keeps the
		// pointer (use-after-free). `Box<T>` fields are mv too (the box
		// owns its pointee) — a bare box donor would alias the caller's box
		// (double-destroy at teardown). Nullable fields take the transfer as
		// well (`null` aliases nothing; a fresh instance must not alias).
		if (struct.is_owning) {
			if (is_class_type(field.type.name, status)) {
				param.is_moved = true;
				continue;
			}
		}
		// A nullable OWNING field takes the transfer too (`null` aliases
		// nothing; a fresh instance must not alias) — this check must precede
		// the nullable skip below, which exists for nullable NON-mv
		// fields (a plain struct copy param). Without it, the construction
		// argument temp stayed caller-owned: the temp's scope-exit destroy
		// AND the field's flag-guarded destroy both ran (the aarch64
		// nullable-field double-fire).
		if (is_owning_struct_type_requiring_move(field.type, status)) {
			param.is_moved = true;
			continue;
		}
		if (field.type.is_nullable) continue;
	}
}

/**
 * Rewrite `Buffer<Elem>` field types on a non-generic struct to their
 * monomorphized name (Buffer_Elem / HandleBuffer_Elem), including the field's
 * default constructor call. Generic structs get this rewrite inside
 * monomorphize() instead. Shared between check_struct_node (statement-order)
 * and the upfront resolve_struct_field_types pass so the rewrite runs exactly
 * once regardless of which fires first.
 */
function rewrite_generic_buffer_fields(struct: StructNode, status: CheckStatus) {
	if (struct.is_generic) return;
	for (const field of struct.fields) {
		if (field.type.name !== "Buffer" || !field.type.type_args?.length) continue;
		const elem = field.type.type_args[0];
		if (!elem?.name) continue;
		const elem_is_class = !!status.structs.find((s) => s.name === elem.name && s.is_class);
		const elem_is_trait = !!status.traits.find((t) => t.name === elem.name);
		const generic = status.structs.find(
			(s) => s.name === (elem_is_class || elem_is_trait ? "HandleBuffer" : "Buffer"),
		);
		if (!generic) continue;
		const buf_mono = monomorphize(generic, [elem], status);
		if (!buf_mono) continue;
		field.type.name = buf_mono.name;
		field.type.type_args = undefined;
		if (field.value?.node_type === "func_call") {
			const dv = field.value as FunctionCallNode;
			dv.name = buf_mono.name;
			dv.type_args = undefined;
		}
	}
}

/**
 * Infer the type of a struct-field initializer whose annotation was elided
 * (e.g. `var digits = Buffer<int>()`). Constructor calls resolve to the named
 * struct (plus any type args); literals resolve via type_from_value. Returns
 * null for initializers that can't be typed structurally (free-function calls,
 * complex expressions) — those fall back to the lazy inference inside
 * check_struct_node.
 */
function infer_field_type_from_value(
	value: import("../nodes/BaseNode.ts").default,
	status: CheckStatus,
): Type | null {
	if (value.node_type === "func_call") {
		const call = value as FunctionCallNode;
		// Only infer when the call names a registered struct (a constructor);
		// a free-function initializer can't be typed without checking it.
		if (status.structs.find((s) => s.name === call.name)) {
			const t = new Type(call.name);
			if (call.type_args?.length) t.type_args = call.type_args;
			return t;
		}
		return null;
	}
	if (value.node_type === "value") {
		return type_from_value((value as ValueNode).value, status);
	}
	return null;
}

/**
 * Eagerly resolve inferred struct field types (e.g. `var buf = Buffer<int>()`)
 * before any function bodies are checked.
 *
 * Field type inference normally happens lazily inside check_struct_node, which
 * runs in statement order. The System library source is appended after user
 * code, so user functions are checked BEFORE library structs — a field whose
 * type is inferred from its initializer (no explicit annotation) would still
 * have an empty type when user code accesses it, surfacing as "Unknown target".
 * Resolving inferred field types upfront (right after gather_structs registers
 * every struct) makes them visible regardless of declaration order.
 *
 * Only the field-type inference runs for generic structs too: a generic
 * field's initializer names the constructed type in terms of the struct's own
 * type params (`var items = Buffer<T>()` → `Buffer<T>`), which is exactly the
 * annotation it replaces, so recording it upfront is safe and keeps it visible
 * to the ownership classifier and to monomorphization. The buffer rewrite and
 * mv-param marking stay non-generic, mirroring check_struct_node. The
 * inference is structural to avoid re-running the full declaration check and
 * its side effects; check_struct_node later skips already-resolved fields, so
 * each field is resolved exactly once.
 */
export function resolve_struct_field_types(status: CheckStatus) {
	for (const struct of status.structs) {
		for (const field of struct.fields) {
			if (field.type.name) continue;
			if (!field.value) continue;
			const t = infer_field_type_from_value(field.value, status);
			if (t?.name) field.type = t;
		}
		if (struct.is_generic) continue;
		rewrite_generic_buffer_fields(struct, status);
		// Mark auto-init params of mv-struct fields as `mv` upfront for
		// the same reason the type inference above runs here: user functions
		// are checked BEFORE library structs (appended after user source), so
		// a statement-order-only marker would miss call sites checked first.
		mark_owning_auto_init_params(struct, status);
	}
}

/**
 * Enforce trait conformance for a struct. For each declared trait:
 *
 *  - A required (bodyless) trait method must be implemented by the struct.
 *  - Any struct method that overrides a trait method (required or default)
 *    must match the trait's signature — parameter count, parameter types
 *    and return type — after substituting a generic trait's type params
 *    with the struct's conformance type args.
 *
 * A trait method with a default body need not be overridden; if it isn't,
 * the default is inherited (and, for generic traits, already synthesized
 * onto the struct by synthesize_generic_trait_defaults). `#init`,
 * `#destroy` and `#spawn` are lifecycle hooks, not contract methods, so
 * they're skipped.
 */
function check_trait_conformance(struct: StructNode, status: CheckStatus) {
	for (let i = 0; i < struct.traits.length; i++) {
		const trait = status.traits.find((t) => t.name === struct.traits[i]);
		if (!trait) continue;

		const args = struct.trait_args[i];
		// A generic trait whose conformance arity is wrong already produced
		// an error above; skip it here to avoid a cascade of spurious
		// signature mismatches from the unresolved type params.
		if (trait.type_params.length > 0 && (!args || args.length !== trait.type_params.length)) {
			continue;
		}
		const substitution = new Map<string, string>();
		if (args && trait.type_params.length === args.length) {
			for (let j = 0; j < trait.type_params.length; j++) {
				substitution.set(trait.type_params[j], args[j].name);
			}
		} else if (trait.type_params.length === 0) {
			// A non-generic trait whose defaults bind `Self` (the derive
			// traits) signs its methods with `Self` — a bound default clone
			// (or a hand-written override) spells the conformer instead, so
			// signature comparison substitutes Self -> the struct's name.
			substitution.set("#self", struct.name);
		}

		for (const trait_func of trait.functions) {
			if (
				trait_func.name === "#init" ||
				trait_func.name === "#destroy" ||
				trait_func.name === "#spawn"
			)
				continue;

			const overrides = struct.functions.filter((f) => f.name === trait_func.name);

			if (overrides.length === 0) {
				if (!trait_func.has_body) {
					add_error(
						status,
						`Type '${struct.name}' does not conform to trait '${trait.name}': missing required method '${trait_func.name}'`,
						struct.start,
					);
				}
				continue;
			}

			// An override exists — at least one overload must satisfy the
			// trait signature. The declared field sets (FIELD_EFFECTS.md)
			// are checked on the matching overload: the trait's declaration
			// is the contract callers read, so the conformer may narrow it
			// (a subset) but never widen it.
			const matching = overrides.find((ov) => signature_matches(ov, trait_func, substitution));
			if (!matching) {
				add_error(
					status,
					`Type '${struct.name}' does not conform to trait '${trait.name}': method '${trait_func.name}' does not match the trait signature`,
					overrides[0].start,
				);
				continue;
			}
			for (let k = 0; k < trait_func.params.length; k++) {
				const trait_set = trait_func.params[k].field_set;
				if (trait_set === undefined) continue;
				const param = matching.params[k];
				const override_set = param?.field_set;
				if (override_set === undefined) {
					add_error(
						status,
						`'${matching.name}' overrides a trait method whose '${trait_func.params[k].name ?? "parameter"}' declares ${display_field_set(trait_set)} — the override must declare a subset (add '${trait_set.length ? `{ ${trait_set.join(", ")} }` : "{}"}' to the parameter)`,
						param?.start ?? overrides[0].start,
					);
					continue;
				}
				const outside = override_set.filter((f) => !trait_set.includes(f));
				if (!outside.length) continue;
				add_error(
					status,
					`'${matching.name}' widens the trait's field set: '${trait_func.params[k].name ?? "parameter"}' declares ${display_field_set(trait_set)} on the trait, the override also names ${outside.map((f) => `'${f}'`).join(", ")}`,
					param?.start ?? overrides[0].start,
				);
			}
		}
	}
}

/**
 * Compare a struct method against a trait method signature, ignoring `self`
 * (which is trait-typed on the trait and struct-typed on the conformer).
 * The trait method's types are substituted with `substitution` first, so a
 * generic trait like `trait Box<T> { func get = (self, out T) }` is compared
 * against `func get = (self, out int)` once T→int is applied.
 */
function signature_matches(
	struct_func: FunctionNode,
	trait_func: FunctionNode,
	substitution: Map<string, string>,
): boolean {
	const trait_params = trait_func.params.filter((p) => !p.is_self_param);
	const struct_params = struct_func.params.filter((p) => !p.is_self_param);
	if (trait_params.length !== struct_params.length) return false;
	for (let k = 0; k < trait_params.length; k++) {
		const expected = substitute_type(trait_params[k].type, substitution);
		if (!types_match(expected, struct_params[k].type)) return false;
	}
	return types_match(
		substitute_type(trait_func.return_type, substitution),
		struct_func.return_type,
	);
}

function types_match(a: Type, b: Type): boolean {
	return (
		a.name === b.name &&
		!!a.is_ref === !!b.is_ref &&
		!!a.is_view === !!b.is_view &&
		!!a.is_array === !!b.is_array
	);
}

/**
 * B2 — walk `struct`'s inline value-struct fields (Box fields are pointers
 * and stop the walk; class/trait fields are rejected elsewhere) for a path
 * back to `struct`. Reports the FIRST closing field.
 */
function detect_inline_containment_cycle(struct: StructNode, status: CheckStatus): void {
	const path: string[] = [struct.name];
	const walk = (current: StructNode): boolean => {
		for (const field of current.fields) {
			if (!field.type.name || field.type.is_ref || field.type.is_array) continue;
			if (is_box_type(field.type.name, status.structs)) continue;
			const next = status.structs.find(
				(st) => st.name === field.type.name && !st.is_class && !st.is_simple_type,
			);
			if (!next) continue;
			if (next.name === struct.name) {
				add_error(
					status,
					`field '${path[path.length - 1]}.${field.name}' closes an inline containment cycle — declare it \`Box<${struct.name}>\``,
					field.start || struct.start,
				);
				return true;
			}
			if (path.includes(next.name)) continue; // a different cycle — reported at its own struct
			path.push(next.name);
			if (walk(next)) return true;
			path.pop();
		}
		return false;
	};
	walk(struct);
}
