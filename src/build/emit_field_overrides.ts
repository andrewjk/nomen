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
	// The carrier's resolved struct type (stamped by the checker on both the
	// anon-struct literal and the ctor call) — the synthetic assignment's
	// target needs it so backends resolve the field write through the normal
	// ownership paths (the C string-field lowering keys on the target's
	// struct). Applied ONLY for user-visible destinations: at the sret return
	// path the destination is the compiler-generated `_return_val`, and
	// routing its field writes through the strdup+record lowering would
	// orphan the heap-field record at the struct-return boundary (the
	// caller's copy is untracked → leak).
	const carrier_type = var_name.startsWith("_return_val")
		? undefined
		: (value as unknown as { type?: unknown }).type;
	for (const override of overrides) {
		const target = new ValueNode(override.value.start, var_name);
		if (carrier_type) {
			(target as unknown as { type: unknown }).type = carrier_type;
		}
		const access_field = new AccessFieldNode(override.value.start, override.name, override.type as any);
		const access = new AccessNode(override.value.start, target, access_field);
		const assign = new AssignmentNode(override.value.start, access, override.value);
		status.code += "\n";
		// These assignments are mid-statement: a terminator is appended after
		// each, so the C backend's string-field store path must not
		// self-report a block-terminated statement from inside this loop
		// (see BuildStatus.c_field_override_depth).
		status.c_field_override_depth = (status.c_field_override_depth ?? 0) + 1;
		build(assign, status);
		status.c_field_override_depth = (status.c_field_override_depth ?? 1) - 1;
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
 * Whether `node`'s expression tree reads the variable `dest_name` — i.e. the
 * override's value observes the destination being assigned. Such overrides
 * MUST be evaluated before the base lands (the base copy overwrites the
 * destination and would clobber the value they read).
 */
function references_destination(node: BaseNode | undefined | null, dest_name: string): boolean {
	if (!node || !dest_name) return false;
	const walk = (n: unknown): boolean => {
		if (!n || typeof n !== "object") return false;
		const any = n as Record<string, unknown>;
		if (any.node_type === "value" && any.value === dest_name) return true;
		if (any.node_type === "access") {
			const target = any.target as Record<string, unknown> | undefined;
			if (target?.node_type === "value" && target.value === dest_name) return true;
		}
		for (const key of Object.keys(any)) {
			if (key === "node_type" || key === "parent" || key === "scope") continue;
			const v = any[key];
			if (Array.isArray(v)) {
				for (const item of v) {
					if (item && typeof item === "object" && "node_type" in (item as object)) {
						if (walk(item)) return true;
					}
				}
			} else if (v && typeof v === "object" && "node_type" in (v as object)) {
				if (walk(v)) return true;
			}
		}
		return false;
	};
	return walk(node);
}

/**
 * Evaluate override value expressions into synthetic `const` locals BEFORE
 * the base is constructed/copied into the destination. Both backends lower
 * the base (constructor call or byte copy) first and apply the override
 * assignments after — so an override expression that reads the destination
 * (e.g. `m = [ .. move x, node_type = m.node_type ]`) would observe the
 * new/clobbered value instead of the pre-assignment one. Hoisting the value
 * into a temporary up front makes it read the pre-assignment state.
 *
 * Which overrides hoist:
 * - SCALARS (int/bool/float): always hoisted when non-literal — an
 *   ownership-free copy, no free, no leak.
 * - STRINGS and VALUE-STRUCTS: hoisted ONLY when the value reads the
 *   destination (the clobber hazard). A string temp is forced to OWN its
 *   bytes (`force_owned_string`): the base copy may displace/free the
 *   destination's old field the value was read from, so a borrow alias
 *   would dangle. A value-struct temp is a field-access borrow snapshot
 *   (aarch64 is_field_struct_borrow / C is_destructured_field_access — not
 *   destroy-tracked). Everything else keeps the direct (post-copy)
 *   lowering — including ALL overrides at sites without a user-visible
 *   destination (the sret return path), where an owned temp's ownership
 *   cannot be carried across the struct-return boundary.
 * - Class/trait-typed overrides are NOT hoisted: routing an owned instance
 *   through a temporary local would transfer its ownership to the temp and
 *   alias it with the destination field.
 *
 * Idempotent via a marker flag, so sites that hoist early and sites nested
 * inside generic builders don't double-emit.
 */
export function hoist_field_overrides(
	value: BaseNode | undefined | null,
	build: (node: BaseNode, status: any) => void,
	status: any,
	declaration_terminator = "",
	dest_name?: string,
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
		const type = override.type as
			| { name?: string; is_array?: boolean; is_view?: boolean }
			| undefined;
		const is_class_like =
			!!(type?.name && status.structs?.find((s: any) => s.name === type.name && s.is_class)) ||
			!!(type?.name && status.traits?.find((t: any) => t.name === type.name));
		const is_string =
			!!type?.name && type.name === "string" && !type.is_array && !type.is_view;
		const is_value_struct =
			!!type?.name &&
			!type.is_array &&
			!is_class_like &&
			!!status.structs?.find((s: any) => s.name === type.name && !s.is_simple_type && !s.is_class);
		// Non-scalar overrides hoist only when they read the destination — the
		// only shape with the clobber hazard. Everything the base copy cannot
		// clobber keeps the baseline direct lowering (its ownership semantics
		// — raw borrows at sret boundaries, strdup'd field writes — are
		// already balanced).
		const reads_destination = references_destination(override.value, dest_name ?? "");
		if (!reads_destination) continue;
		const is_field_borrow_read =
			override.value.node_type === "access" &&
			(override.value as AccessNode).access.node_type === "access_field";
		if (is_string || (is_value_struct && is_field_borrow_read)) {
			const temp = `_fov_${(status._fov_counter = (status._fov_counter ?? 0) + 1)}`;
			const start = override.value.start;
			if (is_string) {
				// The base lands (and may displace/free the destination's old
				// string fields) BEFORE the override assignments run — a
				// borrow-alias temp would dangle. Force the temp to own a copy:
				// both backends strdup a borrow initializer for a force-heap
				// variable and free the temp's copy at its scope exit.
				if (!status.force_heap_strings) status.force_heap_strings = new Set();
				status.force_heap_strings.add(temp);
			}
			const decl = new DeclarationNode(
				start,
				"private",
				"const",
				temp,
				type as never,
				override.value,
			);
			if (is_string) {
				// Both backends' declaration paths key their strdup decision on
				// `is_string_borrow` (accessor calls); a FIELD-access
				// initializer isn't in that set, so mark the decl explicitly —
				// it must own its bytes (see the comment above).
				(decl as unknown as { force_owned_string?: boolean }).force_owned_string = true;
			}
			build(decl as BaseNode, status);
			// The C declaration builder leaves `TYPE name = <value>` unclosed —
			// the caller's terminator closes it (same contract
			// emit_field_overrides documents for `declaration_terminator`).
			status.code += declaration_terminator;
			const ref = new ValueNode(start, temp);
			(ref as unknown as { type: unknown }).type = type;
			override.value = ref;
			continue;
		}
		// Ownership-free scalars hoist as before — they cannot double-free and
		// cannot leak. Everything else (classes/traits, owning struct values)
		// keeps the direct post-copy lowering.
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
