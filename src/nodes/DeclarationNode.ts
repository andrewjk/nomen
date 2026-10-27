import BaseNode from "./BaseNode.ts";
import ParameterNode from "./ParameterNode.ts";
import Type from "./Type.ts";

export default class DeclarationNode extends BaseNode {
	visibility: "pub" | "private" | "internal";
	declaration: "const" | "var" | "mv" | "view" | "ref";
	/**
	 * True for a `readonly` field: readable per its visibility, but assignable
	 * only from within the declaring struct/class's own methods (including its
	 * `extend`s and monomorphized clones). Stored as `declaration: "var"` so
	 * every storage/codegen path treats it identically to a plain field; only
	 * the write check in check_assignment_node consults this flag.
	 */
	is_readonly?: boolean;
	/**
	 * True for a declaration written with the `view` keyword (`view T x`).
	 * The checker normalizes `declaration` to `"const"` for view bindings, so
	 * this preserves the original keyword — a `view` field is a re-pointable
	 * view, not an immutable `const` field.
	 */
	is_view_keyword?: boolean;
	/**
	 * True for an object-alias binding written with the `ref` keyword
	 * (`ref T x = y`, STRUCT_PLAN_3 Phase A). The checker normalizes
	 * `declaration` to `"const"` (a ref binding is not reassignable), so this
	 * preserves the original keyword while the alias semantics ride on
	 * `class_alias_of`. Reference types only (classes).
	 */
	is_ref_binding?: boolean;
	name: string;
	type: Type;
	value?: BaseNode;
	constraint?: BaseNode;
	name_start?: number;
	type_start?: number;
	/** True when this top-level declaration is in the appended System library
	 * source. Set by mark_library_nodes; used to route root-scope globals
	 * (e.g. `const MAX_DIM`) to the correct TU in the System-lib split. */
	is_library?: boolean;
	/**
	 * GOOSE.md #4, donor form: this binding's initializer constructs
	 * directly into the named container's fresh slot (NRVO-to-slot) because
	 * the immediately following statement is `items.push(mv <name>)` and
	 * this binding has no other use — the binding itself never materializes
	 * (no storage, no scope-exit free; the push is just the length bump).
	 * `container` is the generic container name (`List`/`StableList`) — the
	 * mono is `${container}_${elem}` at build time. Stamped by
	 * check_function_call; the push carries the mirror stamp
	 * (`AccessFunctionCallNode.in_place_donor_name`).
	 */
	in_place_push_slot?: { receiver: string; container: string };
	func_params?: ParameterNode[];
	func_return_type?: Type;
	scope?: BaseNode;
	/** Optional swap replacement for `var X b = mv obj.field swap <expr>`: the
	 *  expression stored back into the moved-out field to revalidate it. */
	swap?: BaseNode;
	/** True for the synthesized loop-iterator binding (`var <item> = arr.at(i)`)
	 *  the for-of desugaring prepends to the loop body. It is rebound every
	 *  iteration by the loop, not by user code, so the `var`-never-changed
	 *  warning must not fire for it. */
	is_loop_iterator?: boolean;
	/** Set by the build's mv-on-last-use pass (STRING_PLAN tranche 4, see
	 *  check/utils/last_use.ts) when this declare is `var u = t` with t an
	 *  owned string local proven never read or written again: the backends
	 *  transfer the pair and the ownership mark instead of strdup'ing a copy.
	 *  Consumers must also honor the live kill-switch. */
	last_use_move?: boolean;
	/** True for a hoisted call-argument temp (`_param_N`) whose initializer is
	 *  an array literal but whose callee parameter is a heap `Array<T>` (the
	 *  monomorphized `Array_<T>` struct exists). The temp must be materialised
	 *  as a heap `Array_<T>` buffer (not a stack array) so the promoted
	 *  `struct Array_<T>*` parameter's `.length`/`.at`/`.set`/iteration see the
	 *  struct layout. Set at check time by check_function_call; consumed by the
	 *  build backends' declaration emitters. */
	is_heap_array_literal?: boolean;
	/** True for a root `const string[] = [...]` declaration: Mach-O arm64
	 *  forbids pointer relocations in data sections, so the file-scope data
	 *  emission lays out only the length word + zeroed element space, and the
	 *  declaration is collected into main's prologue to store the rodata
	 *  label addresses at runtime. Set by the aarch64 build_block_node root
	 *  scan; consumed by build_declaration_node's rebuild inside main. */
	global_runtime_init?: boolean;
	/** True for a root-scope `var` declaration collected into main's prologue
	 *  (module-init statement): its INITIALIZER runs inside main, but its
	 *  STORAGE is a module-scope data symbol — other functions reference it
	 *  by symbol, so a main frame slot would leave them undefined at link
	 *  time. Set by the aarch64 build_block_node root scan; consumed by
	 *  build_declaration_node's storage decision. */
	is_module_init?: boolean;
	/** True for a hoisted call-argument temp (`_param_N`) that is a heap COPY
	 *  of a stack-array local, bound to a heap `Array<T>` param (non-`ref`).
	 *  `value` is the source ValueNode; the temp is materialised as a heap
	 *  `Array_<T>` buffer whose elements are copied from the source's inline
	 *  storage at build time. Set at check time by check_function_call;
	 *  consumed by the build backends' declaration emitters. */
	is_heap_array_copy?: boolean;
	/** Trait name for a trait-typed local whose concrete storage is a class
	 *  instance (`var Speaker s = Dog()`): the C backend reclaims it at scope
	 *  exit / reassignment through the `<Trait>_destroy` vtable shim. Carried
	 *  on THIS declaration rather than a body-global name map so a same-named
	 *  variable in a sibling or shadowing scope can never inherit the binding
	 *  (a stale name-keyed entry emitted `<Trait>_destroy(v)` for int/string
	 *  elements — invalid C). Set at build time by the C declaration builder;
	 *  consumed by build_auto_free and the reassignment path. */
	trait_class_trait?: string;
	/** Concrete struct name for a trait-typed local whose slot holds INLINE
	 *  value-struct storage (`var Rule r = HeadingV()`): copies of the slot
	 *  (`var Rule r2 = r`) must declare the SAME concrete struct — the trait
	 *  typedef is an empty struct and cannot hold the value. Carried on THIS
	 *  declaration (scope-correct, same rationale as trait_class_trait). Set
	 *  at build time by the C declaration builder; consumed when building
	 *  another declaration initialized from this variable. */
	trait_concrete_struct?: string;
	/** True for a hoisted field-override temp (`_fov_N`) whose `string`
	 *  initializer is a borrow the temp must OWN: the base of the literal
	 *  lands (and may displace/free the source field) before the override
	 *  assignment runs, so an alias would dangle. Both backends' declaration
	 *  paths strdup the initializer and free the temp's copy at scope exit.
	 *  Set at build time by hoist_field_overrides. */
	force_owned_string?: boolean;
	/** True for an OWNED value-struct PARAMETER whose string fields the
	 *  callee frees at scope exit: the field accesses (and the record-free
	 *  emitted by free_scoped_declarations) go through the param POINTER
	 *  (`p->field`) instead of value syntax (`p.field`). Set at build time
	 *  when the function builder seeds pass-by-value struct params. */
	string_fields_via_pointer?: boolean;
	/** True alongside string_fields_via_pointer when the caller materialized
	 *  a heap shell for the argument (pass-by-value): the callee frees the
	 *  shell itself at scope exit (`free(p)`) after freeing the fields. */
	owned_heap_shell?: boolean;
	/** True for a `mv` param of a mv VALUE-struct type: the caller
	 *  passed its storage by address, so the callee owns the CONTENTS but not
	 *  the storage. free_scoped_declarations destroys the fields' owned
	 *  resources at `(*param)` at scope exit — never a free. Set at build
	 *  time by the C function/method builders; consumed by
	 *  free_scoped_declarations. */
	moved_value_struct_param?: boolean;
	constructor(
		start: number,
		visibility: "pub" | "private" | "internal",
		declaration: "const" | "var" | "mv" | "view" | "ref",
		name: string,
		type?: Type,
		value?: BaseNode,
	) {
		super("declare", start);
		this.visibility = visibility;
		this.declaration = declaration;
		this.name = name;
		this.type = type || new Type("");
		this.value = value;
	}
}
