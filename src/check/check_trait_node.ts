import add_error from "../add_error.ts";
import TraitNode from "../nodes/TraitNode.ts";
import check_declaration_node from "./check_declaration_node.ts";
import check_function_node from "./check_function_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import { bind_comptime_self, expand_struct_member_pragmas } from "./utils/comptime.ts";
import { slot_requires_mv } from "./utils/mv_rule.ts";
import { is_class_type } from "./utils/ownership.ts";
import { uses_comptime_self } from "./utils/trait_defaults.ts";
import type_name from "./utils/type_name.ts";

export default function check_trait_node(trait: TraitNode, status: CheckStatus) {
	// Stage 3: expand the body's `#for` member loops before the members are
	// processed (mirrors check_struct_node); `#if` member arms folded at the
	// start of check.
	expand_struct_member_pragmas(trait, status);

	if (!status.types.includes(trait.name)) {
		status.types.push(trait.name);
	}
	if (!status.traits.find((t) => t.name === trait.name)) {
		status.traits.push(trait);
	}

	// A `$`-generated trait binds `Self` in its member bodies to its own
	// name before the walk checks them (stage 6).
	bind_comptime_self(trait, status);

	// Register generic trait type params (e.g. `trait Viewable<T>`) so the
	// trait's own method/field signatures may reference them. Mirrors how
	// check_struct_node scopes a generic struct's type params.
	const types_length_before = status.types.length;
	status.types.push(...trait.type_params);
	const type_params_length_before = status.type_params.length;
	status.type_params.push(...trait.type_params);

	for (let decl of trait.fields) {
		// The ownership-spelling rules key on this: a trait field's `mv` is
		// the slot's declaration, never a transfer marker, so the
		// fresh-init rule in check_declaration_node must exempt it. (The
		// field's `scope` stays unset — the access check's visibility
		// leniency for trait fields depends on it.)
		decl.is_trait_field = true;
		// A `view T name` field (the view DECLARATION keyword) normalizes its
		// type inside check_declaration_node — after this walk — so stamp the
		// borrow here: a view member is never an owner.
		if (decl.declaration === "view") {
			decl.type.is_view = true;
		}
		if (decl.declaration === "var" && decl.type.name && is_class_type(decl.type.name, status)) {
			add_error(status, `class-type fields must use 'mv', not 'var'`, decl.start);
		}
		// The ownership-spelling rule (mirrors check_struct_node's field
		// walk): an OWNING-typed trait field spells `mv` — conformers
		// inherit the slot, so the declaration is where ownership is
		// explicit. Type-param fields stay implicit.
		if (
			decl.declaration !== "mv" &&
			decl.declaration !== "const" &&
			slot_requires_mv(decl.type, status)
		) {
			add_error(
				status,
				`field '${decl.name}' owns memory — declare it 'mv ${type_name(decl.type)} ${decl.name}' (plain 'var' is for non-owning types)`,
				decl.start,
			);
		}
		check_declaration_node(decl, status);
	}

	for (let func of trait.functions) {
		// A trait method dispatches on the receiver, so it must declare one —
		// a method with no `self` parameter is static, and a static cannot
		// dispatch through a trait vtable. `#`-prefixed lifecycle markers
		// (`#init`/`#destroy`/`#spawn`) are construction hooks, not dispatch
		// entries, and keep their own receiver rules.
		if (!func.name.startsWith("#") && !func.params.some((p) => p.is_self_param)) {
			add_error(
				status,
				`trait method '${func.name}' must declare 'self' — instance methods take a receiver ('func ${func.name} = (self, …)')`,
				func.start,
			);
		}
		// A default body that binds `Self` (the conformer) can neither be
		// checked nor emitted at the trait level — `META.info(#self)` and the
		// `#for` walk over its fields resolve only per conformer. Marking it
		// generic (Self as a type param) defers the body (R3); the
		// per-conformer clones (utils/trait_defaults.ts) are checked fresh.
		if (trait.type_params.length === 0 && !func.type_params.includes("#self")) {
			if (uses_comptime_self(func)) {
				func.type_params.push("#self");
			}
		}
		check_function_node(func, status);
	}

	status.type_params.length = type_params_length_before;
	status.types.length = types_length_before;
}
