import { is_interp_name, parse_interp_name } from "../check/utils/interp_arg_kinds.ts";
import type FunctionCallNode from "../nodes/FunctionCallNode.ts";
import { expr } from "./build_node.ts";
import { struct_init_expression, struct_zero_object } from "./build_struct_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import call_with_refs from "./call_with_refs.ts";
import { enum_case_value, find_enum_case } from "./enums.ts";
import { library_constructor } from "./library.ts";
import {
	is_native_library_type,
	library_method_label,
	queue_library_function,
	queue_library_init,
	queue_library_method,
	zero_js_value,
} from "./library_queue.ts";
import { function_label, init_label } from "./names.ts";

/**
 * Emit a JS expression for a call node:
 *  - interpolation helpers (`_string_interpolate_N[_kinds]`) → `__interp`;
 *  - enum case constructions → tagged object literals;
 *  - struct constructors → the `<Struct>_init` factory;
 *  - library containers (List/Map/Box/StringBuilder) → their JS values;
 *  - free/nested functions → the checker's emission label (with `ref`
 *    arguments boxed and copied back).
 */
export default function build_function_call_node(
	node: FunctionCallNode,
	status: BuildStatus,
): string {
	const name = node.name;

	// `Thread(fn(args))` / `Fiber(fn(args))`: the native construction packs a
	// deferred call. JS has no scheduler, so the thunk is stored and run
	// synchronously by `.start()` / `.detach()` (see the runtime helpers).
	if (node.is_thread_ctor || node.is_fiber_ctor) {
		const first = node.params[0];
		const call =
			first?.node_type === "func_call"
				? `() => (${expr(first, status)})`
				: `() => (${expr(first, status)}())`;
		return `({ __task: ${call}, __result: undefined, __zero: ${zero_js_value(
			node.function_return_type,
		)}, __done: false, started: false, $type: __spawn_methods })`;
	}

	if (is_interp_name(name)) {
		const { kinds } = parse_interp_name(name);
		const pattern = expr(node.params[0], status);
		const args = node.params.slice(1).map((p) => expr(p, status));
		const kind_string = kinds ? kinds.join("") : "s".repeat(args.length);
		const rest = args.length ? `, ${args.join(", ")}` : "";
		return `__interp(${pattern}, "${kind_string}"${rest})`;
	}

	// Enum case construction, including the shorthand `.ok(x)` the checker
	// rewrites to the flattened `Enum_case` name.
	if ((node as unknown as { is_enum_shorthand?: boolean }).is_enum_shorthand) {
		const args = node.params.map((p) => expr(p, status));
		const hit = find_enum_case(status.enums, name);
		if (hit) return enum_case_value(hit.enum_node, hit.case_index, args, status);
		const enum_node = status.enums.find((e) => e.name === node.type?.name);
		if (enum_node) {
			const case_name = name.replace(/^\./, "").replace(`${enum_node.name}_`, "");
			const case_index = enum_node.cases.findIndex((c) => c.name === case_name);
			if (case_index !== -1) return enum_case_value(enum_node, case_index, args, status);
		}
	}

	const struct = status.structs.find((s) => s.name === name);
	if (struct) {
		const args = node.params.map((p) => expr(p, status));
		// A user `#init` constructor: build the zeroed object and run the
		// resolved init body (the field-based factory skips the body).
		if (node.resolved_function?.name === "#init" && init_has_self(node.resolved_function)) {
			const inits = struct.functions.filter(
				(func) => func.name === "#init" && func.has_body && !func.is_generic && init_has_self(func),
			);
			const index = inits.indexOf(node.resolved_function);
			if (index !== -1) return struct_init_expression(struct, index, args, status);
		}
		return `${node.mangled_name ?? init_label(name)}(${args.join(", ")})`;
	}

	// Library containers (List/Map/Box/StringBuilder) map onto JS values.
	const args = node.params.map((p) => expr(p, status));
	const library = library_constructor(name, args);
	if (library !== undefined) return library;

	// A System-library struct constructed from Nomen code is lowered on
	// demand (its checked body is ordinary Nomen). Natively modeled types
	// (List/Map/StringBuilder/…) are handled above; primitives never get here.
	const library_struct = status.library_structs.find(
		(s) => s.name === name && !is_native_library_type(s.name),
	);
	if (library_struct) {
		// A user-declared `#init` body runs from a construction IIFE. A
		// synthesized positional `#init` (no `self`) is the field factory.
		if (node.resolved_function?.name === "#init" && init_has_self(node.resolved_function)) {
			queue_library_method(library_struct, node.resolved_function, status);
			const label = library_method_label(library_struct, node.resolved_function);
			const args_text = args.length ? `, ${args.join(", ")}` : "";
			return `(() => { const __self = ${struct_zero_object(
				library_struct,
				status,
				false,
			)}; ${label}(__self${args_text}); return __self; })()`;
		}
		queue_library_init(library_struct, status);
		return `${init_label(name)}(${args.join(", ")})`;
	}

	// The C library's decimal parser is a trivial native helper.
	if (name === "parse_int" && args.length === 1) return `__parse_int(${args[0]})`;

	// A free library function: emit its body on demand.
	if (node.resolved_function?.is_library) queue_library_function(node.resolved_function, status);

	// A free (or nested) function call: `ref` arguments are boxed and copied
	// back by the wrapper.
	const label = function_label(node.resolved_function ?? node);
	return call_with_refs(
		status,
		node.params,
		node.ref_param_indices,
		(arg_exprs) => `${label}(${arg_exprs.join(", ")})`,
	);
}

/** A hand-written `#init` takes `self`; the checker's synthesized positional
 *  initializer (`#init = (field, …)`) does not, and the field factory covers
 *  it. */
function init_has_self(func: { params?: { is_self_param?: boolean }[] }): boolean {
	return func.params?.[0]?.is_self_param === true;
}
