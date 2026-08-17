import add_error from "../../add_error.ts";
import { mono_type_name } from "../../build_common/mono_name.ts";
import EnumNode from "../../nodes/EnumNode.ts";
import ParameterNode from "../../nodes/ParameterNode.ts";
import RootNode from "../../nodes/RootNode.ts";
import Type from "../../nodes/Type.ts";
import { flatten_nested_generic_arg } from "../check_function_call_node.ts";
import type CheckStatus from "../CheckStatus.ts";
import { materialize_anon_enum_type } from "./anon_enum.ts";
import { clone_type, materialize_tuple_type } from "./tuple_struct.ts";

/**
 * Monomorphize a generic enum (`enum Result<T, E>`) applied to concrete type
 * args, mirroring struct monomorphization: the mono name is derived via
 * `mono_type_name` (`Result<int, string>` → `Result_int_string`), case
 * payload types are substituted and resolved to emitted types (nested
 * generics flattened to their mono names, tuples/anonymous enums
 * materialized), and the result is registered in `status.enums`/
 * `status.types` and appended to the root so the build phase emits it.
 * Reuses an existing mono when one was already created.
 */
export function monomorphize_enum(
	generic_enum: EnumNode,
	type_args: Type[],
	status: CheckStatus,
): EnumNode | null {
	if (type_args.length !== generic_enum.type_params.length) {
		add_error(
			status,
			`Expected ${generic_enum.type_params.length} type arguments for ${generic_enum.name}, got ${type_args.length}`,
			generic_enum.start,
		);
		return null;
	}

	const flat_args = type_args.map((t) => flatten_nested_generic_arg(t, status));
	const mono_name = mono_type_name(generic_enum.name, flat_args);

	const existing =
		status.enums.find((e) => e.name === mono_name) || find_root_enum(status, mono_name);
	if (existing) {
		if (!status.enums.includes(existing)) {
			status.enums.push(existing);
		}
		return existing;
	}

	const substitution = new Map<string, Type>();
	for (let i = 0; i < generic_enum.type_params.length; i++) {
		substitution.set(generic_enum.type_params[i], flat_args[i]);
	}

	const cases = generic_enum.cases.map((c) => ({
		name: c.name,
		params: c.params.map((p) => {
			const direct = substitution.get(p.type.name);
			// A bare type-param payload (`T value`) becomes the concrete arg.
			if (direct && !p.type.type_args?.length && !p.type.tuple_types?.length) {
				return new ParameterNode(p.start, p.name, clone_type(direct));
			}
			// Composite payloads: substitute nested param references, then
			// resolve to a concrete emitted type (mirroring the payload
			// preparation in get_or_create_anon_enum).
			const substituted = clone_type(p.type);
			if (substituted.type_args?.length) {
				substituted.type_args = substituted.type_args.map((a) =>
					substitute_payload(a, substitution),
				);
				return new ParameterNode(
					p.start,
					p.name,
					clone_type(flatten_nested_generic_arg(substituted, status)),
				);
			}
			const resolved = substitute_payload(substituted, substitution);
			if (resolved.name === "tuple" && resolved.tuple_types?.length) {
				return new ParameterNode(p.start, p.name, materialize_tuple_type(resolved, status) as Type);
			}
			if (resolved.name === "anon_enum" && resolved.enum_cases?.length) {
				return new ParameterNode(p.start, p.name, materialize_anon_enum_type(resolved, status));
			}
			return new ParameterNode(p.start, p.name, resolved);
		}),
	}));

	const mono = new EnumNode(generic_enum.start, generic_enum.visibility, mono_name, cases);
	mono.is_generic = false;
	// NOTE: deliberately NOT inheriting is_library. A mono enum is
	// auto-generated per use, so it belongs in the user TU (mirroring
	// `_Tuple_` structs in is_system_definition) — the precompiled system.o
	// cannot know which instantiations user code needs.

	status.enums.push(mono);
	if (!status.types.includes(mono_name)) {
		status.types.push(mono_name);
	}

	const root = status.stack[0] as RootNode;
	if (
		root &&
		!root.statements.some((s) => s.node_type === "enum" && (s as EnumNode).name === mono_name)
	) {
		root.statements.push(mono);
	}

	return mono;
}

/**
 * Find an enum registered at the root by name — a mono may already have been
 * emitted to root.statements from a different (cloned) check scope whose
 * status.enums copy we don't share.
 */
function find_root_enum(status: CheckStatus, name: string): EnumNode | undefined {
	const root = status.stack[0] as RootNode | undefined;
	if (!root) return undefined;
	return root.statements.find((s) => s.node_type === "enum" && (s as EnumNode).name === name) as
		| EnumNode
		| undefined;
}

/**
 * Substitute type params inside a composite payload type (recursively through
 * type args, tuple elements, and anonymous enum case payloads).
 */
function substitute_payload(t: Type, substitution: Map<string, Type>): Type {
	const direct = substitution.get(t.name);
	if (direct && !t.type_args?.length && !t.tuple_types?.length && !t.enum_cases?.length) {
		return clone_type(direct);
	}
	if (t.type_args?.length) {
		const copy = clone_type(t);
		copy.type_args = t.type_args.map((a) => substitute_payload(a, substitution));
		return copy;
	}
	if (t.tuple_types?.length) {
		const copy = clone_type(t);
		copy.tuple_types = t.tuple_types.map((a) => substitute_payload(a, substitution));
		return copy;
	}
	if (t.enum_cases?.length) {
		const copy = clone_type(t);
		copy.enum_cases = t.enum_cases.map((c) => ({
			name: c.name,
			types: c.types.map((a) => substitute_payload(a, substitution)),
		}));
		return copy;
	}
	return clone_type(t);
}
