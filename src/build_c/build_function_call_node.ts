import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import array_struct_name from "./utils/array_struct.ts";
import c_function_name from "./utils/c_function_name.ts";
import c_type from "./utils/c_type.ts";
import { has_flag_name, is_nullable_struct_type } from "./utils/nullable_struct.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_function_call_node(node: FunctionCallNode, status: BuildStatus) {
	// Shorthand enum-with-args constructor `.case(args)` (rewritten by the
	// checker to `Enum_case` with is_enum_shorthand=true). Lower to the same
	// `Enum_case_init(args)` call that `Enum.case(args)` access calls emit.
	if (node.is_enum_shorthand) {
		status.code += `${node.name}_init(`;
		for (let i = 0; i < node.params.length; i++) {
			if (i > 0) {
				status.code += ", ";
			}
			build_node(node.params[i], status);
		}
		status.code += ")";
		return;
	}

	const is_struct = status.structs.find((s) => s.name === node.name && !s.is_simple_type);
	const func_name = is_struct ? `${node.name}_init` : c_function_name(node.name);
	status.code += `${func_name}(`;

	const variadic_idx = node.variadic_param_name
		? node.params.findIndex((p) => p.node_type === "array")
		: -1;

	for (let i = 0; i < node.params.length; i++) {
		if (i > 0) {
			status.code += ", ";
		}

		if (i === variadic_idx && node.params[i].node_type === "array") {
			const arr = node.params[i] as ArrayValuesNode;
			status.code += `${arr.values.length}, (${c_type(arr.type.name)}[]){`;
			for (let j = 0; j < arr.values.length; j++) {
				if (j > 0) status.code += ", ";
				build_node(arr.values[j], status);
			}
			status.code += "}";
			continue;
		}

		const param_type = type_from_value_node(node.params[i]);

		// A `null` literal arg to a nullable struct value parameter
		// (`use(null)` where `use` takes `T? p`): emit a zero'd compound
		// literal of the param's struct type (so `&(struct T){0}` is valid C)
		// and `0` for the companion flag. Skip the rest of the per-arg
		// machinery — the flag-forwarding step below would otherwise try to
		// take `&0` (invalid).
		if (
			node.nullable_param_indices?.includes(i) &&
			node.params[i].node_type === "value" &&
			(node.params[i] as ValueNode).value === "null"
		) {
			status.code += `(void *)&(struct ${param_type.name}){0}, 0`;
			continue;
		}

		// An `Array<T>` argument that is a heap `struct Array_<T>*` value (a
		// `heap_array_vars` local or another `Array<T>` param — the type carries
		// `is_array_heap`) must be forwarded directly: `ref` Array<T> params
		// want the pointer for in-place `.set` mutation, not its address. Raw
		// `T[]`/`T[N]` args (plain `is_array`) and array-literal VALUES are left
		// to the generic arg path below — they are stack arrays, not heap struct
		// pointers. Struct-constructor calls are excluded too (their array
		// fields store elements inline). `array_struct_name` is the shared,
		// flag-based gate (a compile-time `length` on a heap Array<T> — e.g.
		// from a `[ ... ]` initializer — no longer disqualifies it).
		const arg_arr_struct =
			!is_struct && param_type.is_array && !param_type.is_view
				? array_struct_name(param_type, status)
				: undefined;
		if (arg_arr_struct) {
			// Already a heap `struct Array_<T>*` pointer — forward as-is.
			if (node.params[i].node_type === "value") {
				status.suppress_dereference = true;
			}
			build_node(node.params[i], status);
			status.suppress_dereference = false;
			continue;
		}

		const is_ref_param = node.ref_param_indices?.includes(i);
		// Class-typed arguments are already pointers (the pointer IS the
		// value). They must NOT be passed by address — `&h1->content` would
		// produce a `struct Box**` instead of the intended `struct Box*`.
		const param_is_class = !!status.structs.find((s) => s.name === param_type.name && s.is_class);
		// A `ref` class param is a double pointer: pass the address of the
		// caller's pointer slot so the callee can reassign it (write-back).
		if (is_ref_param && param_is_class) {
			const arg = node.params[i];
			if (arg.node_type === "value" && status.ref_class_params?.has((arg as ValueNode).value)) {
				// Caller's arg is itself a ref class param (already `T **`);
				// forward as-is without re-taking its address.
				status.suppress_dereference = true;
				build_node(arg, status);
				status.suppress_dereference = false;
				continue;
			}
			status.code += `&`;
			status.suppress_dereference = true;
			build_node(arg, status);
			status.suppress_dereference = false;
			continue;
		}
		const wants_address =
			(!param_is_class &&
				!!status.structs.find((s) => s.name === param_type.name && !s.is_simple_type)) ||
			!!status.traits.find((t) => t.name === param_type.name) ||
			is_ref_param;
		if (wants_address) {
			// If the argument is itself a ref/var param or a class variable
			// (already a pointer), don't emit `&*x` — `x` (or its current
			// pointer value) is the correct address.
			if (
				node.params[i].node_type === "value" &&
				(status.function_ref_params?.has((node.params[i] as ValueNode).value) ||
					status.class_vars?.has((node.params[i] as ValueNode).value))
			) {
				// pass through; build_value_node would print `*x`, so suppress it
				status.suppress_dereference = true;
			} else if (is_ref_param) {
				status.code += `&`;
			} else {
				status.code += `(void *)&`;
			}
		} else if (param_is_class) {
			// Class-typed arg: the value is already a pointer. Suppress the
			// `*` deref that build_value_node would add for ref params — unless
			// the arg is itself a `ref` class param (a double pointer `T **`),
			// whose single-pointer callee param needs one deref (`(*t)`).
			if (
				!(
					node.params[i].node_type === "value" &&
					status.ref_class_params?.has((node.params[i] as ValueNode).value)
				)
			) {
				status.suppress_dereference = true;
			}
		}

		build_node(node.params[i], status);
		status.suppress_dereference = false;

		// If this argument corresponds to a nullable struct value parameter
		// (`T? p`), the callee takes a companion `unsigned char <name>_has`
		// flag as the very next C parameter (see build_function_node). Forward
		// the caller-side flag: a `null` literal → 0; a bare variable /
		// field-access arg → its built `_has` expression; any other
		// expression → 1 (assumed non-null).
		if (node.nullable_param_indices?.includes(i)) {
			status.code += `, `;
			emit_nullable_arg_flag(node.params[i], status);
		}
	}

	// A nullable struct RETURN type adds a hidden `unsigned char *_ret_has`
	// out-parameter as the LAST callee parameter. Forward `&<flag>` so the
	// callee can write null-ness back. The flag name comes from
	// `status.current_nullable_call_flag` when a consumer has pre-allocated
	// storage (e.g. a `var T? x = f()` declaration uses its own `_has` flag);
	// otherwise the call is wrapped in a GCC statement-expression that
	// synthesises a throwaway flag temp.
	if (is_nullable_struct_type(node.type, status)) {
		const flag_name = status.current_nullable_call_flag;
		if (flag_name) {
			status.code += `, &${flag_name}`;
		} else {
			// Wrap the call (already emitted up to the open paren + args) in
			// a statement-expression that owns the flag temp. The temp's
			// `_has` value is discarded — this path is for consumers that
			// treat the call result as a non-null value (e.g. the call is the
			// whole RHS of an assignment to a non-nullable T, which the type
			// checker only permits when the result is provably non-null).
			const tmp = `_nsd_${ns_default_counter++}`;
			const open = status.code.lastIndexOf(`${func_name}(`);
			if (open !== -1) {
				const before = status.code.slice(0, open);
				const call = status.code.slice(open);
				status.code = before + `({ unsigned char ${tmp} = 0; ` + call + `, &${tmp}); })`;
			} else {
				status.code += `, &${tmp}`;
			}
		}
	}

	status.code += ")";

	if (node.name.startsWith("_string_interpolate_")) {
		status.interpolate_string_counts.add(node.params.length - 1);
	}

	if (node.swap_params?.size) {
		for (const [idx, swap_expr] of node.swap_params) {
			const source = node.params[idx];
			if (!source) continue;
			status.code += `; `;

			if (
				source.node_type === "access" &&
				(source as AccessNode).access.node_type === "access_field"
			) {
				const src_access = source as AccessNode;
				const src_field = (src_access.access as AccessFieldNode).name;
				// Determine if the target is a class var / ref param (needs `->`)
				const tgt_name =
					src_access.target.node_type === "value" ? (src_access.target as ValueNode).value : "";
				const tgt_is_ptr =
					!!status.function_ref_params?.has(tgt_name) || !!status.class_vars?.has(tgt_name);
				if (tgt_is_ptr) status.suppress_dereference = true;
				build_node(src_access.target, status);
				status.suppress_dereference = false;
				status.code += tgt_is_ptr ? `->${src_field} = ` : `.${src_field} = `;
				build_node(swap_expr, status);
			} else if (source.node_type === "value") {
				const src_name = (source as ValueNode).value;
				status.code += `${src_name} = `;
				build_node(swap_expr, status);
			}
		}
	}

	// mov parameter handling: when a class-typed variable (or a hoisted
	// temporary like `_param_N`) is passed with `mov`, ownership transfers
	// to the callee. Remove it from scoped_declarations so auto_free won't
	// free it at scope exit (would double-free or UAF).
	if (node.mov_param_indices) {
		for (const idx of node.mov_param_indices) {
			const param = node.params[idx];
			if (param?.node_type === "value") {
				const vname = (param as ValueNode).value;
				const di = status.scoped_declarations.findIndex((d) => d.name === vname);
				if (di !== -1) status.scoped_declarations.splice(di, 1);
				// Record that this variable's value has been moved out. A later
				// reassignment (`a = null` / `a = Box(2)`) must NOT reclaim the
				// old (already-transferred) value — the callee now owns it.
				if (!status.moved) status.moved = new Set();
				status.moved.add(vname);
			}
		}
	}
}

let ns_default_counter = 0;
export function reset_ns_default_counter() {
	ns_default_counter = 0;
}

/**
 * Emit the caller-side `_has` flag value for a nullable struct argument.
 * The arg corresponds to a `T?` callee parameter; the call site passes both
 * the struct address (already emitted before this call) and its flag value
 * (this helper). `null` literal → 0; a bare nullable-struct variable /
 * field-access arg → its built `_has` flag expression; a non-nullable
 * struct value (a fresh constructor, a hoisted `_param_N`, a non-nullable
 * local) → 1 (it's a real value being lifted into the nullable param type).
 */
function emit_nullable_arg_flag(arg: BaseNode, status: BuildStatus) {
	// `null` literal
	if (arg.node_type === "value" && (arg as ValueNode).value === "null") {
		status.code += `0`;
		return;
	}
	// Bare variable: forward its flag IF the variable itself is a nullable
	// struct value (a `var T? x = ...` local). A non-nullable struct value
	// (a hoisted `_param_N` from a constructor, a plain `T x` local) is being
	// lifted into the nullable param type — emit `1`.
	if (arg.node_type === "value") {
		const vn = arg as ValueNode;
		if (is_nullable_struct_type(vn.type, status)) {
			status.code += `${has_flag_name(vn.value)}`;
		} else {
			status.code += `1`;
		}
		return;
	}
	// Field access `obj.field` / `obj->field` — if the field's type is a
	// nullable struct, build the lvalue and append `_has`. Otherwise (a
	// non-nullable struct field being lifted), emit `1`.
	if (arg.node_type === "access" && (arg as AccessNode).access.node_type === "access_field") {
		const t = type_from_value_node(arg);
		if (is_nullable_struct_type(t, status)) {
			const before = status.code.length;
			build_node(arg, status);
			const expr = status.code.substring(before);
			status.code = status.code.substring(0, before);
			status.code += `${expr}_has`;
		} else {
			status.code += `1`;
		}
		return;
	}
	// Anything else (function call result, operation, etc.) — assume non-null.
	status.code += `1`;
}
