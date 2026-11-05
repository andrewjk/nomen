import add_error from "../../add_error.ts";
import EnumNode from "../../nodes/EnumNode.ts";
import type Type from "../../nodes/Type.ts";
import { type_contains_unresolved_param } from "../check_function_call_node.ts";
import type CheckStatus from "../CheckStatus.ts";
import { monomorphize_enum } from "./enum_mono.ts";

/**
 * Variable-mode enums (PERF_PLAN item 13, GOOSE #6): a case-qualified type
 * spelling `Enum.case` (`Res.ok`) names the VARIABLE-MODE form of the enum —
 * a value that is one specific case, stored at that case's size (tag word +
 * the case payload, tail-padded to 8) instead of tag + the LARGEST case
 * payload. The freeze-at-construction constraint is enforced by the type
 * system: a `Res_ok` slot can only ever hold `.ok` values (nothing else
 * types as `Res_ok`), so it can never change variant — the safety condition
 * MEMORY.md's tagged-union note leans on.
 *
 * The type is materialized as a single-case mono enum named `Res_ok` (the
 * same flattening generic instantiations use), registered in status.enums,
 * status.types, AND root.statements — the last is what the build's enum
 * walk sees (mirroring monomorphize_enum). Every case carries `tag_index`
 * (its ORIGINAL declaration index), so the mono's tags, matches, and `==`
 * agree with the base enum's.
 */

/** The synthesized single-case mono for `Res.ok`, or undefined. */
export function case_mono_name(base_enum: string, case_name: string): string {
	// Double-underscore join (see parse_type): keeps the mono's C identifiers
	// (`Res__ok`, `Res__ok_ok`) clear of the base enum's tag constants
	// (`Res_ok`) and of generic-mono spellings.
	return `${base_enum}__${case_name}`;
}

/**
 * The runtime panic text of the checked case cast (`r as Res.ok`, PERF_PLAN
 * item 13(3)): the value's tag failed the case's tag comparison. Both
 * backends print this exact string before exiting — the explicit,
 * call-site-visible check mirrors the `_or_panic` family's wording style.
 */
export const CASE_CAST_PANIC_MESSAGE =
	"base to case conversion: the value carries a different variant";

/**
 * Validate a case-qualified type (`type.case_enum`/`type.case_name` set by
 * the parser) and materialize the single-case mono enum. Over a GENERIC
 * base (`Option<int>.some` — name still the bare generic, args attached)
 * the generic mono materializes FIRST (mono-of-a-mono order) and the
 * annotation is rewritten to the mono (`name` → `Option_int`, `case_enum` →
 * `Option_int`, args cleared) before the case mono resolves. Idempotent;
 * rewrites nothing on failure (the caller's unknown-type path reports).
 */
export function resolve_case_enum_type(type: Type, status: CheckStatus, start: number): void {
	let base = type.case_enum!;
	// `case_name` (set at parse for both spellings); the flattened-name
	// derivation remains for synthesized/replayed annotations.
	const case_name = type.case_name ?? type.name.substring(base.length + 2);
	// A generic base (`Option<int>.some`): materialize the instantiation
	// first, then resolve the case over the mono. Deferred while an arg
	// still references an unresolved type param (a generic CONTEXT spells
	// case types over its own params — `Option<T>.some` inside a generic
	// body materializes per instantiation, like every generic annotation).
	if (type.type_args?.length) {
		const generic_enum = status.enums.findLast((e) => e.name === base && e.is_generic);
		if (!generic_enum) {
			add_error(
				status,
				`Unknown generic enum: ${base} (in case type '${base}<...>.${case_name}')`,
				start,
			);
			return;
		}
		if (
			generic_enum.type_params.length !== type.type_args.length ||
			type.type_args.some((t) => type_contains_unresolved_param(t, status))
		) {
			add_error(
				status,
				`Generic enum ${generic_enum.name} requires ${generic_enum.type_params.length} concrete type arguments for a case type ('${base}<...>.${case_name}')`,
				start,
			);
			return;
		}
		const mono = monomorphize_enum(generic_enum, type.type_args, status);
		if (!mono) return;
		// The annotation now names the mono: the mangled case-mono name
		// derives from it, and the args drop (the mono is concrete).
		base = mono.name;
		type.name = `${mono.name}__${case_name}`;
		type.case_enum = mono.name;
		type.type_args = undefined;
	}
	const enum_node = status.enums.findLast(
		(e) => (e.name === base || e.source_name === base) && !e.is_generic,
	);
	if (!enum_node) {
		add_error(status, `Unknown enum: ${base} (in case type '${base}.${case_name}')`, start);
		return;
	}
	if (enum_node.is_generic) {
		add_error(
			status,
			`a case type on a generic enum ('${base}.${case_name}') requires concrete type arguments`,
			start,
		);
		return;
	}
	const enum_case = enum_node.cases.find((c) => c.name === case_name);
	if (!enum_case) {
		add_error(status, `Enum ${base} has no case '${case_name}'`, start);
		return;
	}
	const mono_name = case_mono_name(base, case_name);
	const existing = status.enums.find((e) => e.name === mono_name);
	if (existing || status.types.includes(mono_name)) {
		// Already materialized (a prior case-type use) — fine. Any OTHER
		// occupant of the name (a user struct/enum spelled `Res__ok`, or a
		// different enum) is a collision: reject.
		if (!existing || !existing.is_case_mono || existing.parent_enum !== base) {
			add_error(
				status,
				`case type '${base}.${case_name}' collides with the existing type '${mono_name}'`,
				start,
			);
		}
		return;
	}
	// Reuse the base case's parameter nodes (checked already — the base
	// enum precedes any use of a case type over it); carry the ORIGINAL
	// declaration index as the tag.
	const mono_case = {
		name: enum_case.name,
		params: enum_case.params,
		tag_index: enum_case.tag_index ?? enum_node.cases.indexOf(enum_case),
	};
	const mono = new EnumNode(enum_node.start, enum_node.visibility, mono_name, [mono_case]);
	mono.is_case_mono = true;
	mono.parent_enum = base;
	mono.is_owning = enum_node.is_owning;
	mono.checked = enum_node.checked;
	// NOTE: deliberately NOT inheriting is_library — a case mono is
	// generated per use, so it belongs in the user TU (the precompiled
	// system.o cannot know which case types user code spells; mirrors
	// monomorphize_enum).

	status.enums.push(mono);
	if (!status.types.includes(mono_name)) {
		status.types.push(mono_name);
	}
	const root = status.stack[0] as { statements?: { node_type: string; name?: string }[] };
	if (
		root?.statements &&
		!root.statements.some((s) => s.node_type === "enum" && s.name === mono_name)
	) {
		root.statements.push(mono as never);
	}
}

/**
 * The mono for (base enum, case) when `expected_type_name` is exactly that
 * case type — i.e. the construction target IS the variable-mode form. Only
 * an already-registered case mono matches (the expected annotation has
 * always been through check_type_exists before the value is checked, so the
 * mono exists by then); anything else returns undefined and the caller
 * stamps the base enum type as before.
 */
export function case_mono_for_construction(
	enum_node: EnumNode,
	case_name: string,
	expected_type_name: string | undefined,
	status: CheckStatus,
): EnumNode | undefined {
	if (!expected_type_name) return undefined;
	const mono_name = case_mono_name(enum_node.name, case_name);
	if (expected_type_name !== mono_name) return undefined;
	const mono = status.enums.find((e) => e.name === mono_name && e.is_case_mono);
	return mono;
}

/**
 * The BASE↔CASE conversion direction for a (target, value) type pair, or
 * undefined when the pair is not one. `case_to_base` — the case mono's
 * layout (tag + its payload) is a byte-prefix of the parent enum's, and its
 * tag is the parent's declared index, so a widening prefix copy is always
 * sound. `base_to_case` — narrowing needs a runtime tag check (the value
 * may carry another variant); the builders emit the check and panic on
 * mismatch. Only case monos with a registered parent participate.
 */
export function case_base_conversion_direction(
	target: string | undefined,
	value: string | undefined,
	status: CheckStatus,
): "case_to_base" | "base_to_case" | undefined {
	if (!target || !value || target === value) return undefined;
	const value_enum = status.enums.find((e) => e.name === value && e.is_case_mono);
	if (value_enum?.parent_enum === target) return "case_to_base";
	const target_enum = status.enums.find((e) => e.name === target && e.is_case_mono);
	if (target_enum?.parent_enum === value) return "base_to_case";
	return undefined;
}
