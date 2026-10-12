import {
	box_clone_fn_name,
	box_field_mono,
	box_pointee_strings_are_heap,
	box_pointee_type,
	enum_copy_is_deep,
} from "../../build_common/box_clone.ts";
import { struct_needs_destroy } from "../../build_common/destroy_analysis.ts";
import { owns_strings_uniformly } from "../../build_common/has_string_fields.ts";
import { is_load_deep_copy_container, resolve_struct_type } from "../../build_common/mono_name.ts";
import type DeclarationNode from "../../nodes/DeclarationNode.ts";
import StructNode from "../../nodes/StructNode.ts";
import type Type from "../../nodes/Type.ts";
import type BuildStatus from "../BuildStatus.ts";

/**
 * Emit the `<Box_T>_box_clone` helper for a `Box<T>` mono (STRUCT_PLAN_3
 * Box-in-container fix): malloc a fresh wrapper, byte-copy the pointee, then
 * give the clone independent copies of every field the wrapper's destroy
 * would reclaim (the same field set `build_auto_destroy` walks — plain
 * strings, deep-copyable containers, nested boxes, payload-copyable enums).
 * Class/trait-referencing state (a raw class field, an enum with reference
 * payloads) cannot be duplicated and stays SHARED — the pre-existing bounded
 * gap, recorded in FOLLOWUP.md.
 *
 * The DEFINITION buffers into `status.box_clone_definitions` (flushed at file
 * scope by build_root_node — C may not nest a function definition inside the
 * struct-method body being emitted) with the prototype in headers, so
 * definition order never matters. Deduped per TU via
 * `status.emitted_box_clones`. Returns the helper's symbol.
 */
export function ensure_box_clone(box_mono: StructNode, status: BuildStatus): string {
	if (!status.emitted_box_clones) status.emitted_box_clones = new Set();
	if (status.emitted_box_clones.has(box_mono.name)) return box_clone_fn_name(box_mono.name);
	status.emitted_box_clones.add(box_mono.name);
	const fn = box_clone_fn_name(box_mono.name);
	status.headers += `struct ${box_mono.name} *${fn}(struct ${box_mono.name} *);\n`;
	const out: string[] = [];
	out.push(`struct ${box_mono.name} *${fn}(struct ${box_mono.name} *src)\n{\n`);
	out.push(`if (!src) return 0;\n`);
	out.push(
		`struct ${box_mono.name} *_dst = (struct ${box_mono.name} *)malloc(sizeof(struct ${box_mono.name}));\n`,
	);
	out.push(`*_dst = *src;\n`);
	const pointee_type = box_pointee_type(box_mono);
	if (pointee_type) {
		emit_pointee_owned_copies("_dst->__value", pointee_type, status, new Set(), out);
	}
	out.push(`return _dst;\n`);
	out.push(`}\n`);
	status.box_clone_definitions = (status.box_clone_definitions ?? "") + out.join("");
	return fn;
}

/**
 * Give the wrapper clone at C lvalue `lv` fresh copies of every field its
 * destroy would free. Recurses through nested value-struct fields; a nested
 * Box field clones through its own helper (the same emit point, deduped).
 */
function emit_pointee_owned_copies(
	lv: string,
	type: Type,
	status: BuildStatus,
	visiting: Set<string>,
	out: string[],
): void {
	if (!type.name || type.is_ref || type.is_view || type.is_array || type.is_nullable) return;
	// A `Box<string>` pointee: the wrapper's destroy frees `__value.ptr`
	// unconditionally (the ctor strdup'd it), so the clone owns its own bytes.
	if (type.name === "string") {
		out.push(`${lv} = ${lv}.ptr ? nomen_str_dup(${lv}) : ${lv};\n`);
		return;
	}
	const field_enum = status.enums.find((e) => e.name === type.name && e.has_associated_data);
	if (field_enum) {
		if (enum_copy_is_deep(field_enum, status)) {
			out.push(`${lv} = ${field_enum.name}_copy(${lv});\n`);
		}
		return;
	}
	const pointee = resolve_struct_type(type, status);
	if (!pointee || pointee.is_class) return;
	if (visiting.has(pointee.name)) return;
	visiting.add(pointee.name);
	const strings_are_heap = box_pointee_strings_are_heap(pointee, status);
	for (const field of clone_fields(pointee, status)) {
		if (field.type.is_ref || field.type.is_view || field.type.is_array || field.type.is_nullable)
			continue;
		const flv = `${lv}.${field.name}`;
		const nested_box = box_field_mono(field.type, status);
		if (nested_box) {
			const nested_fn = ensure_box_clone(nested_box, status);
			out.push(`${flv} = ${nested_fn}(${flv});\n`);
			continue;
		}
		if (field.type.name === "string" && !field.type.is_array && strings_are_heap) {
			out.push(`${flv} = ${flv}.ptr ? nomen_str_dup(${flv}) : ${flv};\n`);
			continue;
		}
		// A container field (`List<T>`/`Buffer<T>` mono): its `copy` yields an
		// independent slab — the same predicate the load deep-copy uses.
		const field_struct = resolve_struct_type(field.type, status);
		if (
			field_struct &&
			!field_struct.is_class &&
			is_load_deep_copy_container(field_struct.name) &&
			struct_needs_destroy(field_struct, status) &&
			field_struct.functions.find((f) => f.name === "copy")
		) {
			out.push(`${flv} = ${field_struct.name}_copy(&${flv});\n`);
			continue;
		}
		const nested_enum = status.enums.find(
			(e) => e.name === field.type.name && e.has_associated_data,
		);
		if (nested_enum && enum_copy_is_deep(nested_enum, status)) {
			out.push(`${flv} = ${nested_enum.name}_copy(${flv});\n`);
			continue;
		}
		emit_pointee_owned_copies(flv, field.type, status, visiting, out);
	}
}

/** The fields the pointee's destroy reclaims: an OWNING struct's
 *  trait-declared fields are uniformly heap (the ctor strdup'd their
 *  defaults) and join the walk, mirroring `class_destroy_fields`. */
function clone_fields(pointee: StructNode, status: BuildStatus): DeclarationNode[] {
	if (!owns_strings_uniformly(pointee) || !pointee.traits.length) return pointee.fields;
	const extra: DeclarationNode[] = [];
	for (const trait_name of pointee.traits) {
		const trait = status.traits.find((t) => t.name === trait_name);
		if (!trait) continue;
		for (const f of trait.fields) {
			if (!pointee.fields.find((nf) => nf.name === f.name)) extra.push(f);
		}
	}
	return extra.length ? [...pointee.fields, ...extra] : pointee.fields;
}
