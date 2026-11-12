import flatten_null_chain from "../build_common/null_chain.ts";
import { is_nullable_scalar_type } from "../build_common/nullable_scalar.ts";
import { has_flag_name, is_nullable_struct_type } from "../build_common/nullable_struct.ts";
import { is_float_type } from "../built_in_types.ts";
import AccessNode from "../nodes/AccessNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { emit_nursery_joins_on_return_c } from "./build_async_block_node.ts";
import build_node from "./build_node.ts";
import { emit_chain_tests } from "./build_null_chain_value.ts";
import type BuildStatus from "./BuildStatus.ts";
import { reclaim_all_c_scopes } from "./utils/c_scope.ts";
import c_type from "./utils/c_type.ts";
import { begin_code_scratch, end_code_scratch } from "./utils/code_scratch.ts";
import { enum_with_data_side, static_enum_case } from "./utils/enum_eq.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import { c_view_string_arg, is_view_value } from "./utils/view_value.ts";

export default function build_operation_node(node: OperationNode, status: BuildStatus) {
	// Resolve a deferred == / != operator (set during generic-body checking
	// when the operands were unresolved type params) against the now-concrete
	// operand type. If the struct defines `eq`/`ne`, dispatch to it; otherwise
	// clear the marker so the builtin comparison path handles it.
	if (node.operator_func?.deferred) {
		// After monomorphization, at least one operand has a concrete
		// substituted type (ValueNodes are substituted; access-func results
		// like `load_T()` may keep the generic "T"). Try both sides.
		let left_type = type_from_value_node(node.left_value);
		let struct = status.structs.find((s) => s.name === left_type.name);
		if (!struct) {
			const right_type = type_from_value_node(node.right_value);
			struct = status.structs.find((s) => s.name === right_type.name);
		}
		const target = node.operator_func.func_name;
		const dual = target === "eq" ? "ne" : "eq";
		let func = struct?.functions.find((f) => f.name === target);
		let invert = false;
		if (!func && struct) {
			func = struct.functions.find((f) => f.name === dual);
			invert = !!func;
		}
		if (func && struct) {
			node.operator_func = {
				struct_name: struct.name,
				func_name: func.name,
				invert,
			};
		} else {
			node.operator_func = undefined;
		}
	}

	if (node.op === "!") {
		status.code += `!`;
		build_node(node.right_value, status);
	} else if (node.op === "u-") {
		// Unary minus: emit C unary `-`. The operand is wrapped by the binary
		// builder if it's itself an operation; otherwise (variable/call/access)
		// C's unary `-` binds tighter than any binary operator, so no parens
		// are needed.
		status.code += `-`;
		build_node(node.right_value, status);
	} else if (node.op === "p!") {
		// Postfix `!` (ERRORS_PLAN): evaluate the Result once into a
		// statement-expression temp; the FAIL case returns from the
		// enclosing function with the error payload — the same
		// destroy-walking early return a `return` emits (the binding being
		// initialized holds nothing yet, so its slot is spliced out of the
		// reclaim and restored for the ok path's scope-exit free); the OK
		// case yields the payload. Ownership per arm mirrors `!!`:
		// producer arms transfer their fresh buffers, alias arms (a
		// variable read) strdup strings.
		const left_type = type_from_value_node(node.left_value);
		const mono = left_type?.name ?? "";
		const id = ns_tmp_counter;
		ns_tmp_counter += 1;
		const ok_field = node.coalesce_ok_field || "value";
		const fail_field = node.propagate_fail_field || "err";
		const left_is_producer =
			node.left_value.node_type === "func_call" ||
			(node.left_value.node_type === "access" &&
				(node as unknown as { access?: { node_type: string } }).access?.node_type ===
					"access_func");
		const is_string = node.type?.name === "string";
		status.code += `({ struct ${mono} _pb_${id} = `;
		build_node(node.left_value, status);
		const rv_mono = status.function_return_type?.name ?? mono;
		status.code += `; if (_pb_${id}.tag != ${mono}_ok) { struct ${rv_mono} _rv_${id}; `;
		if (node.propagate_into) {
			// Composed set widening: build the member's origin-tagged value in
			// a temp, then land it in the RETURN Result's fail slot (the outer
			// tag is the enclosing enum's `fail`, never the inner anon tag).
			const pi = node.propagate_into;
			status.code += `struct ${pi.mono} _av_${id}; `;
			status.code += `_av_${id}.tag = ${pi.mono}_${pi.case}; _av_${id}._data._${pi.case}.${pi.field} = _pb_${id}._data._fail.${fail_field}; `;
			status.code += `_rv_${id}.tag = ${pi.outer_mono}_fail; _rv_${id}._data._fail.${pi.outer_field} = _av_${id}; `;
		} else if (left_is_producer) {
			// The temp owns the payload — move the bytes (fail_init would
			// strdup and orphan the temp's copy). The tag/ctor come from the
			// ENCLOSING result type: a unit enclosing (`out ! E`) has the
			// same fail layout under a different ok case.
			status.code += `_rv_${id}.tag = ${rv_mono}_fail; _rv_${id}._data._fail.${fail_field} = _pb_${id}._data._fail.${fail_field}; `;
		} else {
			status.code += `_rv_${id} = ${rv_mono}_fail_init(_pb_${id}._data._fail.${fail_field}); `;
		}
		// Bindings that hold nothing yet must not be freed on the fail path:
		// the checker-stamped in-flight binding (a user `var x = ...!`) and
		// any HOISTED temp whose initializer IS this p! node (the lift's
		// `_param_N = <p!>` arg hoist — its declaration is registered before
		// the initializer builds).
		const in_flight = (d: { name: string; value?: BaseNode | null }) =>
			d.name === node.in_flight_binding || d.value === node;
		const frames = [status.scoped_declarations, ...(status.c_scope_stack ?? [])];
		const spliced: {
			frame: (typeof frames)[number];
			index: number;
			decl: (typeof frames)[number][number];
		}[] = [];
		for (const frame of frames) {
			let di = frame.findIndex((d) => in_flight(d));
			while (di !== -1) {
				const [decl] = frame.splice(di, 1);
				spliced.push({ frame, index: di, decl });
				di = frame.findIndex((d) => in_flight(d));
			}
		}
		emit_nursery_joins_on_return_c(status);
		reclaim_all_c_scopes(status);
		// Restore the bookings (descending index order keeps positions valid)
		// so the ok path's scope-exit free still covers them.
		for (const { frame, index, decl } of spliced.reverse()) {
			frame.splice(index, 0, decl);
		}
		status.code += `return _rv_${id}; } `;
		if (!node.coalesce_ok_field) {
			// A value-less operand (`close()!`) yields nothing.
			status.code += `(void)0; })`;
		} else if (is_string && !left_is_producer) {
			status.code += `nomen_str_dup(_pb_${id}._data._ok.${ok_field}); })`;
		} else {
			status.code += `_pb_${id}._data._ok.${ok_field}; })`;
		}
	} else if (node.op === "!!") {
		// `result !! fallback` (ERRORS_PLAN): evaluate the Result once into
		// a statement-expression temp, then pick the ok payload or the
		// fallback. Ownership per string arm (the audit runtime verifies
		// every shape in test/errors.test.ts): a PRODUCER arm (a call — the
		// call temp's fresh buffer transfers to the consumer) yields
		// directly; a variable read or a literal aliases its owner or
		// rodata, so it is dup'd into an independently owned copy
		// (nomen_str_dup, the `??` convention). Non-string payloads ride
		// ordinary value semantics (scalars copy; struct payloads alias
		// exactly like assignment).
		const left_type = type_from_value_node(node.left_value);
		const mono = left_type?.name ?? "";
		const id = ns_tmp_counter;
		ns_tmp_counter += 1;
		const field = node.coalesce_ok_field || "value";
		const tag_const = `${mono}_ok`;
		const left_is_producer =
			node.left_value.node_type === "func_call" ||
			(node.left_value.node_type === "access" &&
				(node as { access?: { node_type: string } }).access?.node_type === "access_func");
		const right_is_producer =
			node.right_value.node_type === "func_call" ||
			(node.right_value.node_type === "access" &&
				(node as { access?: { node_type: string } }).access?.node_type === "access_func");
		if (node.type?.name === "string") {
			status.code += `({ struct ${mono} _rco_${id} = `;
			build_node(node.left_value, status);
			status.code += `; _rco_${id}.tag == ${tag_const} ? ${left_is_producer ? "" : "nomen_str_dup("}_rco_${id}._data._ok.${field}${left_is_producer ? "" : ")"}`;
			status.code += ` : ${right_is_producer ? "" : "nomen_str_dup("}(`;
			build_node(node.right_value, status);
			status.code += `)${right_is_producer ? "" : ")"}; })`;
		} else {
			status.code += `({ struct ${mono} _rco_${id} = `;
			build_node(node.left_value, status);
			status.code += `; _rco_${id}.tag == ${tag_const} ? _rco_${id}._data._ok.${field} : (`;
			build_node(node.right_value, status);
			status.code += `); })`;
		}
	} else if (node.op === "??") {
		// Nullable chaining (ERRORS_PLAN): `a?.b ?? fallback`. The chain's
		// nullness is consumed here — evaluate it once inside an if/else
		// (lazy fallback), per-arm ownership like `??` (string arms dup).
		const flat_chain = flatten_null_chain(node.left_value, (t, f) => {
			const st = status.structs.findLast((s) => s.name === t && !s.is_generic);
			return st?.fields.find((fld) => fld.name === f)?.type;
		});
		if (flat_chain) {
			const t = node.type;
			const id = ns_tmp_counter++;
			const is_str = t?.name === "string";
			const is_struct =
				!!t?.name &&
				!!status.structs.find(
					(st) => st.name === t.name && !st.is_simple_type && !st.is_class && !st.is_generic,
				);
			const c_t = is_str
				? "nomen_string"
				: is_struct
					? `struct ${t!.name}`
					: c_type(t?.name || "long");
			// Per-arm ownership (mirrors `!!`): a PRODUCER arm (a call — the
			// call temp's fresh buffer transfers to the consumer) yields
			// directly; an alias arm (a variable/field read, a literal)
			// strdup's into an independently owned copy.
			const value_is_producer =
				flat_chain.value.node_type === "func_call" ||
				(flat_chain.value.node_type === "access" &&
					(flat_chain.value as AccessNode).access.node_type === "access_func");
			const right_is_producer =
				node.right_value.node_type === "func_call" ||
				(node.right_value.node_type === "access" &&
					(node.right_value as AccessNode).access.node_type === "access_func");
			status.code += `({ ${c_t} _nsc_${id}; if (`;
			status.code += emit_chain_tests(flat_chain.hops, status);
			status.code += `) { _nsc_${id} = `;
			if (is_str && !value_is_producer) status.code += `nomen_str_dup(`;
			build_node(flat_chain.value, status);
			if (is_str && !value_is_producer) status.code += `)`;
			status.code += `; } else { _nsc_${id} = `;
			if (is_str && !right_is_producer) status.code += `nomen_str_dup(`;
			build_node(node.right_value, status);
			if (is_str && !right_is_producer) status.code += `)`;
			status.code += `; } _nsc_${id}; })`;
			return;
		}
		// `nullable ?? fallback`. For a nullable struct, the flag is `<expr>_has`.
		const left_type = type_from_value_node(node.left_value);
		if (left_type?.is_nullable && left_type.name === "string") {
			// Nullable string: null is the in-band {NULL, 0} fat zero — the
			// null test is `left.ptr != 0`. Evaluate the left once. An ALIAS
			// arm (a variable/field read, a literal) is dup'd into an
			// independently owned copy: the result feeds consumers that free
			// it (interpolation args, let bindings, return-boundary
			// ownership), and yielding the payload or the fallback directly
			// would free the left's own buffer at its scope exit (alias →
			// double free) or rodata (the `nullable ?? "literal"` SIGABRT).
			// A PRODUCER arm (a call — the call strdup's every string return,
			// so its buffer is fresh and unaliased) yields DIRECTLY: dup'ing
			// a fresh buffer leaks the original. Per-arm ownership mirrors
			// the chain `??` paths and `!!`. nomen_str_dup is the prelude
			// helper (null-safe) so the arms stay one expression.
			const id = ns_tmp_counter;
			ns_tmp_counter += 1;
			const left_is_producer = is_owned_heap_temp(node.left_value, status);
			const right_is_producer = is_owned_heap_temp(node.right_value, status);
			status.code += `({ nomen_string _nss_${id} = `;
			build_node(node.left_value, status);
			status.code += `; _nss_${id}.ptr ? ${left_is_producer ? "" : "nomen_str_dup("}_nss_${id}${left_is_producer ? "" : ")"}`;
			status.code += ` : ${right_is_producer ? "" : "nomen_str_dup("}(`;
			build_node(node.right_value, status);
			status.code += `)${right_is_producer ? "" : ")"}; })`;
		} else if (is_nullable_scalar_type(left_type, status)) {
			// Nullable scalar (`int? ?? fb`): the flag is `<expr>_has`. A
			// nullable scalar CALL on the LHS must be materialised ONCE (the
			// flag lives in the hidden `_ret_has` out-param) — hoist a value
			// temp + flag temp in a statement expression.
			if (
				node.left_value.node_type === "func_call" &&
				is_nullable_scalar_type((node.left_value as any).type, status)
			) {
				const id = ns_tmp_counter++;
				const flag = `_nsh_${id}`;
				const val = `_nsv_${id}`;
				const c_t = c_type(left_type.name);
				status.code += `({ unsigned char ${flag} = 0; ${c_t} ${val} = `;
				const old = status.current_nullable_call_flag;
				status.current_nullable_call_flag = flag;
				build_node(node.left_value, status);
				status.current_nullable_call_flag = old;
				status.code += `; ${flag} ? ${val} : `;
				build_node(node.right_value, status);
				status.code += `; })`;
			} else {
				status.code += `(`;
				status.code += build_nullable_has(node.left_value, status);
				status.code += ` ? `;
				build_node(node.left_value, status);
				status.code += ` : `;
				build_node(node.right_value, status);
				status.code += `)`;
			}
		} else if (is_nullable_struct_type(left_type, status)) {
			// Special case: a nullable struct function call on the LHS must be
			// materialised ONCE (calling it twice — once for the flag, once
			// for the value — would duplicate side effects and produce two
			// different return flags). Wrap in a GCC statement-expression that
			// hoists a value temp + flag temp, then yields the chosen value.
			if (
				node.left_value.node_type === "func_call" &&
				is_nullable_struct_type((node.left_value as any).type, status)
			) {
				const id = ns_tmp_counter++;
				const flag = `_nsh_${id}`;
				const val = `_nsv_${id}`;
				const type_name = left_type.name;
				status.code += `({ unsigned char ${flag} = 0; struct ${type_name} ${val} = `;
				const old = status.current_nullable_call_flag;
				status.current_nullable_call_flag = flag;
				build_node(node.left_value, status);
				status.current_nullable_call_flag = old;
				status.code += `; ${flag} ? ${val} : `;
				build_node(node.right_value, status);
				status.code += `; })`;
			} else {
				status.code += `(`;
				status.code += build_nullable_has(node.left_value, status);
				status.code += ` ? `;
				build_node(node.left_value, status);
				status.code += ` : `;
				build_node(node.right_value, status);
				status.code += `)`;
			}
		} else {
			status.code += `(`;
			build_node(node.left_value, status);
			status.code += ` ? `;
			build_node(node.left_value, status);
			status.code += ` : `;
			build_node(node.right_value, status);
			status.code += `)`;
		}
	} else if ((node.op === "==" || node.op === "!=") && is_null_comparison(node)) {
		// Nullable chaining (ERRORS_PLAN): `a?.b != null` is "every hop is
		// non-null"; `== null` is its negation.
		const chain_side = flatten_null_chain(node.left_value, (t, f) => {
			const st = status.structs.findLast((s) => s.name === t && !s.is_generic);
			return st?.fields.find((fld) => fld.name === f)?.type;
		})
			? node.left_value
			: flatten_null_chain(node.right_value, (t, f) => {
						const st = status.structs.findLast((s) => s.name === t && !s.is_generic);
						return st?.fields.find((fld) => fld.name === f)?.type;
				  })
				? node.right_value
				: undefined;
		if (chain_side) {
			const flat = flatten_null_chain(chain_side, (t, f) => {
				const st = status.structs.findLast((s) => s.name === t && !s.is_generic);
				return st?.fields.find((fld) => fld.name === f)?.type;
			})!;
			status.code += node.op === "==" ? `(!(` : `((`;
			status.code += emit_chain_tests(flat.hops, status);
			status.code += `))`;
			return;
		}
		// `x == null` / `x != null` against a nullable struct lowers to its
		// companion `_has` flag rather than comparing the struct value to 0.
		const left_is_nullable_string =
			type_from_value_node(node.left_value)?.is_nullable &&
			type_from_value_node(node.left_value)?.name === "string";
		const nullable_side = left_is_nullable_string
			? node.left_value
			: is_nullable_struct_side(node.left_value, status)
				? node.left_value
				: node.right_value;
		const type = type_from_value_node(nullable_side);
		// A nullable STRING is null iff its fat ptr half is NULL (the null
		// value is the in-band {NULL, 0} zero, no `_has` companion).
		if (type?.is_nullable && type.name === "string") {
			if (node.op === "==") status.code += `(!(`;
			else status.code += `((`;
			build_node(nullable_side, status);
			status.code += `.ptr != 0))`;
		} else if (
			is_nullable_scalar_type(type_from_value_node(nullable_side), status) &&
			type?.is_nullable &&
			type.name !== "string"
		) {
			// Nullable scalar: null is the companion `_has` flag, not a value
			// compare (0/false are real values).
			if (
				nullable_side.node_type === "func_call" &&
				is_nullable_scalar_type((nullable_side as any).type, status)
			) {
				const id = ns_tmp_counter++;
				const flag = `_nsh_${id}`;
				const val = `_nsv_${id}`;
				const c_t = c_type(type.name);
				status.code += `({ unsigned char ${flag} = 0; ${c_t} ${val} = `;
				const old = status.current_nullable_call_flag;
				status.current_nullable_call_flag = flag;
				build_node(nullable_side, status);
				status.current_nullable_call_flag = old;
				status.code += `; ${node.op === "==" ? `!${flag}` : `(${flag})`}; })`;
			} else {
				const has = build_nullable_has(nullable_side, status);
				// `== null` → !has ; `!= null` → has
				status.code += node.op === "==" ? `(!${has})` : `(${has})`;
			}
		} else if (is_nullable_struct_type(type, status)) {
			// A nullable struct CALL result must be materialised once
			// (calling twice would duplicate side effects). Wrap in a
			// statement-expression that exposes the flag.
			if (
				nullable_side.node_type === "func_call" &&
				is_nullable_struct_type((nullable_side as any).type, status)
			) {
				const id = ns_tmp_counter++;
				const flag = `_nsh_${id}`;
				const val = `_nsv_${id}`;
				const type_name = type.name;
				status.code += `({ unsigned char ${flag} = 0; struct ${type_name} ${val} = `;
				const old = status.current_nullable_call_flag;
				status.current_nullable_call_flag = flag;
				build_node(nullable_side, status);
				status.current_nullable_call_flag = old;
				status.code += `; ${node.op === "==" ? `!${flag}` : `(${flag})`}; })`;
			} else {
				const has = build_nullable_has(nullable_side, status);
				// `== null` → !has ; `!= null` → has
				status.code += node.op === "==" ? `(!${has})` : `(${has})`;
			}
		} else {
			build_default_binary(node, status);
		}
	} else if (
		(node.op === "==" || node.op === "!=") &&
		enum_with_data_side(node.left_value, node.right_value, status)
	) {
		// `==`/`!=` on an enum with associated data compares the TAG only:
		// the operands are structs (tag + payload union), so a plain `==`
		// would be a struct-vs-struct compare clang rejects. Mirrors `match`,
		// which also discriminates on the tag.
		const enum_node = enum_with_data_side(node.left_value, node.right_value, status)!;
		const left_case = static_enum_case(node.left_value, enum_node, status);
		const right_case = static_enum_case(node.right_value, enum_node, status);
		status.code += `(`;
		if (left_case && right_case) {
			status.code += `${enum_node.name}_${left_case} ${node.op} ${enum_node.name}_${right_case}`;
		} else if (left_case || right_case) {
			const case_name = (left_case ?? right_case)!;
			const value_side = left_case ? node.right_value : node.left_value;
			status.code += `(`;
			build_node(value_side, status);
			status.code += `).tag ${node.op} ${enum_node.name}_${case_name}`;
		} else {
			status.code += `(`;
			build_node(node.left_value, status);
			status.code += `).tag ${node.op} (`;
			build_node(node.right_value, status);
			status.code += `).tag`;
		}
		status.code += `)`;
	} else if (node.operator_func) {
		// Custom operator function call
		const label =
			node.operator_func.mangled_name ||
			`${node.operator_func.struct_name}_${node.operator_func.func_name}`;
		// A string comparison (`a == b`) with a VIEW operand must NOT dispatch
		// to string_eq/strcmp: a view into the middle of a buffer is not
		// NUL-terminated, and its nomen_view struct doesn't fit the char*
		// signature. Compare as slices: equal lengths + equal bytes. An owned
		// operand is measured with strlen for the comparison (no copy).
		const is_string_cmp = node.op === "==" || node.op === "!=";
		if (
			is_string_cmp &&
			node.operator_func.struct_name === "string" &&
			(is_view_value(node.left_value, status) || is_view_value(node.right_value, status))
		) {
			status.code += `({ nomen_view _a = `;
			c_view_string_arg(node.left_value, status);
			status.code += `, _b = `;
			c_view_string_arg(node.right_value, status);
			status.code += `; ((_a.len == _b.len) && (memcmp(_a.ptr, _b.ptr, _a.len) == 0))${
				node.op === "!=" ? " == 0" : ""
			}; })`;
			return;
		}
		// String concat/repeat (`a + b`, `s * n`): if an operand is itself a
		// freshly-allocated heap string temp (a nested string op or a
		// heap-returning call), it is never bound to a variable and would leak
		// once the operator has consumed it. Emit a statement-expression that
		// captures each such temp, runs the operator, frees the temps, and
		// yields the result. Mirrors the aarch64 backend's is_owned_heap_temp
		// spill-and-free. (Builds link with clang, which supports GNU
		// statement expressions.)
		const is_string_op = node.type?.name === "string";
		// A string comparison (`a == b`, dispatched to String's #op_eq /
		// strcmp) with a heap-temp operand leaks the same way: the strdup'd
		// call result is consumed by strcmp and never freed. Spill-and-free
		// those too (result type differs: the op yields bool, not char*).
		const left_temp =
			(is_string_op || is_string_cmp) && is_owned_heap_temp(node.left_value, status);
		const right_temp =
			(is_string_op || is_string_cmp) && is_owned_heap_temp(node.right_value, status);
		if (left_temp || right_temp) {
			const id = (status.label_counter = (status.label_counter ?? 0) + 1);
			const lt = `_ltmp_${id}`;
			const rt = `_rtmp_${id}`;
			const cres = `_cres_${id}`;
			status.code += `({ `;
			status.code += `nomen_string ${lt} = `;
			build_operand(node.left_value, status);
			status.code += `; nomen_string ${rt} = `;
			build_operand(node.right_value, status);
			status.code += `; `;
			if (is_string_op) {
				status.code += `nomen_string ${cres} = ${label}(${lt}, ${rt}); `;
			} else {
				status.code += `int ${cres} = ${label}(${lt}, ${rt}); `;
			}
			if (left_temp) status.code += `free(${lt}.ptr); `;
			if (right_temp) status.code += `free(${rt}.ptr); `;
			// `!=` dispatched to the struct's `eq` (or `==` to `ne`): invert
			// the call result — same as the non-spill path below. Without
			// this, `x != y` with a heap-temp operand evaluated as `==`.
			if (!is_string_op && node.operator_func.invert) {
				status.code += `!${cres}; })`;
			} else {
				status.code += `${cres}; })`;
			}
		} else {
			const is_array_op =
				node.operator_func.struct_name.startsWith("Array") &&
				(type_from_value_node(node.left_value).is_array ||
					type_from_value_node(node.right_value).is_array);
			// `!=` dispatched to a struct's `eq` (or `==` to `ne`): wrap the
			// call result in a logical NOT.
			if (node.operator_func.invert) status.code += `(!`;
			if (is_array_op) {
				status.code += `${label}(`;
				build_array_operand_for_call(node.left_value, status);
				status.code += ", ";
				build_array_operand_for_call(node.right_value, status);
				status.code += ")";
			} else {
				status.code += `${label}(`;
				build_operand(node.left_value, status);
				status.code += ", ";
				build_operand(node.right_value, status);
				status.code += ")";
			}
			if (node.operator_func.invert) status.code += `)`;
		}
	} else {
		build_default_binary(node, status);
	}
}

/**
 * Whether an operand produces a fresh heap string that is safe to free once a
 * string operator has consumed it: a nested string op (`a + b`), a string
 * interpolation, a `*_to_string` call, or a call registered in
 * heap_returning_functions. Variables, literals and arbitrary calls are NOT
 * freed here — they may be static or owned elsewhere. Mirrors the aarch64
 * backend's is_owned_heap_temp.
 */
export function is_owned_heap_temp(
	node: import("../nodes/BaseNode.ts").default,
	status: BuildStatus,
): boolean {
	let check_node = node;
	// A parenthesized operand `("a" + "b")` wraps the inner expression in a
	// grouped node — the classification below keys on node_type, so a
	// grouped owned temp escaped the spill-and-free. Unwrap first (mirrors
	// the aarch64 classifier).
	while (check_node.node_type === "grouped") {
		check_node = (check_node as unknown as { value: import("../nodes/BaseNode.ts").default }).value;
	}
	let target_value: string | undefined;
	let target_type_name: string | undefined;
	let type_name = (check_node as { type?: { name?: string } }).type?.name;
	if (check_node.node_type === "access") {
		const access = check_node as unknown as {
			access?: { node_type?: string; type?: { name?: string }; name?: string };
			target?: { value?: string; type?: { name?: string } };
		};
		if (access.access?.node_type !== "access_func") return false;
		target_value = access.target?.value;
		target_type_name = access.target?.type?.name;
		if (!target_type_name && (check_node as any).target) {
			try {
				target_type_name = type_from_value_node((check_node as any).target)?.name;
			} catch {
				target_type_name = undefined;
			}
		}
		check_node = access.access as unknown as import("../nodes/BaseNode.ts").default;
		// The result type may be recorded on the inner access_func node or on
		// the outer AccessNode — fall back to the latter.
		type_name = access.access?.type?.name || type_name;
	}
	// A borrow-position `to_string()` (STRING_PLAN tranche 3) passes the
	// receiver's pair through — it is a borrow of the caller's string, not an
	// owned temp, so the operator must not free it after consuming it.
	if ((check_node as unknown as { borrow_to_string?: boolean }).borrow_to_string) return false;
	if (type_name !== "string") return false;
	if (check_node.node_type === "op") return true;
	if (check_node.node_type === "func_call" || check_node.node_type === "access_func") {
		const raw_name = (check_node as unknown as { name: string }).name;
		const mangled = (check_node as unknown as { mangled_name?: string }).mangled_name || raw_name;
		if (mangled.startsWith("_string_interpolate_")) return true;
		if (mangled.endsWith("_to_string") && mangled !== "string_to_string") return true;
		// A bare `.to_string()` on a non-string target (emitted as
		// `<type>_to_string`) returns a fresh owned heap string; the AST method
		// name lacks the type prefix, so match via the target's type.
		if (raw_name === "to_string" && target_type_name && target_type_name !== "string") return true;
		const heap_set = status.heap_returning_functions;
		if (heap_set?.has(mangled)) return true;
		if (heap_set && target_value && heap_set.has(`${target_value}_${raw_name}`)) return true;
		// A method call `obj.method()` is mangled as `<StructType>_method`
		// (e.g. `Frank_hello`) in heap_returning_functions. The receiver's
		// struct type name lets us reconstruct that mangled name.
		if (heap_set && target_type_name && heap_set.has(`${target_type_name}_${raw_name}`))
			return true;
		// The C backend strdup's EVERY string return (see build_return_node),
		// so any string-returning call produces an owned heap string — even
		// when the mangled name couldn't be matched (e.g. a trait default
		// method resolved as `<Trait>_<method>` rather than
		// `<Struct>_<method>`). The only string calls that are NOT owned are
		// borrows: `.at()`/`.first()`/`.load_T()` return a pointer into (or
		// the slot value of) the receiver's storage rather than a fresh
		// allocation — Buffer.load_T is a raw #arch method that returns the
		// element slot directly, and the buffer still owns it.
		const is_borrow =
			check_node.node_type === "access_func" &&
			(raw_name === "at" || raw_name === "first" || raw_name === "load") &&
			!(check_node as unknown as { owned_return?: boolean }).owned_return;
		return !is_borrow;
	}
	return false;
}

function build_default_binary(node: OperationNode, status: BuildStatus) {
	// Float remainder: C has no `%` for floating types. Lower to the libm
	// `fmod` call — truncated semantics, matching the integer `%` sign
	// rule. `<math.h>` is in the prelude and libm is linked.
	const left_is_float = is_float_type(type_from_value_node(node.left_value)?.name ?? "");
	const right_is_float = is_float_type(type_from_value_node(node.right_value)?.name ?? "");
	if (node.op === "%" && (left_is_float || right_is_float)) {
		status.code += `fmod(`;
		build_node(node.left_value, status);
		status.code += `, `;
		build_node(node.right_value, status);
		status.code += `)`;
		return;
	}
	// Wrap binary operations in parens so C's precedence can't misinterpret
	// them when they're nested as operands of other expressions.
	status.code += `(`;
	build_node(node.left_value, status);
	status.code += ` ${node.op} `;
	build_node(node.right_value, status);
	status.code += `)`;
}

/** True if one side of an ==/!= is the `null` literal. */
function is_null_comparison(node: OperationNode): boolean {
	const l = node.left_value;
	const r = node.right_value;
	const l_null = l.node_type === "value" && (l as ValueNode).value === "null";
	const r_null = r.node_type === "value" && (r as ValueNode).value === "null";
	return l_null || r_null;
}

function is_nullable_struct_side(node: any, status: BuildStatus): boolean {
	const t = type_from_value_node(node);
	return is_nullable_struct_type(t, status) || is_nullable_scalar_type(t, status);
}

/**
 * Build the companion `_has` flag expression for a nullable-struct or
 * nullable-scalar lvalue by building the lvalue's C expression and appending
 * `_has`. This works because every such lvalue (a bare variable or a
 * `.field`/`->field` access) ends in an identifier.
 *
 * Special case: a nullable PARAMETER (`T? p` — struct or scalar) lowers to
 * TWO C parameters (`T *p, unsigned char p_has` for structs; `T p, unsigned
 * char p_has` for scalars). The flag lives in a sibling parameter named
 * `<pname>_has`, not derived from the value parameter. Detect this case and
 * emit the bare `<pname>_has` identifier — building the lvalue and appending
 * `_has` would give the syntactically wrong `(*p)_has` / `p_has` misread.
 */
function build_nullable_has(node: any, status: BuildStatus): string {
	if (node.node_type === "value") {
		const name = node.value;
		// A nullable parameter's flag is the sibling `<pname>_has` C
		// parameter (not the value's).
		if (
			status.function_ref_params?.has(name) &&
			(is_nullable_struct_type(node.type, status) || is_nullable_scalar_type(node.type, status))
		) {
			return has_flag_name(name);
		}
		// A nullable LOCAL's flag is the sibling `<name>_has` C variable
		// emitted in build_declaration_node.
		if (is_nullable_struct_type(node.type, status) || is_nullable_scalar_type(node.type, status)) {
			return has_flag_name(name);
		}
	}
	const saved = begin_code_scratch(status);
	build_node(node, status);
	const expr = end_code_scratch(status, saved);
	return `${expr}_has`;
}

function build_operand(node: any, status: BuildStatus) {
	const param_type = type_from_value_node(node);
	const is_struct =
		status.structs.find((s) => s.name === param_type.name && !s.is_simple_type) ||
		status.traits.find((t) => t.name === param_type.name);
	if (!is_struct) {
		build_node(node, status);
		return;
	}
	// Struct/trait operands are passed by address. Only a genuine C lvalue can
	// be addressed directly: a variable or a FIELD access. A method-call result
	// (`self.slots.load(idx)`, a heap `Array<T>` mono `.at(i)`) is an RVALUE
	// struct in C — `&<call>` is invalid ("cannot take the address of an
	// rvalue"), so materialize it into a temporary first via a GCC
	// statement-expression. (Only the C backend needs this: the aarch64 struct
	// value convention hands a call result back as its address already.)
	// Everything else — a fresh constructor, an arithmetic result, a cast, or
	// any method call — is likewise materialized.
	const is_field_access =
		node.node_type === "access" && (node as AccessNode).access?.node_type === "access_field";
	const is_lvalue =
		node.node_type === "value" || node.node_type === "access_field" || is_field_access;
	if (is_lvalue) {
		status.code += `&`;
		build_node(node, status);
	} else {
		const tag = param_type.name;
		status.code += `({ ${tag} _op_tmp = `;
		build_node(node, status);
		status.code += `; &_op_tmp; })`;
	}
}

/**
 * Build an operand for an Array operator call. Stack arrays and inline array
 * literals are wrapped in a temporary `struct Array_int` header so the
 * monomorphized C function receives a proper `struct Array_int*` pointer.
 * Heap arrays (already `struct Array_int*`) are passed by address as usual.
 */
function build_array_operand_for_call(node: any, status: BuildStatus) {
	const param_type = type_from_value_node(node);
	const is_heap_array =
		node.node_type === "value" && status.heap_array_vars?.has((node as ValueNode).value);
	if (is_heap_array) {
		build_operand(node, status);
		return;
	}
	const is_stack_array =
		param_type.is_array &&
		node.node_type === "value" &&
		!status.heap_array_vars?.has((node as ValueNode).value);
	const is_inline_literal = node.node_type === "array";
	if (!is_stack_array && !is_inline_literal) {
		build_operand(node, status);
		return;
	}
	const elem_c_type = c_type(param_type.name);
	let length: string;
	if (is_stack_array) {
		length = status.stack_array_lengths?.get((node as ValueNode).value) || "1";
	} else {
		length = String((node as ArrayValuesNode).values.length);
	}
	// Fallback: use compile-time type length if available
	if (length === "1" && param_type.length) {
		const saved = begin_code_scratch(status);
		build_node(param_type.length, status);
		length = end_code_scratch(status, saved);
	}
	const id = (status.label_counter = (status.label_counter ?? 0) + 1);
	const wrap = `_arrwrap_${id}`;
	status.code += `({ struct { struct Array_int _h; ${elem_c_type} _d[${length}]; } ${wrap}; `;
	status.code += `${wrap}._h._vt = 0; ${wrap}._h.length = ${length}; `;
	if (is_stack_array) {
		status.code += `memcpy(${wrap}._d, ${(node as ValueNode).value}, ${length} * sizeof(${elem_c_type})); `;
	} else {
		const values = (node as ArrayValuesNode).values;
		for (let i = 0; i < values.length; i++) {
			status.code += `${wrap}._d[${i}] = `;
			build_node(values[i], status);
			status.code += `; `;
		}
	}
	status.code += `(struct Array_int*)&${wrap}; })`;
}

let ns_tmp_counter = 0;
export function reset_ns_tmp_counter() {
	ns_tmp_counter = 0;
}
