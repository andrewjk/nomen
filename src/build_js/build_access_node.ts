import { mono_type_name } from "../build_common/mono_name.ts";
import { get_built_in_type } from "../built_in_types.ts";
import type AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import type AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import { expr } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import call_with_refs from "./call_with_refs.ts";
import { enum_case_value } from "./enums.ts";
import {
	bigint_method,
	buffer_method,
	is_buffer_type,
	is_class_buffer_type,
	library_base_name,
	list_method,
	map_method,
	set_method,
	stable_list_method,
	string_builder_method,
} from "./library.ts";
import { is_native_library_type, library_method, library_method_call } from "./library_queue.ts";
import { method_label } from "./names.ts";
import { copy_if_value_struct, stamped_type } from "./types.ts";
import { kind_of, type_name_of } from "./types.ts";

/**
 * Emit a JS expression for a member access:
 *  - field access → `obj.field`;
 *  - static library calls (`Console.write`, `Format.pad`, …) → runtime helpers;
 *  - string/array builtins → the native JS equivalents;
 *  - the supported System containers (List/Map/StringBuilder) → their JS
 *    representations;
 *  - user struct methods → `<Struct>_<method>(self, args…)`.
 * Anything outside the supported subset becomes a loud runtime error.
 */
export default function build_access_node(node: AccessNode, status: BuildStatus): string {
	const access = node.access;
	if (access.node_type === "access_field") {
		const target_type = type_name_of(node.target);

		// A bitset case used as a value (`Permissions.read` → one bit).
		const bitset = status.bitsets.find((b) => b.name === target_type);
		if (bitset) {
			const index = bitset.cases.indexOf(access.name);
			if (index !== -1) return `(1n << ${index}n)`;
			return unsupported(`bitset ${target_type}.${access.name}`);
		}

		// A tag-only enum case used as a value (`Dir.north`).
		const enum_node = status.enums.find((e) => e.name === target_type);
		if (enum_node) {
			const case_index = enum_node.cases.findIndex((c) => c.name === access.name);
			if (case_index !== -1) return enum_case_value(enum_node, case_index, [], status);
		}

		// `length` on the container receivers is a declared property.
		if (access.name === "length" && library_base_name(target_type) === "StringBuilder") {
			return `BigInt(${expr(node.target, status)}.s.length)`;
		}
		if (access.name === "length" && library_base_name(target_type) === "Map") {
			return `BigInt(${expr(node.target, status)}.size)`;
		}
		if (access.name === "length" && library_base_name(target_type) === "Set") {
			return `BigInt(${expr(node.target, status)}.size)`;
		}
		if (access.name === "length" && library_base_name(target_type) === "List") {
			return `BigInt(${expr(node.target, status)}.length)`;
		}
		if (access.name === "length" && library_base_name(target_type) === "StableList") {
			return `BigInt(${expr(node.target, status)}.length)`;
		}
		// A Buffer's capacity is its array length; `data` is the raw slab
		// pointer, which only raw/unsafe bodies observe (and those are not
		// lowered to JS).
		if (is_buffer_type(target_type) && access.name === "cap") {
			return `BigInt(${expr(node.target, status)}.length)`;
		}
		if (is_buffer_type(target_type) && access.name === "data") {
			return "0n";
		}
		// A plain array/string `.length` is a JS number; Nomen's is an int.
		if (access.name === "length") {
			const target_kind = kind_of(node.target);
			if (target_kind === "array" || target_kind === "string") {
				return `BigInt(${expr(node.target, status)}.length)`;
			}
		}
		return `${expr(node.target, status)}.${access.name}`;
	}
	return build_method_call(node.target, access as AccessFunctionCallNode, status);
}

function build_method_call(
	target: BaseNode,
	access: AccessFunctionCallNode,
	status: BuildStatus,
): string {
	const name = access.name;
	const args = access.params.map((p) => expr(p, status));
	const target_type = type_name_of(target);
	const native_type = library_base_name(target_type);
	const target_kind = kind_of(target);
	// A trait-typed receiver resolves to the concrete struct at check time;
	// the value itself is already that struct at runtime, so dispatch uses the
	// concrete class's method label. A generic receiver picks its
	// monomorphized struct when one is registered: the generic body's field
	// types are unstamped and its template constants unsubstituted.
	const target_stamp = stamped_type(target);
	const receiver_class =
		access.devirtualized_class ??
		(target_stamp?.type_args?.length ? mono_type_name(target_stamp) : target_type);

	// A call through a func-typed FIELD (`h.f(x)`): the field holds a JS
	// function, invoked with the struct as `self`? No — a func field has no
	// self; it is the stored function itself.
	if (access.is_func_field_call) {
		return call_with_refs(
			status,
			access.params,
			access.ref_param_indices,
			(arg_exprs) => `${expr(target, status)}.${name}(${arg_exprs.join(", ")})`,
		);
	}

	if (access.is_static) {
		if (target_type === "Console") return `Console_${name}(${args.join(", ")})`;
		if (target_type === "Format") return `Format_${name}(${args.join(", ")})`;
		if (target_type === "Math" && name === "power") return `__math_power(${args.join(", ")})`;
		if (target_type === "Array" && name === "with") return `__array_with(${args.join(", ")})`;
		if (target_type === "int" && name === "parse") return `__parse_int(${args[0]})`;
		if (target_type === "Time") return time_call(name, args);
		if (target_type === "Utf8") return utf8_call(name, args);
		const enum_node = status.enums.find((e) => e.name === target_type);
		if (enum_node) {
			const case_index = enum_node.cases.findIndex((c) => c.name === name);
			if (case_index !== -1) return enum_case_value(enum_node, case_index, args, status);
		}
		const struct = status.structs.find((s) => s.name === target_type);
		if (struct) {
			return call_with_refs(
				status,
				access.params,
				access.ref_param_indices,
				(arg_exprs) => `${method_label(target_type, name)}(${arg_exprs.join(", ")})`,
			);
		}
		// A System-library struct's static method, lowered from its Nomen body.
		const library_struct = status.library_structs.find(
			(s) => s.name === receiver_class && !is_native_library_type(s.name),
		);
		const library_func = library_struct && library_method(library_struct, name, args.length, true);
		if (library_struct && library_func) {
			return call_with_refs(status, access.params, access.ref_param_indices, (arg_exprs) =>
				library_method_call(library_struct, library_func, undefined, arg_exprs, status),
			);
		}
		return unsupported(`${target_type}.${name}`);
	}

	if (target_kind === "string" || target_kind === "char") {
		const text = expr(target, status);
		switch (name) {
			case "to_string":
				return text;
			case "length":
				return `BigInt(${text}.length)`;
			case "at":
			case "at_or_panic":
				return `__string_at(${text}, ${args[0]})`;
			case "at_or":
				return `__string_at_or(${text}, ${args[0]}, ${args[1]})`;
			case "slice":
			case "substring":
				return `${text}.slice(Number(${args[0]}), Number(${args[1]}))`;
			case "copy":
				return text;
			case "trim":
				return `${text}.trim()`;
			case "trim_start":
				return `${text}.replace(/^\\s+/, "")`;
			case "trim_end":
				return `${text}.replace(/\\s+$/, "")`;
			case "to_lowercase":
				return `${text}.toLowerCase()`;
			case "to_uppercase":
				return `${text}.toUpperCase()`;
			case "contains":
				return `${text}.includes(${args[0]})`;
			case "starts_with":
				return `${text}.startsWith(${args[0]})`;
			case "ends_with":
				return `${text}.endsWith(${args[0]})`;
			case "index_of":
				return `BigInt(${text}.indexOf(${args[0]}))`;
			case "index_of_from":
				return `BigInt(${text}.indexOf(${args[0]}, Number(${args[1]})))`;
			case "replace_first":
				return `${text}.replace(${args[0]}, ${args[1]})`;
			case "replace_all":
				return `${text}.replaceAll(${args[0]}, ${args[1]})`;
			case "char_code_at":
				return `BigInt(${text}.charCodeAt(Number(${args[0]})))`;
			case "char_code_at_or":
				return `__char_code_at_or(${text}, ${args[0]}, ${args[1]})`;
			case "hash":
				return `__string_hash(${text})`;
		}
		return unsupported(`string.${name}`);
	}

	if (target_kind === "array") {
		const list = expr(target, status);
		switch (name) {
			case "length":
				return `BigInt(${list}.length)`;
			case "at":
				return `${list}[Number(${args[0]})]`;
			case "set":
				return `(${list}[Number(${args[0]})] = ${stored_args(access.params, status)[1]})`;
			case "push":
				return `${list}.push(${stored_args(access.params, status)[0]})`;
			case "pop":
				return `${list}.pop()`;
			case "slice":
				return `${list}.slice(Number(${args[0]}), Number(${args[1]}))`;
			case "copy":
				return `${list}.slice()`;
		}
		return unsupported(`array.${name}`);
	}

	// Supported System-library receivers map onto their JS representations.
	// This must precede the generic `to_string` fallback: StringBuilder's
	// `to_string` is a take, not a rendering.
	if (native_type === "List") {
		const mapped = list_method(name, expr(target, status), stored_args(access.params, status));
		if (mapped !== undefined) return mapped;
	}
	if (native_type === "Set") {
		const mapped = set_method(name, expr(target, status), stored_args(access.params, status));
		if (mapped !== undefined) return mapped;
	}
	if (native_type === "Map") {
		const mapped = map_method(name, expr(target, status), stored_args(access.params, status));
		if (mapped !== undefined) return mapped;
	}
	if (native_type === "StringBuilder") {
		const mapped = string_builder_method(name, expr(target, status), args);
		if (mapped !== undefined) return mapped;
	}
	if (native_type === "BigInt") {
		const mapped = bigint_method(name, expr(target, status), args);
		if (mapped !== undefined) return mapped;
	}
	if (native_type === "StableList") {
		const mapped = stable_list_method(
			name,
			expr(target, status),
			stored_args(access.params, status),
		);
		if (mapped !== undefined) return mapped;
	}
	// The slot buffers back the linked/chunked containers; JS arrays stand in
	// for the native slab (see `buffer_method`).
	if (is_buffer_type(target_type)) {
		const mapped = buffer_method(name, expr(target, status), args, {
			class_elements: is_class_buffer_type(target_type),
			...buffer_zero(target),
		});
		if (mapped !== undefined) return mapped;
	}

	// A user struct method (this also covers a devirtualized trait call: the
	// concrete method wins over the generic rendering fallback).
	const struct = status.structs.find((s) => s.name === receiver_class);
	if (struct) {
		return call_with_refs(
			status,
			access.params,
			access.ref_param_indices,
			(arg_exprs) =>
				`${method_label(receiver_class, name)}(${[expr(target, status), ...arg_exprs].join(", ")})`,
		);
	}

	// Primitive `hash()` (djb2 for strings, identity for ints) — the integer
	// containers hash natively in JS, so only direct user calls land here.
	if (name === "hash" && target_kind === "int") {
		return `BigInt.asUintN(64, ${expr(target, status)})`;
	}

	// A System-library instance method, lowered from its Nomen body (e.g.
	// `Chars`/`Json` readers). The natively modeled containers returned above.
	const library_struct = status.library_structs.find(
		(s) => s.name === receiver_class && !is_native_library_type(s.name),
	);
	const library_func = library_struct && library_method(library_struct, name, args.length, false);
	if (library_struct && library_func) {
		return call_with_refs(status, access.params, access.ref_param_indices, (arg_exprs) =>
			library_method_call(library_struct, library_func, target, arg_exprs, status),
		);
	}

	if (name === "to_string") {
		return `__to_string(${expr(target, status)})`;
	}

	// A trait-typed receiver with no compile-time devirtualization (`Shape a`
	// inside a function): dispatch on the value's runtime `$type` table.
	if (status.traits.some((t) => t.name === target_type || t.name === receiver_class)) {
		return `__dispatch(${[expr(target, status), JSON.stringify(name), ...args].join(", ")})`;
	}

	return unsupported(`${target_type}.${name}`);
}

/** The zero value a freshly grown Buffer slot holds, and whether loads must
 *  copy: struct/enum slots have value semantics, scalars and strings don't. */
function buffer_zero(target: BaseNode): { zero: string; copy_loads: boolean } {
	const type = stamped_type(target);
	const element_name = buffer_element_name(type);
	const info = element_name ? get_built_in_type(element_name) : undefined;
	const is_class = is_class_buffer_type(type?.name ?? "");
	if (is_class) return { zero: "null", copy_loads: false };
	switch (info?.kind) {
		case "int":
			return { zero: "0n", copy_loads: false };
		case "float":
			return { zero: "0", copy_loads: false };
		case "bool":
			return { zero: "false", copy_loads: false };
		case "string":
		case "char":
			return { zero: '""', copy_loads: false };
		default:
			// A struct/enum slot: no generic zero object, and loads copy so a
			// slot and its binding never alias.
			return { zero: "undefined", copy_loads: true };
	}
}

/** `Buffer_int` → `int`, `Buffer<T>` → `T`, `ClassBuffer_Animal` → `Animal`. */
function buffer_element_name(type: { name: string; type_args?: { name: string }[] } | undefined) {
	const arg = type?.type_args?.[0];
	if (arg) return arg.name;
	const name = type?.name ?? "";
	for (const prefix of ["ClassBuffer_", "Buffer_"]) {
		if (name.startsWith(prefix)) return name.slice(prefix.length);
	}
	return undefined;
}

/** `System.Utf8` over the JS string model (code units, not bytes): decoding
 *  advances one code unit for BMP text and two for astral characters. */
function utf8_call(name: string, args: string[]): string {
	switch (name) {
		case "decode_at":
			return `__utf8_decode(${args[0]}, ${args[1]})`;
		case "width_at":
			return `__utf8_decode(${args[0]}, ${args[1]}).byte_length`;
		case "encode":
			return `__utf8_encode(${args[0]})`;
		case "char_count":
			return `BigInt([...${args[0]}].length)`;
	}
	return unsupported(`Utf8.${name}`);
}

/** `System.Time` reads and sleeps, mapped onto JS clock/sleep primitives. */
function time_call(name: string, args: string[]): string {
	switch (name) {
		case "now_ms":
			return "BigInt(Date.now())";
		case "now_ns":
			return "(BigInt(Date.now()) * 1000000n)";
		case "now_unix":
			return "BigInt(Math.floor(Date.now() / 1000))";
		case "sleep_ms":
			return `__sleep_ms(${args[0]})`;
	}
	return unsupported(`Time.${name}`);
}

/** Container stores copy value structs (MEMORY.md: a copy into a container
 *  slot is independent). Scalars/strings are identity under `__copy`. */
function stored_args(args: BaseNode[], status: BuildStatus): string[] {
	return args.map((arg) =>
		copy_if_value_struct(expr(arg, status), stamped_type(arg)?.name, status),
	);
}

function unsupported(what: string): string {
	// A valid program reached a library/raw feature the JS backend does not
	// model: warn and continue rather than aborting the whole run.
	return `__skip(${JSON.stringify(what)})`;
}
