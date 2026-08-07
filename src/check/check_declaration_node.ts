import add_error from "../add_error.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import { borrow_depth_of, borrow_owner_of } from "./utils/borrow.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import check_type_exists from "./utils/check_type_exists.ts";
import evaluate_const_condition from "./utils/evaluate_const_condition.ts";
import { apply_bounds, track_assignment_bounds } from "./utils/flow_bounds.ts";
import { is_class_type, is_owning_struct_type } from "./utils/ownership.ts";
import { materialize_tuple_type } from "./utils/tuple_struct.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

export default function check_declaration_node(decl: DeclarationNode, status: CheckStatus) {
	// `view hi = expr` is sugar for a const view binding. Normalize the
	// keyword to `const` so every downstream site (StackValue, both backends,
	// the var-never-changed warning) treats it as an immutable binding. View
	// semantics are driven entirely by `type.is_view`, which is unaffected.
	const is_view_keyword = decl.declaration === "view";
	// Narrowed, view-free declaration kind for the StackValue and backends.
	// The ternary narrows `decl.declaration` in the false branch to exclude
	// "view", so this local is exactly `"const" | "var" | "mov"`.
	const declaration: "const" | "var" | "mov" =
		decl.declaration === "view" ? "const" : decl.declaration;
	decl.declaration = declaration;
	// Whether the user wrote a `view` type modifier (`var view T v = ...`).
	// Captured before inference overwrites decl.type.
	const declared_type_is_view = !!decl.type.is_view;

	if (decl.func_params) {
		if (is_view_keyword) {
			add_error(status, `'view' cannot declare a function-typed binding`, decl.start);
		}
		if (decl.func_return_type) {
			check_type_exists(decl.func_return_type, status, -1);
			if (decl.func_return_type.name === "tuple" && decl.func_return_type.tuple_types?.length) {
				decl.func_return_type = materialize_tuple_type(decl.func_return_type, status);
			}
		}
		for (const param of decl.func_params) {
			if (param.type.name) {
				check_type_exists(param.type, status, param.type_start!);
				if (param.type.name === "tuple" && param.type.tuple_types?.length) {
					param.type = materialize_tuple_type(param.type, status);
				}
			}
		}

		if (decl.value && decl.value.node_type === "func") {
			// The function-type signature on the left (decl.func_params) supplies
			// the parameter types; the anonymous function on the right
			// (decl.value) supplies the parameter names. Merge the left-hand
			// types into the right-hand params by position when the right-hand
			// param has no type of its own.
			const value_func = decl.value as FunctionNode;
			const lhs_params = decl.func_params;
			if (value_func.params.length === lhs_params.length) {
				for (let i = 0; i < value_func.params.length; i++) {
					if (!value_func.params[i].type.name && lhs_params[i].type.name) {
						value_func.params[i].type = lhs_params[i].type;
						value_func.params[i].type_start = lhs_params[i].type_start;
					}
				}
			}
			if (decl.func_return_type && !value_func.return_type.name) {
				value_func.return_type = decl.func_return_type;
			}

			status.stack.push(decl);
			check_node(decl.value, status);
			status.stack.pop();
			return;
		} else if (decl.value) {
			status.stack.push(decl);

			const old_expected_type = status.expected_type;
			status.expected_type = decl.type;
			const result = check_node(decl.value, status);
			status.expected_type = old_expected_type;

			if (result) {
				check_type_and_value_match(
					decl.type,
					type_from_value_node(decl.value, status),
					value_from_value_node(decl.value),
					status,
					decl.value.start,
					"declaration",
				);
			}

			if (!decl.type.name) {
				decl.type = type_from_value_node(decl.value, status);
			} else if (decl.type.is_array && decl.value.node_type === "array") {
				const value_type = type_from_value_node(decl.value, status);
				if (value_type.is_array && value_type.length) {
					decl.type.length = value_type.length;
				}
			}

			status.stack.pop();
		}

		status.values.push({
			declaration: declaration,
			name: decl.name,
			type: decl.func_return_type || decl.type,
			is_set: !!decl.value,
			start: decl.start,
			is_null: decl.value?.node_type === "value" && (decl.value as any).value === "null",
			const_value: declaration === "const" ? extract_const_value(decl.value) : undefined,
			constraint: decl.constraint,
			func_params: decl.func_params?.map((p) => ({ name: p.name, type: p.type })),
			func_return_type: decl.func_return_type,
		});
		if (decl.value) {
			track_assignment_bounds(decl.name, decl.value, status);
		}
	} else {
		if (decl.type.name) {
			check_type_exists(decl.type, status, decl.type_start!);
		}
		// Materialize tuple types into anonymous structs
		if (decl.type.name === "tuple" && decl.type.tuple_types?.length) {
			decl.type = materialize_tuple_type(decl.type, status);
		}

		// Check for var on class-type fields in classes/traits (must use mov)
		if (
			decl.declaration === "var" &&
			decl.type.name &&
			is_class_type(decl.type.name, status) &&
			(decl.scope?.node_type === "struct" || decl.scope?.node_type === "trait")
		) {
			add_error(status, `class-type fields must use 'mov', not 'var'`, decl.start);
		}

		if (decl.value) {
			status.stack.push(decl);

			const old_expected_type = status.expected_type;
			status.expected_type = decl.type;
			const result = check_node(decl.value, status);
			status.expected_type = old_expected_type;

			if (result) {
				check_type_and_value_match(
					decl.type,
					type_from_value_node(decl.value, status),
					value_from_value_node(decl.value),
					status,
					decl.value.start,
					"declaration",
				);
			}

			if (!decl.type.name) {
				decl.type = type_from_value_node(decl.value, status);
			} else if (decl.type.is_array && decl.value.node_type === "array") {
				const value_type = type_from_value_node(decl.value, status);
				if (value_type.is_array && value_type.length) {
					decl.type.length = value_type.length;
				}
			}

			status.stack.pop();
		}

		// View-binding enforcement. By this point decl.type is final (declared or
		// inferred), and `view` keyword decls have been normalized to `const`.
		//   - Rule 1: `view hi = expr` requires the value to actually be a view
		//     (e.g. a .slice() result). Binding an owned value with `view` is a
		//     mistake — the user probably meant `const`.
		//   - Rule 3: a `var`/`const`/`mov` declaration whose *inferred* type is a
		//     view must opt in explicitly — either with the `view` keyword
		//     (`view hi = ...`) or a `view` type modifier (`var view T v = ...`).
		//     This keeps the borrow semantics visible at the declaration site.
		if (is_view_keyword && decl.value && !decl.type.is_view) {
			add_error(
				status,
				`'view' binding requires a view value (e.g. a .slice() result), got ${decl.type.name}`,
				decl.value.start,
			);
		}
		if (!is_view_keyword && !declared_type_is_view && decl.type.is_view && decl.value) {
			add_error(
				status,
				`binding a view requires the 'view' keyword (e.g. 'view name = ...' or 'var view name = ...')`,
				decl.value.start,
			);
		}

		// A string literal bound to a const has a known, invariant length.
		// Record it on the type so the bounds verifier can prove
		// `i < str.length` for `str.at(i)` (mirrors array-literal length).
		// For var declarations the length is also known at declaration time,
		// but can change on reassignment — the constraint checker only uses
		// it during the current call, before any reassignment.
		if (
			decl.type.name === "string" &&
			decl.value &&
			decl.value.node_type === "value" &&
			(decl.value as any).value.startsWith('"') &&
			(decl.value as any).value.endsWith('"')
		) {
			const lit = (decl.value as any).value;
			const len = lit.length - 2; // strip surrounding quotes
			decl.type.length = new ValueNode(decl.value.start, len.toString(), new Type("int"));
		}

		// A struct that transitively owns a heap resource (List/Map via a Buffer
		// field, Buffer/File/ClassBuffer via a resource-releasing #destroy, or any
		// struct with a class field) cannot be byte-copied from another variable —
		// both copies would free the same backing data (double-free). Only a
		// bare-variable copy is rejected here; a fresh allocation (constructor /
		// function return) is a move, not a copy, and member-access copies (e.g.
		// `var Buffer old = self.field`) are left to the field machinery. Use
		// .copy() for a deep copy or `mov` to transfer ownership. A struct whose
		// #destroy only resets fields (no raw block) is NOT owning and may copy.
		if (decl.value?.node_type === "value" && !decl.value.is_moved) {
			const val_type = type_from_value_node(decl.value, status);
			if (val_type.name && is_owning_struct_type(val_type, status)) {
				add_error(
					status,
					`cannot copy '${val_type.name}' by value — it owns heap resources; use .copy() or mov`,
					decl.value.start,
				);
			}
		}
		// Copying an owning struct out of a field (`var X b = obj.field`)
		// duplicates the backing pointer; the field must be moved out with a swap
		// that revalidates it (`var X b = mov obj.field swap <replacement>`).
		// `mov` without a swap would leave the field holding a moved-out value.
		if (
			decl.value?.node_type === "access" &&
			(decl.value as AccessNode).access.node_type === "access_field"
		) {
			const field_type = type_from_value_node(decl.value, status);
			if (field_type.name && is_owning_struct_type(field_type, status)) {
				const field_name = ((decl.value as AccessNode).access as AccessFieldNode).name;
				if (!decl.value.is_moved) {
					add_error(
						status,
						`cannot copy '${field_type.name}' out of field '${field_name}' by value — it owns heap resources; use 'mov ... swap <replacement>'`,
						decl.value.start,
					);
				} else if (!decl.swap) {
					add_error(
						status,
						`mov out of a field requires a swap to revalidate it`,
						decl.value.start,
					);
				} else {
					// Inside a generic struct's body, a swap like `Buffer<TK>()`
					// can't be resolved yet (deferred until monomorphization), so
					// only run the type match when the swap checked successfully.
					const swap_ok = check_node(decl.swap, status);
					if (swap_ok) {
						check_type_and_value_match(
							field_type,
							type_from_value_node(decl.swap, status),
							undefined,
							status,
							decl.swap.start,
							"swap",
						);
					}
				}
			}
		}

		// `var X b = mov a` (no swap) transfers ownership: the source `a` is moved
		// and may not be used again until reassigned. (A swap revalidates it.)
		if (decl.value?.node_type === "value" && decl.value.is_moved && !decl.swap) {
			if (!status.moved_variables) status.moved_variables = new Set();
			status.moved_variables.add((decl.value as ValueNode).value);
		}

		check_constraint(decl, status);

		// A plain class-variable copy (`var Box q = p`) is an object-level alias:
		// it shares p's instance, so it must NOT be destroyed at scope exit (the
		// build side skips it), but unlike a child-group borrow (field/container
		// access) it is intentionally not invalidated by mutating the owner — p
		// and q are the same object, so a mutation through one is visible through
		// the other and the alias stays valid. We therefore leave borrow_depth /
		// borrowed_from unset here (so the invalidation machinery does not fire)
		// and let the build classify the alias syntactically. We do record
		// class_alias_of so reassignment of the owner defers (not eager-frees)
		// its old instance — otherwise the alias would dangle.
		const class_alias_src =
			decl.value?.node_type === "value" &&
			!(decl.value as any).is_moved &&
			(decl.value as any).value !== "null" &&
			decl.type.name &&
			is_class_type(decl.type.name, status)
				? (decl.value as ValueNode).value
				: undefined;
		status.values.push({
			declaration: declaration,
			name: decl.name,
			type: decl.type,
			is_set: !!decl.value,
			start: decl.start,
			is_null: decl.value?.node_type === "value" && (decl.value as any).value === "null",
			const_value: declaration === "const" ? extract_const_value(decl.value) : undefined,
			constraint: decl.constraint,
			decl_depth: status.scope_depth,
			borrow_depth: decl.value ? borrow_depth_of(decl.value, status) : undefined,
			borrowed_from: decl.value ? borrow_owner_of(decl.value, status) : undefined,
			class_alias_of: class_alias_src,
		});
		if (decl.value) {
			track_assignment_bounds(decl.name, decl.value, status);
		}
		// Apply any return-contract bounds stashed while checking the initializer
		// (the variable wasn't in scope during its own initializer check).
		if (status.pending_return_bounds) {
			const pending = status.pending_return_bounds.get(decl.name);
			if (pending) {
				for (const bound of pending) apply_bounds(bound, status);
				status.pending_return_bounds.delete(decl.name);
			}
		}
	}
}

/**
 * Check that a declaration's value satisfies its constraint (if any).
 * Only checks compile-time constant values.
 */
function check_constraint(decl: DeclarationNode, status: CheckStatus) {
	if (!decl.constraint) return;

	// Type-check the constraint expression and verify it's boolean
	const saved_length = status.values.length;
	status.values.push({
		declaration: "const",
		name: decl.name,
		type: decl.type,
		is_set: true,
	});
	// Make sibling struct fields visible so a field constraint can reference an
	// earlier field (e.g. `var int y: x < 100`). They're not yet initialized with
	// concrete values at definition time, so only mark them set (no const_value);
	// the constraint then evaluates to `undefined` (unverifiable) rather than a
	// false "not initialized" error. The real check happens at the constructor
	// call site, where each argument is a known value.
	if (decl.scope && (decl.scope as any).node_type === "struct") {
		const sibling_struct = decl.scope as any;
		for (const field of sibling_struct.fields) {
			if (field.name === decl.name) continue;
			let const_value: number | boolean | undefined;
			if (field.value?.node_type === "value") {
				const vn = field.value as ValueNode;
				if (/^[+-]?\d+$/.test(vn.value)) const_value = parseInt(vn.value, 10);
				else if (vn.value === "true") const_value = true;
				else if (vn.value === "false") const_value = false;
			}
			status.values.push({
				declaration: "const",
				name: field.name,
				type: field.type,
				is_set: true,
				const_value,
			});
		}
	}
	check_node(decl.constraint, status);
	const constraint_type = type_from_value_node(decl.constraint, status);
	if (constraint_type.name && constraint_type.name !== "bool") {
		add_error(
			status,
			`Constraint must be a boolean expression, got ${constraint_type.name}`,
			decl.constraint.start,
		);
	}

	// Check compile-time constant value (only if value exists)
	if (!decl.value) {
		status.values.length = saved_length;
		return;
	}

	let arg_value: number | boolean | undefined;
	if (decl.value.node_type === "value") {
		const vn = decl.value as ValueNode;
		if (/^[+-]?\d+$/.test(vn.value)) arg_value = parseInt(vn.value, 10);
		if (vn.value === "true") arg_value = true;
		if (vn.value === "false") arg_value = false;
	}

	if (arg_value === undefined) {
		status.values.length = saved_length;
		return;
	}

	// Update the const_value for evaluation
	(status.values[status.values.length - 1] as any).const_value = arg_value;

	const satisfied = evaluate_const_condition(decl.constraint, status);
	status.values.length = saved_length;

	if (satisfied === false) {
		add_error(status, `Constraint not satisfied: ${decl.name}`, decl.value.start);
	}
}

/**
 * Extract a compile-time literal value from a declaration's initializer node.
 * Returns a number, string, or boolean for simple literals; undefined otherwise.
 */
function extract_const_value(
	value: import("../nodes/BaseNode.ts").default | undefined,
): number | string | boolean | undefined {
	if (!value || value.node_type !== "value") return undefined;
	const vn = value as ValueNode;
	if (vn.value === "true") return true;
	if (vn.value === "false") return false;
	if (/^[+-]?\d+$/.test(vn.value)) return parseInt(vn.value, 10);
	if (/^[+-]?\d+\.\d+$/.test(vn.value)) return parseFloat(vn.value);
	return undefined;
}
