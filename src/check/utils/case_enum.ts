import add_error from "../../add_error.ts";
import EnumNode from "../../nodes/EnumNode.ts";
import type Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";

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
 * Validate a case-qualified type (`type.case_enum` set by the parser,
 * `type.name` already the mangled `Enum_case` form) and materialize the
 * single-case mono enum. Idempotent; rewrites nothing on failure (the
 * caller's unknown-type path reports).
 */
export function resolve_case_enum_type(type: Type, status: CheckStatus, start: number): void {
	const base = type.case_enum!;
	// The mangled name is `<base>__<case>` (see parse_type).
	const case_name = type.name.substring(base.length + 2);
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
			`a case type on a generic enum ('${base}.${case_name}') is not supported yet`,
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
