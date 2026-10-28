import add_error from "../add_error.ts";
import { value_use_count } from "../build_common/in_place_push.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { find_use_c_mixed_body } from "../raw_directives.ts";
import check_block_node from "./check_block_node.ts";
import { instantiate_generic_type } from "./check_function_call_node.ts";
import check_function_parameter_node from "./check_function_parameter_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_exists from "./utils/check_type_exists.ts";
import clone_status from "./utils/clone_status.ts";
import { extract_length_equalities_at_registration } from "./utils/flow_bounds.ts";
import materialize_type from "./utils/materialize_type.ts";
import { struct_has_view_fields } from "./utils/view_fields.ts";

/** Param/return types an `foreign func` may marshal in this first cut. */
function foreign_supported_type(type: Type): boolean {
	if (type.is_ref || type.is_view || type.is_array) return false;
	if (!type.name) return false;
	const scalars = [
		"bool",
		"char",
		"int",
		"int8",
		"int16",
		"int32",
		"int64",
		"uint",
		"uint8",
		"uint16",
		"uint32",
		"uint64",
		"float",
		"float32",
		"float64",
		"ufloat",
		"ufloat32",
		"ufloat64",
	];
	return scalars.includes(type.name) || type.name === "string";
}

function is_generic_func(func: FunctionNode): boolean {
	return func.type_params.length > 0;
}

export default function check_function_node(func: FunctionNode, status: CheckStatus) {
	if (func.checked) return;
	func.checked = true;

	status.functions.push(func);
	// Register the emission name so later nested-label uniquification (see
	// assign_function_label) can't collide with this function. Covers the
	// flows that never pass a block gather: monomorphized clones registered
	// straight from check_function_call_node.
	if (status.function_emission_names) {
		status.function_emission_names.add(func.label_name ?? func.name);
	}

	// Strip parallel-length equality clauses (`a.length == b.length`) from
	// every parameter's constraint AT REGISTRATION — before any call site can
	// observe the signature. A forward-referenced callee must not hand its
	// caller a clause no call site could ever prove; the clause becomes an
	// assumed equality for the callee's own body instead (stashed on the
	// param, seeded into scope when its params are checked).
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

	if (func.is_foreign) {
		// Library-only: externs are the System library's FFI surface, not a
		// user escape hatch (same trust line as core-only constraint checks).
		if (!func.is_library) {
			add_error(
				status,
				`'foreign' functions can only be declared in the System library`,
				func.start,
			);
		}
		if (func.type_params.length > 0) {
			add_error(status, `foreign functions cannot be generic`, func.start);
		}
		for (const param of func.params) {
			if (param.is_variadic) {
				add_error(status, `foreign variadic parameters are not supported yet`, param.start);
				continue;
			}
			if (!foreign_supported_type(param.type)) {
				add_error(
					status,
					`foreign parameter '${param.name}' has an unsupported type '${param.type.name}' (scalars and string only)`,
					param.start,
				);
			}
		}
		if (func.return_type.name && !foreign_supported_type(func.return_type)) {
			add_error(
				status,
				`foreign return type '${func.return_type.name}' is unsupported (scalars and string only)`,
				func.return_type_start ?? func.start,
			);
		}
	}

	// A body mixing `#arch: aarch64_use_c` blocks with regular statements is
	// a backend divergence, not a style question: the aarch64 backend routes
	// the whole function to the C companion (the concatenation of the raw
	// blocks) and would silently drop the rest, while the C backend compiles
	// it normally (the Spinner flag bug). Rejected here so the gap is never
	// silent — before the generic early-return, so clones re-report it too.
	const mixed_body = find_use_c_mixed_body(func);
	if (mixed_body) {
		add_error(
			status,
			mixed_body.dropped === "statement"
				? `Function '${func.name}' mixes '#arch: aarch64_use_c' blocks with Nomen statements — the aarch64 backend replaces the whole body with the raw blocks and would drop the statements`
				: mixed_body.dropped === "raw asm"
					? `Function '${func.name}' mixes '#arch: aarch64_use_c' blocks with inline raw code — the aarch64 backend replaces the whole body with the raw blocks and would drop the assembly`
					: `Function '${func.name}' has a '#arch: aarch64_use_c' block nested inside control flow — the aarch64 backend emits the body as assembly and silently drops block-scope C; move the block into its own aarch64_use_c function and pass values as parameters`,
			mixed_body.start,
		);
	}

	if (is_generic_func(func)) {
		func.is_generic = true;
		return;
	}

	let function_status = clone_status(status);
	// A nested function (or lambda) begins a fresh statement scope: the
	// allocations hoisted in the ENCLOSING expression must not be absorbed
	// into the nested body — nor cleared from the enclosing statement's
	// pending list. `clone_status` deliberately SHARES the array for block
	// clones (if/while bodies stay in the same function), so entering a
	// function must reset it. Without this, a lambda argument in a
	// non-first interpolation slot swallowed the preceding argument's
	// hoisted `_param_N` declaration into its own body while the outer
	// statement kept only the reference (aarch64 emitted `adr xN, _param_N`
	// and clang rejected it).
	function_status.allocations = [];
	// Unsafe context: an `unsafe func` body is one big unsafe region —
	// `ptr T` values, `p[i]` indexing and pointer casts are legal in it.
	function_status.in_unsafe = !!func.is_unsafe;
	// Everything inherited from the enclosing scope (now cloned into our
	// `values`) is a capture target: a closure lambda may capture it (recorded
	// by check_value_node), while a plain nested function still may not
	// reference any of those names. Record the boundary so check_value_node can
	// tell the two apart. For a top-level function the enclosing `values` is
	// empty, so the base is 0.
	function_status.function_value_base = function_status.values.length;
	// Only a closure lambda can capture (CLOSURE.md Phase 2); a
	// plain nested function or a non-lambda function clears the hook so outer
	// references keep erroring.
	function_status.enclosing_closure = func.is_closure ? func : undefined;
	if (func.is_closure && !func.captures) func.captures = [];
	// Parallel-length equations are scoped to the function whose params
	// declared them; a nested function's params may shadow the outer names,
	// so it starts with a clean slate.
	function_status.equal_lengths = [];
	const structs_before = function_status.structs.length;
	const enums_before = function_status.enums.length;
	const types_before = function_status.types.length;

	for (let param of func.params) {
		check_function_parameter_node(param, function_status, !!func.is_library);
	}

	if (func.return_type.name) {
		if (!check_type_exists(func.return_type, function_status, func.return_type_start!)) {
			func.return_type = new Type("?");
		} else {
			func.return_type = materialize_type(func.return_type, function_status);
			// Lockdown: `ptr T` returns are System-library-only. Note the
			// library check runs with `in_unsafe` set for unsafe funcs, but a
			// plain `func` returning a pointer must ALSO be allowed (the
			// library's own convention is func + unsafe block), so gate on
			// is_library rather than in_unsafe here.
			if (func.return_type.is_pointer && !func.is_library) {
				add_error(
					function_status,
					`'ptr' return types are reserved for the System library — raw pointer manipulation is not available to user code`,
					func.return_type_start ?? func.start,
				);
			}
		}
		// A generic container used only as a return type (e.g.
		// `out List<string>` with no construction of that exact type) would
		// never be monomorphized, leaving the signature referencing a bare
		// incomplete struct. Materialize it here.
		instantiate_generic_type(func.return_type, function_status);
		// Views are second-class across calls (SPEC Slicing): no function or
		// method may DECLARE a return type that carries `view` fields. The
		// caller's binding cannot be pinned to the bundle's sources across
		// the boundary, so no body could return one soundly — reject the
		// signature itself, not just each return statement (a `todo`-only
		// body has none to reject). `#init` is exempt: it constructs the
		// bundle. `view T` returns stay allowed — a plain view re-roots at
		// the call-site receiver.
		if (
			func.name !== "#init" &&
			!func.return_type.is_view &&
			!func.return_type.is_ref &&
			struct_has_view_fields(func.return_type.name, function_status)
		) {
			add_error(
				function_status,
				`cannot return a '${func.return_type.name}' — structs with 'view' fields are scope-local; return the fields (the views) instead`,
				func.return_type_start ?? func.start,
			);
			(func as { view_bundle_return_rejected?: boolean }).view_bundle_return_rejected = true;
		}
	}

	// An foreign has no body to check: the backends synthesize the
	// marshalling adapter from the signature alone.
	if (func.is_foreign) return;

	check_block_node(func, function_status);

	// Move-captures transfer ownership of the donating local into the
	// lambda's env (CLOSURE.md Phase 2c part 2): invalidate it in
	// the ENCLOSING scope so a later direct use is a use-after-mv. The
	// capture references inside the lambda body see the donor below
	// `function_value_base`, so they are never flagged. `status` here is the
	// enclosing status (this function was entered from it).
	if (func.is_closure && func.captures?.length) {
		for (const cap of func.captures) {
			if (!cap.is_move) continue;
			if (!status.moved_variables) status.moved_variables = new Set();
			status.moved_variables.add(cap.name);
		}
	}

	// Bubble up any tuple structs (and their types) materialized while
	// checking this function's body so callers can resolve field accesses
	// on returned tuples. Enums materialized here (anonymous enums, generic
	// enum monomorphizations) bubble the same way so sibling statements see
	// them in status.enums.
	for (let i = structs_before; i < function_status.structs.length; i++) {
		const s = function_status.structs[i];
		if (!status.structs.includes(s)) {
			status.structs.push(s);
		}
	}
	for (let i = enums_before; i < function_status.enums.length; i++) {
		const e = function_status.enums[i];
		if (!status.enums.includes(e)) {
			status.enums.push(e);
		}
	}
	for (let i = types_before; i < function_status.types.length; i++) {
		const t = function_status.types[i];
		if (!status.types.includes(t)) {
			status.types.push(t);
		}
	}

	// Return-side NRVO: when EVERY direct return of a
	// value-struct-returning function is a bare `return <name>`, and <name>
	// is a single local whose only reads are those returns, the binding
	// constructs directly in the caller's sret buffer (aarch64) / the
	// function's `_return_val` (C) and the returns copy nothing. The count
	// discipline is forward.ts's: name-based, shadowing-conservative, over
	// the whole function including nested bodies.
	const ret_type = func.return_type;
	if (
		!func.is_closure &&
		ret_type?.name &&
		!ret_type.is_view &&
		!ret_type.is_array &&
		!ret_type.is_ref &&
		!ret_type.is_nullable
	) {
		const ret_struct = function_status.structs.find(
			(s) => s.name === ret_type.name && !s.is_simple_type && !s.is_class,
		);
		if (ret_struct) {
			const returns: ReturnNode[] = [];
			const seen_nodes = new Set<BaseNode>();
			const collect_returns = (n: BaseNode): void => {
				if (!n || typeof n !== "object" || seen_nodes.has(n)) return;
				seen_nodes.add(n);
				if (n !== func && n.node_type === "func") return;
				if (n.node_type === "return") returns.push(n as ReturnNode);
				for (const key of Object.keys(n)) {
					if (key === "parent" || key === "scope") continue;
					const child = (n as unknown as Record<string, unknown>)[key];
					const children = Array.isArray(child) ? child : [child];
					for (const item of children) {
						if (item && typeof item === "object" && "node_type" in item) {
							collect_returns(item as BaseNode);
						}
					}
				}
			};
			for (const st of func.statements) collect_returns(st);

			if (
				returns.length > 0 &&
				returns.every(
					(r) =>
						!r.nrvo_elided &&
						r.value?.node_type === "value" &&
						typeof (r.value as ValueNode).value === "string",
				)
			) {
				const name = (returns[0].value as ValueNode).value as string;
				// Exactly one declaration of the name (shadowing would make
				// the stamp ambiguous), a var/const with a call initializer
				// of exactly the return type, and no nested-function capture
				// (a capture outlives the frame whose sret buffer the binding
				// now IS). Other uses are fine: receiver borrows (`items.push`)
				// never read the handle, and any read/copy/reassign inside the
				// function sees the same storage the copy semantics gave it.
				const decls: DeclarationNode[] = [];
				const seen_decls = new Set<BaseNode>();
				const collect_decls = (n: BaseNode): void => {
					if (!n || typeof n !== "object" || seen_decls.has(n)) return;
					seen_decls.add(n);
					if (n !== func && n.node_type === "func") return;
					if (n.node_type === "declare" && (n as DeclarationNode).name === name) {
						decls.push(n as DeclarationNode);
					}
					for (const key of Object.keys(n)) {
						if (key === "parent" || key === "scope") continue;
						const child = (n as unknown as Record<string, unknown>)[key];
						const children = Array.isArray(child) ? child : [child];
						for (const item of children) {
							if (item && typeof item === "object" && "node_type" in item) {
								collect_decls(item as BaseNode);
							}
						}
					}
				};
				for (const st of func.statements) collect_decls(st);
				const decl = decls.length === 1 ? decls[0] : undefined;
				// The binding must be read NOWHERE except the returns them-
				// selves: every read lowers to emit_var_address(name), and the
				// elided binding has no frame slot (the aarch64 address path
				// would fall back to a global `adr` of the name). Receiver
				// borrows count — they address the storage too.
				const uses = value_use_count(name, func);
				if (
					decl &&
					!decl.nrvo_sret &&
					!decl.in_place_push_slot &&
					(decl.declaration === "var" || decl.declaration === "const") &&
					decl.value?.node_type === "func_call" &&
					decl.type?.name === ret_type.name &&
					uses === returns.length
				) {
					decl.nrvo_sret = true;
					for (const r of returns) r.nrvo_elided = true;
				}
			}
		}
	}
}
