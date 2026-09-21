import add_error from "../add_error.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import { borrow_depth_of, borrow_owner_of, invalidate_view_borrows_of } from "./utils/borrow.ts";
import { value_owns_closure } from "./utils/captures.ts";
import check_merged_missing_return from "./utils/check_merged_missing_return.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import evaluate_const_condition from "./utils/evaluate_const_condition.ts";
import {
	snapshot_bounds,
	track_assignment_bounds,
	apply_return_bounds_to_var,
	call_return_bounds,
} from "./utils/flow_bounds.ts";
import {
	is_class_type,
	is_owning_struct_type,
	is_owning_struct_type_requiring_move,
} from "./utils/ownership.ts";
import synthesize_lambda_name from "./utils/synthesize_lambda_name.ts";
import {
	is_trait_type,
	trait_conformer_of_value,
	value_struct_trait_error,
} from "./utils/trait_slot.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";
import {
	ctor_call_view_borrow,
	merge_view_borrows_into_var,
	propagate_view_borrows,
	root_var_of,
	type_can_carry_view_borrow,
	view_fields_invalidated,
	view_source_borrow_info,
} from "./utils/view_fields.ts";

export default function check_assignment_node(
	assign: AssignmentNode,
	status: CheckStatus,
): boolean {
	// For compound assignment (x += 1), the left value is read, so check is_set.
	// For regular assignment (x = 5), the left value is only written.
	const is_compound = !!assign.operator;
	if (!is_compound) {
		status.is_assignment_target = true;
	}
	// Reassigning a whole moved variable (`a = ...`, not `a.field = ...`)
	// revalidates it: drop it from the moved set before the left value is
	// checked, so the read of the target here is not itself flagged. A field
	// assignment (`a.field = ...`) does NOT revalidate `a` and is left to error.
	if (
		!is_compound &&
		assign.left_value.node_type === "value" &&
		status.moved_variables?.has((assign.left_value as ValueNode).value)
	) {
		status.moved_variables.delete((assign.left_value as ValueNode).value);
	}
	if (!check_node(assign.left_value, status)) {
		status.is_assignment_target = false;
		return false;
	}
	status.is_assignment_target = false;

	// If the RHS is a lambda and the LHS is a function-typed variable, infer the
	// lambda's parameter and return types from the declared function signature.
	// A func-typed FIELD target (`r.f = (x) => …`) infers from the field's
	// func_params/func_return_type the same way.
	const lhs_value_name = value_from_value_node(assign.left_value);
	const lhs_value = status.values.findLast((v) => v.name === lhs_value_name);
	let lambda_signature: {
		params?: ParameterNode[] | { name: string; type: Type }[];
		return_type?: Type;
	} = {};
	if (assign.left_value.node_type === "access") {
		const field = (assign.left_value as AccessNode).access;
		if (field.node_type === "access_field") {
			// The field's Type carries only the "func" name — the signature
			// lives on the struct's field declaration.
			const target_type = type_from_value_node((assign.left_value as AccessNode).target, status);
			const struct = status.structs.find((s) => s.name === target_type.name);
			const fd = struct?.fields.find((f) => f.name === (field as AccessFieldNode).name);
			lambda_signature = { params: fd?.func_params, return_type: fd?.func_return_type };
		}
	} else if (lhs_value?.func_params?.length) {
		lambda_signature = { params: lhs_value.func_params, return_type: lhs_value.func_return_type };
	}
	if (
		assign.right_value.node_type === "func" &&
		lambda_signature.params &&
		lambda_signature.params.length
	) {
		const rhs_func = assign.right_value as FunctionNode;
		if (assign.left_value.node_type === "value") {
			// A bare variable target names the lambda after the variable —
			// uses of the variable then resolve to the emitted function.
			rhs_func.name = lhs_value_name;
		} else if (!rhs_func.name) {
			// A field target must not name the lambda after the root
			// variable; give it a unique emission name.
			synthesize_lambda_name(rhs_func, status);
		}
		if (rhs_func.params.length === lambda_signature.params.length) {
			for (let i = 0; i < rhs_func.params.length; i++) {
				if (!rhs_func.params[i].type.name && lambda_signature.params[i].type.name) {
					rhs_func.params[i].type = lambda_signature.params[i].type;
				}
			}
		}
		if (lambda_signature.return_type && !rhs_func.return_type.name) {
			rhs_func.return_type = lambda_signature.return_type;
			check_merged_missing_return(rhs_func, status);
		}
	}

	const old_expected_type = status.expected_type;
	status.expected_type = type_from_value_node(assign.left_value, status);
	const result = check_node(assign.right_value, status);
	status.expected_type = old_expected_type;
	if (!result) {
		return false;
	}

	// Make sure the left value exists and can be assigned to
	// * If this is a variable, it's the variable itself e.g. for `x = 5` we would
	//   check that `x` exists and can be assigned to
	// * If this is an access, it's the root target e.g. for `person.address.zip =
	//   1234` we would check that `person` exists and can be assigned to
	const left_value_name = value_from_value_node(assign.left_value);
	// Innermost (last-pushed) declaration wins: core library bodies are checked
	// through clones of the ambient status, so their locals share the values
	// array with caller/global values of the same name. First-match resolution
	// would let an outer same-named const shadow the function's own local
	// here ("Assignment to const" for code the user never wrote). This mirrors
	// the read path, which resolves through findLast everywhere.
	const left_value = status.values.findLast((v) => v.name === left_value_name);
	if (!left_value) {
		add_error(status, `Unknown variable: ${left_value_name}`, assign.left_value!.start);
		return false;
	} else if (
		left_value.declaration !== "var" &&
		!left_value.type.is_ref &&
		left_value_name === "self"
	) {
		// A bare `self` (not `var self` / `ref self`) is an immutable borrow;
		// mutating one of its fields must be rejected. Methods that need to
		// write must declare `var self` (owned) or `ref self` (mutable borrow).
		// But `var self` is pretty pointless, so let's just advise `ref self`
		add_error(
			status,
			`Cannot mutate 'self' — it is immutable; declare as 'ref self' to allow mutation`,
			assign.left_value!.start,
		);
	} else if (
		left_value.declaration !== "var" &&
		!left_value.type.is_ref &&
		left_value_name !== "self"
	) {
		if (left_value.is_set) {
			add_error(status, `Assignment to const: ${left_value_name}`, assign.left_value!.start);
			return false;
		} else {
			left_value.is_set = true;
		}
	} else if (
		// Deep-const: a field write through a const_ref (a read-only class
		// reference extracted from a const source, e.g. `const_list.at(0).f = x`)
		// must be rejected — the whole point of extracting from a const
		// collection is that the element is not mutable through the result.
		// Only fires for field writes (AccessNode LHS), not bare rebinding.
		assign.left_value!.node_type === "access" &&
		left_value.type.is_const_ref
	) {
		add_error(
			status,
			`Cannot mutate field of const reference: ${left_value_name}`,
			assign.left_value!.start,
		);
		return false;
	} else if (left_value.declaration === "var") {
		// Two-tier trait rule: a trait-typed local bound to a value-struct
		// conformer (inline concrete storage, sized by that conformer) cannot
		// change shape. Only a value of the SAME conformer may be stored; a
		// different conformer — or anything whose concrete conformer isn't
		// statically known (a call result, a class instance) — is rejected.
		// declare-a-class is the escape hatch for polymorphic slots.
		if (
			!is_compound &&
			left_value.trait_slot_conformer &&
			assign.left_value.node_type === "value"
		) {
			const bound = left_value.trait_slot_conformer;
			const trait_name = left_value.type.name;
			const rhs_conformer =
				trait_name !== undefined
					? trait_conformer_of_value(assign.right_value, trait_name, status)
					: undefined;
			if (rhs_conformer !== bound) {
				const rhs_desc = rhs_conformer
					? `value struct '${rhs_conformer}'`
					: "a value whose conformer is not statically known";
				add_error(
					status,
					`value-struct trait slot '${left_value_name}' is bound to '${bound}' and cannot hold ${rhs_desc}; declare a class`,
					assign.right_value.start,
				);
				return false;
			}
		} else if (
			!is_compound &&
			!left_value.trait_slot_conformer &&
			assign.left_value.node_type === "value" &&
			is_trait_type(left_value.type.name, status) &&
			!left_value.type.is_array &&
			!left_value.type.is_ref
		) {
			// A trait-typed local WITHOUT a value-struct binding holds the
			// pointer representation (a class instance). Storing a
			// value-struct conformer into it would save a pointer to a
			// dying stack temporary — reject.
			const rhs_conformer = trait_conformer_of_value(
				assign.right_value,
				left_value.type.name!,
				status,
			);
			if (rhs_conformer) {
				add_error(
					status,
					value_struct_trait_error(rhs_conformer, left_value.type.name!),
					assign.right_value.start,
				);
				return false;
			}
		}
		left_value.is_set = true;
		// For `i = i + 6` and the equivalent compound form `i += 6`, snapshot
		// the LHS's current bounds BEFORE clearing so track_assignment_bounds
		// can propagate them (e.g. `i >= 0` ⇒ `i >= 6`). Compound `+=`/`-=`
		// behave like `i = i ± N` for bounds purposes.
		const compound_op =
			is_compound && assign.operator ? assign.operator.replace(/=$/, "") : undefined;
		const is_trackable_compound = is_compound && (compound_op === "+" || compound_op === "-");
		const self_snapshot =
			left_value_name === left_value.name &&
			((!is_compound && is_self_shifted(assign.right_value, left_value.name)) ||
				is_trackable_compound)
				? snapshot_bounds(left_value.name, status)
				: undefined;
		// Clear range bounds: assignment invalidates for-loop range knowledge
		left_value.range_lower = undefined;
		left_value.range_upper = undefined;
		// Clear flow-sensitive bounds: assignment invalidates bounds from if/while
		left_value.upper_bound_expr = undefined;
		left_value.lower_bound_expr = undefined;
		left_value.upper_bound_exprs = undefined;
		left_value.lower_bound_exprs = undefined;
		left_value.upper_bound_inclusive_exprs = undefined;
		left_value.lower_bound_inclusive_exprs = undefined;
		left_value.path_bounds = undefined;
		left_value.alias_of = undefined;
		left_value.class_alias_of = undefined;
		// Clear compile-time string/array length: reassignment may change it.
		left_value.type.length = undefined;
		// Reassigning a bare variable reclaims its old value. For a `view`
		// borrow rooted here (a string/array slice into the old buffer), that
		// backing storage is freed at the reassignment, so the view dangles —
		// invalidate view borrows so a later read is rejected. Class
		// child-group borrows are intentionally left valid: deferred
		// reclamation keeps the old instance (and thus the borrow) alive until
		// scope exit, after the borrow's own scope ends. Object-level aliases
		// (class_alias_of) are likewise unaffected.
		if (assign.left_value.node_type === "value") {
			invalidate_view_borrows_of(status, left_value.name);
		}
		// Re-track bounds if the RHS establishes new ones (e.g. cap = buf.get_cap()).
		// Skip for compound assignments (+=, -=, etc.) since the RHS is a delta,
		// not the new value — except `+=`/`-=` with a literal RHS, which we
		// rewrite as `i + N` / `i - N` so the shifted bound propagates (mirroring
		// `i = i + N`).
		let synthetic_rhs: BaseNode | undefined;
		if (is_trackable_compound) {
			synthetic_rhs = new OperationNode(
				assign.right_value.start,
				compound_op as "+" | "-",
				assign.left_value,
				assign.right_value,
				left_value.type,
			);
		}
		if ((!is_compound || synthetic_rhs) && left_value_name === left_value.name) {
			track_assignment_bounds(
				left_value.name,
				synthetic_rhs ?? assign.right_value,
				status,
				self_snapshot,
			);
			// A call RHS carries its return-contract bounds on the call node
			// (check_function_call); transfer them onto the variable so a
			// later `.at(m)` verifies — mirroring the declaration path and
			// the nested-call form.
			if (!is_compound) {
				apply_return_bounds_to_var(left_value.name, call_return_bounds(assign.right_value), status);
			}
		}
		// If the RHS is a string literal, record its length on the type so
		// subsequent constraint checks (e.g. slice bounds) can verify it.
		if (
			!is_compound &&
			left_value.type.name === "string" &&
			assign.right_value.node_type === "value" &&
			(assign.right_value as any).value.startsWith('"') &&
			(assign.right_value as any).value.endsWith('"')
		) {
			const lit = (assign.right_value as any).value;
			const len = lit.length - 2; // strip surrounding quotes
			left_value.type.length = new ValueNode(
				assign.right_value.start,
				len.toString(),
				new Type("int"),
			);
		}
	}

	// Update is_null based on the RHS value
	if (left_value.declaration === "var") {
		const rhs_is_null =
			assign.right_value.node_type === "value" && (assign.right_value as any).value === "null";
		left_value.is_null = rhs_is_null || undefined;
	}

	// Make sure that the types match
	// * If this is a variable, it's the variable itself e.g. for `x = 5` we would
	//   check that the types of `x` and `5` match
	// * If this is an access, it's the field target e.g. for `person.address.zip
	//   = 1234` we would check that the types of `zip` and `1234` match
	//if (left_value)
	// Function-typed reassignment (`f = gt10`, or a lambda `r.f = (x) => …`):
	// the LHS is a func value whose declared signature lives on the StackValue
	// (func_params) or on the struct field; the RHS is either a bare function
	// name whose type_from_value is the opaque `func` marker, or a lambda
	// whose signature was merged in above. Skip the plain name equality check
	// (the signature compatibility is validated here) and only verify the
	// function shape.
	const lhs_func_params = lhs_value?.func_params ?? lambda_signature.params;
	const rhs_is_func_marker = type_from_value_node(assign.right_value, status).name === "func";
	const rhs_is_lambda = assign.right_value.node_type === "func";
	if (lhs_func_params?.length && (rhs_is_func_marker || rhs_is_lambda)) {
		if (rhs_is_lambda) {
			// The lambda's parameter types were inferred from the target's
			// signature above; verify the count matches.
			const rhs_fn = assign.right_value as FunctionNode;
			if (rhs_fn.params.length !== lhs_func_params.length) {
				add_error(
					status,
					`Function signature mismatch: expected ${lhs_func_params.length} parameter(s)`,
					assign.right_value.start,
				);
			}
		} else if (assign.right_value.node_type !== "value") {
			add_error(status, `Expected a function name`, assign.right_value.start);
		} else {
			// Signature compatibility: the RHS function's params (minus the
			// `out` return slot, which type_from_value doesn't count) must
			// match the declared signature in count and type.
			const rhs_fn = status.functions.findLast(
				(f) => f.name === (assign.right_value as ValueNode).value,
			);
			// Stamp the resolution: the build materializes the closure
			// descriptor at this value site (CLOSURE.md).
			if (rhs_fn) {
				(assign.right_value as unknown as { resolved_function?: FunctionNode }).resolved_function =
					rhs_fn;
			}
			const rhs_params = (rhs_fn?.params ?? []).filter((p) => !p.is_self_param);
			if (rhs_params.length !== lhs_func_params.length) {
				add_error(
					status,
					`Function signature mismatch: expected ${lhs_func_params.length} parameter(s)`,
					assign.right_value.start,
				);
			} else {
				for (let i = 0; i < lhs_func_params.length; i++) {
					if (lhs_func_params[i].type.name !== rhs_params[i].type.name) {
						add_error(
							status,
							`Function signature mismatch: parameter ${i + 1} is ${rhs_params[i].type.name}, expected ${lhs_func_params[i].type.name}`,
							assign.right_value.start,
						);
					}
				}
			}
		}
	} else
		check_type_and_value_match(
			type_from_value_node(assign.left_value, status),
			type_from_value_node(assign.right_value, status),
			value_from_value_node(assign.right_value),
			status,
			assign.right_value.start,
			"assignment",
		);

	// A view-typed field store (`line.text = doc.slice(0, 5)`): the instance
	// now carries a non-owning borrow rooted at the RHS's owner. Record it on
	// the ROOT variable of the access chain so escape checks (return /
	// outer-scope assignment) and source-mutation invalidation see the whole
	// instance's dependencies. Also rejects reading a view field whose source
	// was mutated — a fresh store here re-points (and un-stales) the field.
	if (
		assign.left_value.node_type === "access" &&
		(assign.left_value as AccessNode).access.node_type === "access_field"
	) {
		const lhs_access = assign.left_value as AccessNode;
		const lhs_field = lhs_access.access as AccessFieldNode;
		if (lhs_field.type?.is_view) {
			const root = root_var_of(lhs_access.target);
			const rhs = assign.right_value;
			let infos: Map<string, import("./utils/view_fields.ts").BorrowInfo> | undefined;
			if (rhs.node_type === "func_call") {
				infos = ctor_call_view_borrow(rhs as FunctionCallNode, status);
				if (infos?.size) merge_view_borrows_into_var(root, infos, status);
			}
			const info = view_source_borrow_info(rhs, status);
			if (info) {
				merge_view_borrows_into_var(root, new Map([[info.owner ?? "", info]]), status);
			} else if (!infos?.size && root && view_fields_invalidated(root, status)) {
				// Re-pointing from an unconditional source (a literal / const)
				// also refreshes the instance.
				status.invalidated_view_structs?.delete(root);
			}
		}
	}

	// Reject reading a view field whose source was mutated is handled in
	// check_access_node; the LHS read above is exempt as an assignment target.

	// Reject byte-copying a struct that transitively owns heap resources from
	// another variable — both variables would free the same backing data
	// (double-free). Use `move` (`b = move a`) to transfer ownership or `.copy()`
	// for a deep copy. A `swap` assignment transfers ownership (the source is
	// replaced), so it is allowed; fresh allocations (constructors / function
	// returns) arrive as non-value nodes and are moves, not copies. This mirrors
	// the declaration-side check so the two copy sites are consistent.
	if (
		!is_compound &&
		!assign.swap &&
		assign.right_value.node_type === "value" &&
		!assign.right_value.is_moved
	) {
		const rhs_type = type_from_value_node(assign.right_value, status);
		if (rhs_type.name && is_owning_struct_type(rhs_type, status)) {
			add_error(
				status,
				`cannot copy '${rhs_type.name}' by value — it owns heap resources; use .copy() or move`,
				assign.right_value.start,
			);
		}
	}

	// `b = move a` (no swap) transfers ownership: the source `a` is moved and may
	// not be used again until it is reassigned. (A swap revalidates the source,
	// so it is not marked; func-call `move` params are marked in check_function_call.)
	if (assign.right_value.node_type === "value" && assign.right_value.is_moved && !assign.swap) {
		if (!status.moved_variables) status.moved_variables = new Set();
		status.moved_variables.add((assign.right_value as ValueNode).value);
	}

	// A capturing closure is MOVE-ONLY (CLOSURE.md Phase 2c): assigning it
	// (to a local or a func-typed field) transfers the heap descriptor, so the
	// source local is invalidated. Mark the RHS as moved so the backends don't
	// also free the donor.
	if (assign.right_value.node_type === "value") {
		const rhs_sv = status.values.findLast(
			(v) => v.name === (assign.right_value as ValueNode).value,
		);
		if (rhs_sv?.owns_closure) {
			assign.right_value.is_moved = true;
			if (!status.moved_variables) status.moved_variables = new Set();
			status.moved_variables.add((assign.right_value as ValueNode).value);
		}
	}

	// Check field constraints on assignment (e.g. foo.x = value where x has a constraint)
	if (assign.left_value.node_type === "access") {
		const access = assign.left_value as AccessNode;
		if (access.access.node_type === "access_field") {
			const field_access = access.access as AccessFieldNode;
			const target_type = type_from_value_node(access.target, status);
			const struct = status.structs.findLast((s) => s.name === target_type.name);
			const field = struct?.fields.find((f) => f.name === field_access.name);
			// Write access for `const` / `readonly` fields:
			//  - `const`: immutable to Nomen code (a raw `#arch` body may still
			//    initialize one, as Array.length does), so every AST assignment
			//    is an error. A `view` field is normalized to `declaration:
			//    "const"` but stays re-pointable, so it is exempt.
			//  - `readonly`: assignable only from within the declaring
			//    struct/class's own methods — its body, `extend`s, and
			//    monomorphized clones (`func.scope` names the owner).
			const is_const_field = field?.declaration === "const" && !field.is_view_keyword;
			if (field && (is_const_field || field.is_readonly)) {
				const enclosing_func = status.stack.findLast((n) => n.node_type === "func") as
					| FunctionNode
					| undefined;
				const owner = enclosing_func?.scope as { node_type?: string; name?: string } | undefined;
				const inside_declaring_type =
					!!owner && owner.node_type === "struct" && owner.name === struct?.name;
				if (is_const_field) {
					add_error(
						status,
						`Cannot assign to const field: ${field_access.name}`,
						field_access.start,
					);
					return false;
				}
				if (!inside_declaring_type) {
					add_error(
						status,
						`Cannot assign to readonly field '${field_access.name}' from outside ${struct?.name ?? "its declaring type"}`,
						field_access.start,
					);
					return false;
				}
			}
			// Owning (`move`) class fields take ownership of their instance.
			// Storing a BORROWED reference (a non-`move` parameter, a field /
			// container borrow, or an object alias) would let the field's
			// destroy free an instance its real owner frees too — double free
			// on both backends. Owner-carrying values stay legal and are the
			// established idiom: a fresh constructor/call (non-value RHS), an
			// explicit `move`, a `move` parameter, or an owned local
			// (`var TreeNode l = create_tree(...); node.left = l` — the
			// backends implicitly move the local into the field).
			const field_is_owning_class =
				field?.declaration === "move" &&
				!!field.type.name &&
				!field.type.is_array &&
				is_class_type(field.type.name, status);
			if (
				field_is_owning_class &&
				assign.right_value.node_type === "value" &&
				!assign.right_value.is_moved
			) {
				const src_name = (assign.right_value as ValueNode).value;
				const src_sv = /^[A-Za-z_][A-Za-z0-9_]*$/.test(src_name)
					? status.values.findLast((v) => v.name === src_name)
					: undefined;
				if (src_sv) {
					// A parameter is a borrow unless declared `move`; resolve it
					// off the enclosing FunctionNode (a `move T p` parses with
					// declaration "var" + ParameterNode.is_moved). Locals carry
					// their borrow/alias status on the scope value.
					const enclosing_func = status.stack.findLast((n) => n.node_type === "func") as
						| FunctionNode
						| undefined;
					const src_param = enclosing_func?.params.find((p) => p.name === src_name);
					const src_is_borrow =
						(src_param !== undefined && !src_param.is_moved) ||
						!!src_sv.borrowed_from ||
						!!src_sv.class_alias_of;
					if (src_is_borrow) {
						add_error(
							status,
							`cannot store '${src_name}' into owning field '${field_access.name}' — the field takes ownership of a borrowed value; take a fresh instance, declare the parameter 'move', or pass it with 'move'`,
							assign.right_value.start,
						);
					}
				}
			}
			if (field?.type?.name === "func") {
				const target_struct_node = status.structs.findLast((s) => s.name === target_type.name);
				if (
					target_struct_node &&
					!target_struct_node.is_class &&
					value_owns_closure(assign.right_value, status)
				) {
					add_error(
						status,
						`cannot store a capturing closure in func field '${field_access.name}' of value struct '${target_type.name}' — value structs are copyable and would share the descriptor; use a class instead`,
						assign.right_value.start,
					);
					return false;
				}
			}
			if (field?.constraint) {
				let arg_value: number | boolean | undefined;
				if (assign.right_value.node_type === "value") {
					const vn = assign.right_value as ValueNode;
					if (/^[+-]?\d+$/.test(vn.value)) arg_value = parseInt(vn.value, 10);
					if (vn.value === "true") arg_value = true;
					if (vn.value === "false") arg_value = false;
				}
				if (arg_value !== undefined) {
					const saved_length = status.values.length;
					status.values.push({
						declaration: "const",
						name: field.name,
						type: field.type,
						is_set: true,
						const_value: arg_value,
					});
					const satisfied = evaluate_const_condition(field.constraint, status);
					status.values.length = saved_length;
					if (satisfied === false) {
						add_error(status, `Constraint not satisfied: ${field.name}`, assign.right_value.start);
					}
				}
			}
		}
	}

	// Check variable constraints on simple assignment (e.g. x = 2 where x has a constraint)
	if (assign.left_value.node_type === "value" && left_value.constraint) {
		let arg_value: number | boolean | undefined;
		if (assign.right_value.node_type === "value") {
			const vn = assign.right_value as ValueNode;
			if (/^[+-]?\d+$/.test(vn.value)) arg_value = parseInt(vn.value, 10);
			if (vn.value === "true") arg_value = true;
			if (vn.value === "false") arg_value = false;
		}
		if (arg_value !== undefined) {
			const saved_length = status.values.length;
			status.values.push({
				declaration: "const",
				name: left_value.name,
				type: left_value.type,
				is_set: true,
				const_value: arg_value,
			});
			const satisfied = evaluate_const_condition(left_value.constraint, status);
			status.values.length = saved_length;
			if (satisfied === false) {
				add_error(status, `Constraint not satisfied: ${left_value.name}`, assign.right_value.start);
			}
		}
	}

	const rhs_type = type_from_value_node(assign.right_value, status);
	const rhs_is_field_access =
		assign.right_value.node_type === "access" &&
		(assign.right_value as AccessNode).access.node_type === "access_field";
	if (rhs_is_field_access && rhs_type.name) {
		if (is_class_type(rhs_type.name, status)) {
			// A class field is a borrowed reference owned by its parent; extracting
			// it requires move+swap so the parent's slot is revalidated.
			if (!assign.swap) {
				add_error(
					status,
					`cannot assign class field '${rhs_type.name}' from another owner, use move with swap`,
					assign.right_value.start,
				);
			}
		} else if (is_owning_struct_type_requiring_move(rhs_type, status)) {
			// An owning struct field cannot be byte-copied out (double-free); move
			// it out with a swap that revalidates the field. A string-only owning
			// struct (e.g. a tuple with a string field) is a sound borrow instead.
			if (!assign.right_value.is_moved) {
				const field_name = (assign.right_value as AccessNode).access.name;
				add_error(
					status,
					`cannot copy '${rhs_type.name}' out of field '${field_name}' by value — it owns heap resources; use move with swap`,
					assign.right_value.start,
				);
			} else if (!assign.swap) {
				add_error(
					status,
					`move out of a field requires a swap to revalidate it`,
					assign.right_value.start,
				);
			}
		}
	}

	// Borrow-lifetime check: a borrowed class reference (a variable that holds
	// a borrow) may not be assigned to a variable declared in an outer scope —
	// that would let the borrow outlive the instance it points into. To move
	// ownership out, use `move` (with swap). Within the same/inner scope the
	// target simply becomes a borrow too.
	if (!assign.swap && left_value.declaration === "var") {
		const rhs_borrow_depth = borrow_depth_of(assign.right_value, status);
		if (rhs_borrow_depth !== undefined) {
			if (left_value.decl_depth !== undefined && left_value.decl_depth < rhs_borrow_depth) {
				add_error(
					status,
					`borrow escapes its scope — use 'move' (with swap) to transfer ownership`,
					assign.right_value.start,
				);
			} else {
				left_value.borrow_depth = rhs_borrow_depth;
				left_value.borrowed_from = borrow_owner_of(assign.right_value, status);
				// Re-assigning a (possibly invalidated) borrow refreshes it: the
				// new value is a fresh borrow rooted at its own owner.
				left_value.borrow_invalidated = false;
			}
			// Copying a struct whose view fields hold borrows transfers the
			// dependency: the copy's pairs alias exactly the same sources
			// (the escape-depth check above already ran on the merged depth).
			const src_name = value_from_value_node(assign.right_value);
			const src_sv =
				assign.right_value.node_type === "value"
					? status.values.findLast((v) => v.name === src_name)
					: undefined;
			if (src_sv?.has_view_borrows) {
				propagate_view_borrows(left_value, src_sv);
			}
		} else if (
			assign.right_value.node_type === "func_call" &&
			type_from_value_node(assign.right_value, status)?.name &&
			type_can_carry_view_borrow(type_from_value_node(assign.right_value, status), status)
		) {
			// A constructor call whose `view T` arguments borrow from named
			// sources (`x = Line(doc.slice(0, 5), …)`): record those
			// dependencies on the receiving variable so escape / invalidation
			// checks see them. An argument rooted deeper than the variable's
			// own declaration scope would let the borrow escape — rejected.
			const infos = ctor_call_view_borrow(assign.right_value as FunctionCallNode, status);
			if (infos?.size) {
				for (const [, info] of infos) {
					const depth = info.depth ?? status.scope_depth;
					if (left_value.decl_depth !== undefined && left_value.decl_depth < depth) {
						add_error(
							status,
							`borrow escapes its scope — the constructed value would outlive its 'view' source`,
							assign.right_value.start,
						);
						break;
					}
				}
				merge_view_borrows_into_var(left_value.name, infos, status);
			}
		} else {
			left_value.borrow_depth = undefined;
			left_value.borrowed_from = undefined;
			left_value.borrow_invalidated = false;
		}
	}

	// Record whether a live field/method borrow OR object-level alias of the lhs
	// exists, so the build can decide between eager reclamation (no reference →
	// safe to free the old instance immediately, which is what makes loop
	// reassignment sound) and deferred reclamation (reference present → keep the
	// old instance alive until that reference's scope ends).
	if (!assign.swap) {
		assign.has_live_borrow = status.values.some(
			(v) => v.borrowed_from === left_value_name || v.class_alias_of === left_value_name,
		);
	}

	if (assign.swap) {
		check_node(assign.swap, status);
		const left_type = type_from_value_node(assign.left_value, status);
		const swap_type = type_from_value_node(assign.swap, status);
		check_type_and_value_match(left_type, swap_type, undefined, status, assign.swap.start, "swap");
	}

	return true;
}

/**
 * Returns true iff `value` is a shifted bound `name + N`, `N + name`,
 * `name - N`, or `N - name` for some integer N — i.e. an expression whose
 * flow-sensitive bounds can be derived by shifting `name`'s existing bounds.
 * Used to decide whether to snapshot the LHS's bounds before clearing them.
 */
function is_self_shifted(value: AssignmentNode["right_value"], name: string): boolean {
	if (value.node_type !== "op") return false;
	const op = value as OperationNode;
	if (op.op !== "+" && op.op !== "-") return false;
	const is_int_literal = (n: BaseNode) =>
		n.node_type === "value" && /^[+-]?\d+$/.test((n as ValueNode).value);
	const is_name = (n: BaseNode) => n.node_type === "value" && (n as ValueNode).value === name;
	return (
		(is_int_literal(op.left_value) && is_name(op.right_value)) ||
		(is_name(op.left_value) && is_int_literal(op.right_value))
	);
}
