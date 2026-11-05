import { CASE_CAST_PANIC_MESSAGE } from "../check/utils/case_enum.ts";
import CastNode from "../nodes/CastNode.ts";
import { pointer_element_c_type } from "./build_index_node.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";
import c_type from "./utils/c_type.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_cast_node(node: CastNode, status: BuildStatus) {
	// If the cast has an operator function (#op_as), emit a function call
	if (node.operator_func) {
		const { struct_name, func_name, mangled_name } = node.operator_func;
		const call_name = mangled_name || `${struct_name}_${c_function_name(func_name)}`;
		const source_type = type_from_value_node(node.value).name;
		const source_struct = status.structs.find((s) => s.name === source_type && !s.is_simple_type);
		status.code += `${call_name}(`;
		if (source_struct) {
			status.code += `&`;
		}
		build_node(node.value, status);
		status.code += `)`;
		return;
	}

	// BASE↔CASE enum cast (PERF_PLAN item 13(3), the checked case cast) —
	// stamped by check_cast_node. Lowered as a GCC statement expression (the
	// match lowering already emits `({ ... })`): build the value into a temp
	// of its own type, then produce the result as a COPY — the source keeps
	// ownership (`<Enum>_copy` deep-copies the active case's payloads; no
	// move-zero, no moved stamping). `base_to_case` compares the value's tag
	// against the case's ORIGINAL declaration index first and panics on
	// variant mismatch — printf + exit, the build_panic_node shape. A
	// zero-payload case is a bare tag word on both sides (no `.tag` field,
	// no copy function): narrowing compares the word itself, widening is the
	// same bits. Function scope only: the statement expression needs a
	// block; the checker rejects nothing here, so a non-function position
	// falls through to the generic cast.
	if (node.enum_case_conversion && status.current_function) {
		const from_type = type_from_value_node(node.value);
		const direction = node.enum_case_conversion.direction;
		const mono_name = direction === "base_to_case" ? node.target_type.name : from_type.name;
		const mono = status.enums.find((e) => e.name === mono_name && e.is_case_mono);
		const parent = mono?.parent_enum;
		const parent_enum = parent ? status.enums.find((e) => e.name === parent) : undefined;
		if (mono && parent_enum) {
			const id = (status.label_counter = (status.label_counter ?? 0) + 1);
			const temp = `_ecast_${id}`;
			const mono_c = c_type(mono.name);
			const parent_c = c_type(parent!);
			// The temp carries the VALUE's own type: the parent for the
			// narrowing direction, the mono for the widening direction.
			const src_c = direction === "base_to_case" ? parent_c : mono_c;
			const dst_c = direction === "base_to_case" ? mono_c : parent_c;
			status.code += `({ ${src_c} ${temp} = `;
			build_node(node.value, status);
			status.code += `;\n`;
			if (direction === "base_to_case") {
				// The tag constant is the BASE enum's (`Res_ok` — plain, never
				// typedef-mangled); the mono value's tag equals it (tag_index).
				const tag_constant = `${parent}_${mono.cases[0]?.name ?? ""}`;
				const tag_expr = parent_enum.has_associated_data ? `${temp}.tag` : temp;
				status.code += `if (${tag_expr} != ${tag_constant}) { printf("${CASE_CAST_PANIC_MESSAGE}\\n"); exit(EXIT_FAILURE); }\n`;
				if (parent_enum.has_associated_data) {
					status.code += `${dst_c}_copy(*(${dst_c} *)&${temp}); })\n`;
				} else {
					status.code += `(${dst_c})${temp}; })\n`;
				}
			} else {
				if (parent_enum.has_associated_data) {
					// Zero the widening temp first so the base copy's tail (the
					// padding the tag-driven reads never touch) is deterministic.
					status.code += `${dst_c} _w; memset(&_w, 0, sizeof(_w)); memcpy(&_w, &${temp}, sizeof(${src_c}));\n`;
					status.code += `${dst_c}_copy(_w); })\n`;
				} else {
					status.code += `(${dst_c})${temp}; })\n`;
				}
			}
			return;
		}
	}

	// `unsafe` pointer casts (checker-gated): integer ↔ `ptr T`, and
	// `string` → `ptr char` (the fat value's data pointer).
	const value_type = type_from_value_node(node.value);
	if (node.target_type.is_pointer || value_type.is_pointer) {
		if (node.target_type.is_pointer) {
			status.code += `(${pointer_element_c_type(node.target_type, status)}*)`;
			if (value_type.name === "string" && !value_type.is_pointer) {
				// Fat string → its backing bytes: the thin pointer inside the
				// nomen_string value (or behind the ref-self pointer — the
				// natural `*self` deref comes from build_value_node).
				status.code += `(`;
				build_node(node.value, status);
				status.code += `).ptr`;
				return;
			}
			build_node(node.value, status);
			return;
		}
		// Pointer → integer: same bits, reinterpreted. A struct/class pointer
		// (`self as uint64`) must emit the POINTER (`self`), not a deref'd
		// struct lvalue — suppress the value-node deref.
		status.code += `(${c_type(node.target_type.name)})`;
		status.suppress_dereference = true;
		build_node(node.value, status);
		status.suppress_dereference = false;
		return;
	}

	const is_struct = !!status.structs.find(
		(s) => s.name === node.target_type.name && !s.is_simple_type,
	);
	const prefix = is_struct ? "struct " : "";

	// Casting a literal zero to a value struct (e.g. the core library's
	// generic `return 0` zero-value in Map.get with TV = struct): emit a
	// zero-initialized compound literal instead of an int cast — C rejects
	// `(struct X)0`.
	if (is_struct && !node.target_type.is_ref) {
		const value = node.value;
		if (value.node_type === "value" && (value as { value?: string }).value === "0") {
			status.code += `(${prefix}${c_type(node.target_type.name)}){0}`;
			return;
		}
	}

	status.code += `(${prefix}${c_type(node.target_type.name)})`;
	build_node(node.value, status);
}
