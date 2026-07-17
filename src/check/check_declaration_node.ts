import add_error from "../add_error.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AnonStructNode from "../nodes/AnonStructNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
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
	if (decl.func_params) {
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
			for (const param of decl.func_params) {
				status.values.push({
					declaration: param.declaration,
					name: param.name,
					type: param.type,
					is_set: true,
				});
			}
			status.stack.push(decl);
			check_node(decl.value, status);
			status.stack.pop();
			return;
		} else if (decl.value) {
			status.stack.push(decl);

			convert_anon_struct(decl, status);

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
			declaration: decl.declaration,
			name: decl.name,
			type: decl.func_return_type || decl.type,
			is_set: !!decl.value,
			start: decl.start,
			is_null: decl.value?.node_type === "value" && (decl.value as any).value === "null",
			const_value: decl.declaration === "const" ? extract_const_value(decl.value) : undefined,
			constraint: decl.constraint,
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

		// ref fields are non-owning borrows with no lifetime enforcement; the
		// borrow can outlive its target (use-after-free). Disallow them on
		// structs/classes/traits -- use a value field (copied) or a 'mov' field.
		if (
			decl.type.is_ref &&
			(decl.scope?.node_type === "struct" || decl.scope?.node_type === "trait")
		) {
			add_error(status, `fields cannot be 'ref', use a value or 'mov' field`, decl.start);
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

			convert_anon_struct(decl, status);

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
			declaration: decl.declaration,
			name: decl.name,
			type: decl.type,
			is_set: !!decl.value,
			start: decl.start,
			is_null: decl.value?.node_type === "value" && (decl.value as any).value === "null",
			const_value: decl.declaration === "const" ? extract_const_value(decl.value) : undefined,
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

function convert_anon_struct(decl: DeclarationNode, status: CheckStatus) {
	if (decl.value?.node_type !== "anon_struct") return;
	const struct = status.structs.findLast((s) => s.name === decl.type.name);
	if (!struct) return;
	const anon = decl.value as AnonStructNode;
	const init_func = struct.functions.find((f) => f.name === "#init");
	if (!init_func) return;
	const args: import("../nodes/BaseNode.ts").default[] = [];
	for (const init_param of init_func.params) {
		const field = anon.fields.find((f) => f.name === init_param.name);
		if (field) {
			args.push(field.value);
		} else if (init_param.default_value) {
			args.push(init_param.default_value);
		}
	}
	for (const field of anon.fields) {
		if (!init_func.params.find((p) => p.name === field.name)) {
			return;
		}
	}
	const constructor = new FunctionCallNode(anon.start, struct.name);
	constructor.params = args;
	constructor.type = new Type(struct.name);
	decl.value = constructor;
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
