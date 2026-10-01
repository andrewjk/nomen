import type BaseNode from "../nodes/BaseNode.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import scan_ref_param_string_field_writes, {
	ref_param_entry_dup_fields,
} from "./scan_ref_string_writes.ts";

/**
 * The add-direction mirror of drop_self_written_string_field_records: at a
 * call site whose callee takes a `ref` value-struct parameter, the callee's
 * string-field stores write through to the CALLER's variable — but the
 * callee's heap_string_fields records are scope-local and die at return, so
 * the stored copy would leak. Transfer the callee's definitely-executed
 * stores (scan_ref_param_string_field_writes) onto the caller's records for
 * the argument variable, making the caller's scope exit free them.
 *
 * The callee's CONDITIONAL stores transfer too
 * (ref_param_entry_dup_fields): the callee's builder entry-dups those
 * fields (`field = strdup(field)` at entry, recorded), so the field is
 * heap-owned on EVERY path out of the call — the not-taken path holds the
 * dup — and a caller-side record is sound.
 *
 * `arg_is_trackable_local` must report true only for variables whose storage
 * THIS function's scope exit owns — a plain local. A `ref` param of the
 * enclosing function forwards caller storage, so a record here would free the
 * ORIGINAL caller's field at the wrong scope's exit.
 */
export function transfer_ref_param_field_records(
	callee: FunctionNode,
	args: BaseNode[],
	status: {
		structs: import("../nodes/StructNode.ts").default[];
		heap_string_fields?: Set<string>;
	},
	arg_is_trackable_local: (name: string) => boolean,
): void {
	const writes = scan_ref_param_string_field_writes(callee, status.structs);
	const dups = ref_param_entry_dup_fields(callee, status.structs);
	if (!writes.size && !dups.size) return;
	const non_self_params = (callee.params ?? []).filter((p) => !p.is_self_param);
	for (let i = 0; i < args.length && i < non_self_params.length; i++) {
		const param = non_self_params[i];
		if (!(param.is_ref || param.type.is_ref)) continue;
		const fields = writes.get(param.name);
		const dup_fields = dups.get(param.name);
		if (!fields?.size && !dup_fields?.size) continue;
		const arg = args[i];
		if (arg?.node_type !== "value") continue;
		const name = (arg as ValueNode).value;
		if (!name || !arg_is_trackable_local(name)) continue;
		if (!status.heap_string_fields) status.heap_string_fields = new Set<string>();
		for (const field of fields ?? []) {
			status.heap_string_fields.add(`${name}.${field}`);
		}
		for (const field of dup_fields ?? []) {
			status.heap_string_fields.add(`${name}.${field}`);
		}
	}
}
