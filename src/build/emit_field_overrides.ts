import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import type AnonStructNode from "../nodes/AnonStructNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import ValueNode from "../nodes/ValueNode.ts";

function overrides_of(value: BaseNode): { name: string; value: BaseNode; type?: unknown }[] {
	const call = value as FunctionCallNode;
	if (call.field_overrides?.length) return call.field_overrides;
	return ((value as AnonStructNode).fields as { name: string; value: BaseNode; type?: unknown }[]) ?? [];
}

/**
 * Build the post-construction field-override assignments for a named-field
 * struct literal (e.g. `[ grow = 2 ]` on a struct whose `grow` field has a
 * declared default, or `[ .. <base>, grow = 2 ]`). Each override becomes a
 * synthetic `<var>.<field> = <value>` AssignmentNode and is fed through the
 * supplied `build` callback (the per-backend build_node), so primitives,
 * classes, struct-typed fields, and strings all reuse the existing assignment
 * path.
 *
 * `declaration_terminator` is appended once before the overrides (e.g. `;\n`
 * for C) so the just-emitted declaration is properly closed before the
 * synthetic assignments begin. `statement_terminator` is appended after each
 * synthetic assignment (e.g. `;\n` for C; asm uses the empty string since
 * each emitted instruction is already line-terminated).
 */
export default function emit_field_overrides(
	var_name: string,
	value: BaseNode,
	build: (node: BaseNode, status: any) => void,
	status: any,
	declaration_terminator = "",
	statement_terminator = "",
) {
	const overrides = overrides_of(value);
	if (!overrides.length) return;
	status.code += declaration_terminator;
	for (const override of overrides) {
		const target = new ValueNode(override.value.start, var_name);
		const access_field = new AccessFieldNode(override.value.start, override.name, override.type as any);
		const access = new AccessNode(override.value.start, target, access_field);
		const assign = new AssignmentNode(override.value.start, access, override.value);
		status.code += "\n";
		build(assign, status);
		status.code += statement_terminator;
	}
}

/**
 * True when `value` carries field overrides to apply after the destination
 * slot has been written: a constructor call with `field_overrides`, or a
 * base-bearing anonymous struct literal (`[ .. <base>, ... ]`).
 */
export function has_field_overrides(value: BaseNode | undefined | null): boolean {
	if (!value) return false;
	if (value.node_type === "func_call") {
		return !!(value as FunctionCallNode).field_overrides?.length;
	}
	if (value.node_type === "anon_struct") {
		return !!(value as AnonStructNode).base;
	}
	return false;
}

/**
 * Evaluate every override's value expression into a synthetic `const` local
 * BEFORE the base is constructed/copied into the destination. Both backends
 * lower the base (constructor call or byte copy) first and apply the override
 * assignments after — so an override expression that reads the destination
 * (e.g. `m = [ .. x, node_type = m.node_type ]`) would observe the
 * new/clobbered value instead of the pre-assignment one. Hoisting the values
 * into temporaries up front makes them read the pre-assignment state.
 *
 * Class/trait-typed overrides are NOT hoisted: routing an owned instance
 * through a temporary local would transfer its ownership to the temp and
 * alias it with the destination field. They keep the direct (post-copy)
 * lowering. Idempotent via a marker flag, so sites that hoist early and
 * sites nested inside generic builders don't double-emit.
 */
export function hoist_field_overrides(
	value: BaseNode | undefined | null,
	build: (node: BaseNode, status: any) => void,
	status: any,
	declaration_terminator = "",
): void {
	if (!value) return;
	const overrides = overrides_of(value);
	if (!overrides.length) return;
	const carrier = value as unknown as { _fov_hoisted?: boolean };
	if (carrier._fov_hoisted) return;
	for (const override of overrides) {
		// A literal can never read the destination — hoisting one would only
		// churn string-ownership handling (const local vs rodata). Hoist
		// expressions and variable reads only.
		if (override.value.node_type === "value") {
			const v = (override.value as ValueNode).value;
			const is_literal =
				v === "true" ||
				v === "false" ||
				v === "null" ||
				(v.startsWith('"') && v.endsWith('"')) ||
				(v.startsWith("'") && v.endsWith("'")) ||
				/^(\+|-)?\d[\d_]*(\.\d+)?([eE](\+|-)?\d+)?$/.test(v);
			if (is_literal) continue;
		}
		const type = override.type as { name?: string; is_array?: boolean } | undefined;
		const is_class_like =
			!!(type?.name && status.structs?.find((s: any) => s.name === type.name && s.is_class)) ||
			!!(type?.name && status.traits?.find((t: any) => t.name === type.name));
		// Strings and structs ride dedicated ownership paths (a hoisted string
		// temp is a borrow the auto-free machinery would free; a struct temp
		// may own heap fields), so only ownership-free scalars are hoisted —
		// they cannot double-free and cannot leak.
		const is_scalar =
			!!type?.name &&
			!type.is_array &&
			type.name !== "string" &&
			!is_class_like &&
			!status.structs?.find((s: any) => s.name === type.name && !s.is_simple_type) &&
			!status.enums?.find((e: any) => e.name === type.name) &&
			!status.bitsets?.find((b: any) => b.name === type.name);
		if (!is_scalar) continue;
		const temp = `_fov_${(status._fov_counter = (status._fov_counter ?? 0) + 1)}`;
		const start = override.value.start;
		const decl = new DeclarationNode(
			start,
			"private",
			"const",
			temp,
			type as never,
			override.value,
		);
		build(decl as BaseNode, status);
		// The C declaration builder leaves `TYPE name = <value>` unclosed —
		// the caller's terminator closes it (same contract emit_field_overrides
		// documents for `declaration_terminator`).
		status.code += declaration_terminator;
		const ref = new ValueNode(start, temp);
		(ref as unknown as { type: unknown }).type = type;
		override.value = ref;
	}
	carrier._fov_hoisted = true;
}
