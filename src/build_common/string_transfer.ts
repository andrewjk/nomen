import type FunctionNode from "../nodes/FunctionNode.ts";
import type ParameterNode from "../nodes/ParameterNode.ts";
import type StructNode from "../nodes/StructNode.ts";

/**
 * Whether `fn` is a monomorphized clone of a GENERIC body. Its `mv T`
 * parameters were checked against the generic `T`, where the string-transfer
 * convention is invisible — the body is written for the generic copy
 * convention (`Buffer<T>.store(i, mv T value)` may forward the same value
 * twice, e.g.), so when `T` instantiates to `string` those parameters keep
 * the copy convention. Generic monos are recognized by their owner struct's
 * recorded `source_type_args` (methods) or by a surviving `type_params` list
 * (free generic bodies).
 */
export function function_is_generic_mono(fn: FunctionNode | undefined): boolean {
	if (!fn) return false;
	if (fn.type_params?.length) return true;
	const scope = fn.scope as (StructNode & { type_params?: string[] }) | undefined;
	// `source_type_args`: a MATERIALIZED mono struct. `type_params`: the
	// generic TEMPLATE (check-time calls resolve to the template with the
	// type args substituted in place, before the mono clone exists).
	return !!scope?.source_type_args?.length || !!scope?.type_params?.length;
}

/**
 * D3 string-transfer convention: whether `fn`'s parameter `param` takes a
 * `mv string` argument as an OWNERSHIP TRANSFER (the callee owns the pair,
 * frees it at its exit, and a consuming `field = mv p` store takes it raw).
 *
 * The convention's exceptions, all deliberate:
 *   - `#init` (auto or custom) keeps the constructor copy convention — its
 *     compiler-stamped `mv string` params strdup into the owned fields, so
 *     the call passes the value raw and no param teardown exists to receive
 *     a transfer.
 *   - generic bodies (and their monos) keep the copy convention — their
 *     `mv T` params were checked against `T` (see function_is_generic_mono).
 *   - nullable strings (`string?`) keep the copy convention: the in-band
 *     null makes "owns a buffer" conditional, and the field stores already
 *     handle the null pair.
 */
export function param_is_string_transfer(
	fn: FunctionNode | undefined,
	param: ParameterNode | undefined,
): boolean {
	if (!param?.is_moved || fn?.name === "#init" || function_is_generic_mono(fn)) return false;
	return (
		param.type.name === "string" &&
		!param.type.is_view &&
		!param.type.is_array &&
		!param.type.is_ref &&
		!param.type.is_nullable
	);
}
