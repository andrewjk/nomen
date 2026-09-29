import AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import Type from "../nodes/Type.ts";
import { direct_string_fields } from "./has_string_fields.ts";
import { mono_type_name } from "./mono_name.ts";
import { is_container_borrow_accessor_name } from "./string_return_analysis.ts";

/**
 * The struct table + record set both backends' BuildStatus satisfy for the
 * call-init string-field recording.
 */
interface RecordTable {
	structs: {
		name: string;
		is_class?: boolean;
		is_simple_type?: boolean;
		fields: { name: string; type: Type }[];
	}[];
	heap_string_fields?: Set<string>;
	normalized_struct_returners?: Set<string>;
}

/**
 * Whether a declaration-initializer expression is a value the callee's
 * return-boundary normalization made UNIFORMLY heap-owned, so the fresh
 * binding records every string field and frees them at scope exit:
 *
 *   - a plain function call registered as a normalized struct returner
 *     (the registry is populated at the callee's return sites — a callee
 *     built later, or one that returns slot borrows, is not registered and
 *     the binding keeps the pre-existing borrow behavior);
 *   - an owned accessor (`pop`/`move_T`/`copy`) — move-out semantics
 *     transfer slot-owned heap buffers to the binding.
 *
 * NOT normalized (never recorded): struct constructions (`Info(...)` — its
 * `#init` leaves rodata borrows and bypasses the return path) and container
 * BORROW accessors (`.at`/`.first`/`.slice`/`load` — the slot keeps
 * ownership; recording would free the container's storage).
 */
export function is_normalized_struct_call(
	value: BaseNode | undefined | null,
	status: {
		structs: { name: string }[];
		normalized_struct_returners?: Set<string>;
	},
): boolean {
	if (!value) return false;
	// A base-bearing anonymous struct literal (`[ .. make(), f = v ]`) is
	// ownership-wise its BASE: the destination receives a byte copy of the
	// base's uniformly heap-owned fields (the overrides replace fields after
	// the copy and reclaim through their own assignment path).
	if (value.node_type === "anon_struct") {
		const base = (value as unknown as { base?: BaseNode }).base;
		if (!base) return false;
		value = base;
	}
	if (value.node_type === "func_call") {
		const call = value as FunctionCallNode;
		// Struct constructions resolve to the struct's `#init`, which bypasses
		// the return path and never registers — the registry check excludes
		// them implicitly.
		return !!status.normalized_struct_returners?.has(call.name);
	}
	if (value.node_type === "access") {
		const access = (value as AccessNode).access;
		if (access?.node_type !== "access_func") return false;
		const name = (access as { name?: string }).name ?? "";
		// A container BORROW accessor (`at`/`first`/`slice`/`load`) yields a
		// view into the container's slot — the slot owns the heap buffers, so
		// the binding is a borrow and must NOT record. An owned accessor
		// records only when the callee registered as a normalizing returner:
		// a `move_T`-based `pop` transfers slot-owned buffers (sound to free)
		// but its generic body is not classified, so it stays unrecorded —
		// the pre-existing status quo (the moved-out buffers leak).
		if (is_container_borrow_accessor_name(name)) return false;
		if (status.normalized_struct_returners?.has(name)) return true;
		// A METHOD call (`a.copy()`) registers under its emission label
		// `<Receiver>_copy` (methods are per-struct symbols, so the bare
		// method name would conflate unrelated types' methods). Resolve the
		// receiver's stamped type to the mono name and look the label up.
		const target = (value as AccessNode).target;
		const receiver_type = target
			? ((target as unknown as { type?: Type }).type ?? undefined)
			: undefined;
		if (receiver_type?.name) {
			const label = `${mono_type_name(receiver_type)}_${name}`;
			if (status.normalized_struct_returners?.has(label)) return true;
		}
		return false;
	}
	return false;
}

/**
 * Record every direct string field of a call-initialized value-struct
 * binding (`var Info i = make()`) as heap-owned: the callee's return
 * normalization guarantees each field is a heap buffer, so scope-exit
 * auto_free must free them, and a later `i.field = …` write sees
 * old_was_heap and reclaims the displaced buffer instead of leaking it.
 * No-op for non-struct, class, view, and array types, for structs without
 * direct string fields, and for non-call initializers.
 */
export function record_call_init_string_fields(
	node: { name: string; type?: Type; value?: BaseNode | null },
	status: RecordTable,
): void {
	if (!is_normalized_struct_call(node.value, status)) return;
	const type = node.type;
	if (!type?.name) return;
	const mono_name = mono_type_name(type);
	// Tuple temporaries are excluded: the destructuring lowering binds the
	// destructured variables as BORROWS of the temp's fields, and those
	// bindings' own cleanup reclaims them (a recorded field here would
	// double-free).
	if (mono_name.startsWith("_Tuple_")) return;
	const struct = status.structs.find((s) => s.name === mono_name && !s.is_simple_type);
	if (!struct || struct.is_class) return;
	const fields = direct_string_fields(struct as never);
	if (!fields.length) return;
	if (!status.heap_string_fields) status.heap_string_fields = new Set<string>();
	// Records are keyed by the RAW Nomen variable name (the free/lookup
	// paths mangle for emission themselves).
	for (const field of fields) {
		status.heap_string_fields.add(`${node.name}.${field.name}`);
	}
}
