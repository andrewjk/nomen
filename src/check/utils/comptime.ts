import add_error from "../../add_error.ts";
import { mono_type_name } from "../../build_common/mono_name.ts";
import { get_built_in_type } from "../../built_in_types.ts";
import { is_int_type } from "../../built_in_types.ts";
import default_platform from "../../default_platform.ts";
import AccessFieldNode from "../../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import AssignmentNode from "../../nodes/AssignmentNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import { is_ast_node } from "../../nodes/child_nodes.ts";
import clone_node from "../../nodes/clone_node.ts";
import FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import GroupedNode from "../../nodes/GroupedNode.ts";
import IfElseNode from "../../nodes/IfElseNode.ts";
import type IndexNode from "../../nodes/IndexNode.ts";
import NestedBlockNode from "../../nodes/NestedBlockNode.ts";
import OperationNode from "../../nodes/OperationNode.ts";
import PragmaForNode from "../../nodes/PragmaForNode.ts";
import type StructNode from "../../nodes/StructNode.ts";
import Type from "../../nodes/Type.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type AttributeMeta from "../../types/AttributeMeta.ts";
import type CheckStatus from "../CheckStatus.ts";
import { distribute_member, fold_member_pragmas, type PragmaConsts } from "./pragma.ts";
import { resolve_declared_struct } from "./resolve_declared_type.ts";

/** The fold consts for generated code's member pragmas (the main fold ran
 *  at check() start, before any generation existed). */
function status_consts(status: CheckStatus): PragmaConsts {
	return {
		arch: status.arch ?? "c",
		platform: status.platform ?? default_platform(),
	};
}

/** Fold the member pragmas of GENERATED types inside an expansion — their
 *  bodies did not exist at check() start, so the main fold never saw
 *  them. */
function fold_generated_member_pragmas(statements: BaseNode[], status: CheckStatus): void {
	for (const stmt of statements) {
		if (stmt.node_type === "struct" || stmt.node_type === "trait") {
			fold_member_pragmas(stmt as unknown as MemberHost, status_consts(status), status);
		}
	}
}

/** Bind `Self` inside a GENERATED type's members: the `#{field.name}`-spliced
 *  struct's own name substitutes for `Self`, so its methods can reflect on
 *  themselves (`META.info(#self).name`) exactly like a trait default does.
 *  Called from check_struct_node/check_trait_node AFTER the type is
 *  registered — the comptime chains resolve against the registry. The
 *  expansion stamps `is_comptime_generated`; this runs before the member
 *  walk checks the bodies. */
export function bind_comptime_self(
	host: MemberHost & { name: string; is_comptime_generated?: boolean },
	status: CheckStatus,
): void {
	if (!host.is_comptime_generated || !host.name) return;
	const substitution = new Map<string, string>([["#self", host.name]]);
	for (const member of host.functions) {
		// The method bodies parsed while the generated type's name was still
		// the splice path — retype `self` now that the name is known.
		for (const param of member.params) {
			if (param.is_self_param) param.type = new Type(host.name);
		}
		substitute_pragma_iterables(member.statements ?? [], substitution);
		rewrite_meta_name_chains(member.statements ?? [], status, substitution);
	}
	for (const pragma of host.member_pragmas ?? []) {
		if (pragma.node_type === "pragma_for") {
			substitute_pragma_iterables([(pragma as PragmaForNode).iterable], substitution);
		}
	}
}

/**
 * Compile-time field reflection — `#for field of META.info(T).fields` —
 * docs/COMPTIME_PLAN_2.md stage 2 (R2–R6, R8).
 *
 * The phase contract (R2): expansion happens at CHECK time and produces
 * ordinary AST before the arm is checked — one freshly-scoped block per
 * field (the R8 hygiene: per-iteration scope instead of name suffixes, so
 * unrolled locals cannot collide). Concrete `T` expands when the checker
 * reaches the node; `T` still in `status.type_params` defers (R3) — the
 * node survives into the specialization, which is re-checked from
 * scratch, and unrolls there. A `T` that neither defers nor resolves is a
 * compile error, never a silent drop.
 *
 * The binding is comptime (R4): it exists only during expansion and is
 * erased here — `<b>.name` / `<b>.type.name` rewrite to string literals,
 * `<b>.get(obj)` to an ordinary field access, `<b>.set(obj, v)` to an
 * ordinary assignment (R5 — methods on the binding, so no lvalue plumbing
 * is needed). Comptime string concat folds literals eagerly (R6), and an
 * `if` whose condition became comptime-constant folds to its live arm
 * (the same shape the monomorphizer's fold_substituted_constant_ifs
 * applies to substituted `T_*` conditions).
 */

/** One comptime field binding value: what `META.info(T).fields[i]` is. */
interface ComptimeField {
	name: string;
	type_name: string;
	index: number;
	/** The type-argument expression the loop reflects over, as written
	 *  (e.g. `T` in a generic body, `Sample` in a concrete one) — lets
	 *  `META.info(T).name` resolve to the same type. */
	type_argument: string;
	/** Attributes declared above the field (`@Name("x")` — stage 3). */
	attrs?: AttributeMeta[];
	/** The field's declared type — the root of comptime type expressions
	 *  (`field.type.name`, `.arg_count`, `.args[i]`, recursively). */
	type_value?: Type;
}

type ComptimeValue =
	| { kind: "bool"; value: boolean }
	| { kind: "string"; value: string }
	| { kind: "int"; value: number };

type IterableResolution =
	| { struct: StructNode }
	| { deferred: true }
	| { error: string; start: number };

/** A type body that can receive generated members (StructNode/TraitNode
 *  shape — the expansion and the member fold only need these). */
export interface MemberHost {
	fields: import("../../nodes/DeclarationNode.ts").default[];
	functions: import("../../nodes/FunctionNode.ts").default[];
	member_pragmas?: BaseNode[];
}

/**
 * Resolve a `#{field.name}` comptime name splice: the stored template is
 * either a bare dotted path (`field.name`) or a template of literal text
 * with `#{path}` markers (`get_#{field.name}`, `#{field.name}_handler`,
 * `pre_#{field.name}_post`). Each dotted path is rebuilt as an expression
 * over the binding, run through the ordinary substitution rewrite, and
 * must fold to a comptime string; the pieces concatenate into the
 * member's real name.
 */
export function resolve_comptime_name(
	template: string,
	binding: string,
	field: ComptimeField,
	status: CheckStatus,
	start: number,
): string | undefined {
	const fold_path = (path: string): string | undefined => {
		const segments = path.split(".");
		if (segments.length < 2 || segments[0] !== binding) {
			add_error(
				status,
				`'#${path}' must be a dotted path over the '#for' binding ('${binding}.name')`,
				start,
			);
			return undefined;
		}
		let expr: BaseNode = new ValueNode(start, segments[0]);
		for (let i = 1; i < segments.length; i++) {
			expr = new AccessNode(start, expr, new AccessFieldNode(start, segments[i]));
		}
		const rewritten = rewrite(expr, false, binding, field, status);
		const text = literal_string(rewritten);
		if (text === undefined) {
			add_error(status, `'#${path}' must fold to a comptime string`, start);
			return undefined;
		}
		return text;
	};
	if (!template.includes("#{")) return fold_path(template);
	let out = "";
	let last = 0;
	for (const m of template.matchAll(/#\{([^}]+)\}/g)) {
		out += template.slice(last, m.index);
		const piece = fold_path(m[1]);
		if (piece === undefined) return undefined;
		out += piece;
		last = m.index + m[0].length;
	}
	out += template.slice(last);
	return out;
}

/**
 * Expand a type body's `#for` member loops — `#for field of
 * META.info(T).fields { <members> }` inside a struct/trait body (the
 * stage-3 gap). Runs at the type's own check, BEFORE its members are
 * processed: each iteration clones the arm's members, resolves `#`-spliced
 * names through the binding, rewrites comptime uses (defaults, bodies),
 * and appends the members to `fields`/`functions`. Concrete `T` only —
 * struct-scope reflection cannot defer (there is no specialization to
 * re-check a type body), so an unbound type parameter is a compile error.
 * `#if` member pragmas were already folded at the start of check; a
 * leftover pragma of any other kind is left untouched for its own pass.
 */
export function expand_struct_member_pragmas(host: MemberHost, status: CheckStatus): void {
	const pragmas = host.member_pragmas ?? [];
	if (pragmas.length === 0) return;
	const kept: BaseNode[] = [];
	for (const pragma of pragmas) {
		if (pragma.node_type !== "pragma_for") {
			kept.push(pragma);
			continue;
		}
		const loop = pragma as PragmaForNode;
		const resolved = resolve_meta_iterable(loop.iterable, status);
		if ("error" in resolved) {
			add_error(status, resolved.error, resolved.start);
			continue;
		}
		if ("deferred" in resolved) {
			add_error(
				status,
				`'#for' at struct/trait-body scope cannot defer — reflect over a concrete type, not a type parameter`,
				loop.iterable.start,
			);
			continue;
		}
		const source = resolved.struct;
		const typed_fields = source.fields.filter((f) => f.type && f.type.name);
		const type_argument = iterable_type_argument(loop.iterable);
		typed_fields.forEach((f, index) => {
			const field: ComptimeField = {
				name: f.name,
				type_name: (f.type as Type).name,
				index,
				type_argument,
				attrs: (f as unknown as { attrs?: AttributeMeta[] }).attrs,
				type_value: f.type as Type,
			};
			for (const arm of loop.block.statements ?? []) {
				const cloned = clone_node(arm);
				for (const member of rewrite_statement(cloned, loop.binding, field, status)) {
					distribute_member(member, host, status);
					// A generated METHOD may reflect on the conformer it lands
					// on (`META.info(#self).name`) — bind `Self` to the host's
					// name now, before the walk checks the body.
					if (member.node_type === "func") {
						const self_substitution = new Map<string, string>([
							["#self", (host as unknown as { name: string }).name],
						]);
						const generated_body = (member as unknown as { statements?: BaseNode[] }).statements;
						substitute_pragma_iterables(generated_body ?? [], self_substitution);
						rewrite_meta_name_chains(generated_body ?? [], status, self_substitution);
					}
					fold_generated_member_pragmas([member], status);
					if (member.node_type === "struct" || member.node_type === "trait") {
						(member as unknown as { is_comptime_generated?: boolean }).is_comptime_generated = true;
					}
				}
			}
		});
	}
	host.member_pragmas = kept;
}

function unwrap_grouped(node: BaseNode | undefined): BaseNode {
	let current = node as BaseNode;
	while (current && current.node_type === "grouped") {
		current = (current as GroupedNode).value;
	}
	return current;
}

/**
 * Recognize `META.info(T).fields` structurally and resolve `T`.
 * Deferred when `T` is an unbound type parameter (R3); an error when `T`
 * names nothing (which includes a type parameter that survived into a
 * re-checked body — there it means specialization never bound it).
 */
function resolve_meta_iterable(node: BaseNode, status: CheckStatus): IterableResolution {
	const fields_access = unwrap_grouped(node);
	if (
		fields_access.node_type !== "access" ||
		(fields_access as AccessNode).access.node_type !== "access_field" ||
		((fields_access as AccessNode).access as AccessFieldNode).name !== "fields"
	) {
		return {
			error: "#for iterates META.info(T).fields — other iterables are not comptime values",
			start: node.start,
		};
	}
	const info_call = unwrap_grouped((fields_access as AccessNode).target);
	if (
		info_call.node_type !== "access" ||
		(info_call as AccessNode).target.node_type !== "value" ||
		((info_call as AccessNode).target as ValueNode).value !== "META" ||
		(info_call as AccessNode).access.node_type !== "access_func" ||
		((info_call as AccessNode).access as AccessFunctionCallNode).name !== "info"
	) {
		return {
			error: "#for iterates META.info(T).fields — other iterables are not comptime values",
			start: node.start,
		};
	}
	const args = ((info_call as AccessNode).access as AccessFunctionCallNode).params ?? [];
	const type_arg = unwrap_grouped(args[0]);
	if (
		args.length !== 1 ||
		type_arg.node_type !== "value" ||
		(type_arg as ValueNode).value.startsWith('"')
	) {
		return {
			error: "META.info takes a type name — META.info(T) where T is a struct type",
			start: info_call.start,
		};
	}
	const type_name = (type_arg as ValueNode).value;

	if (status.type_params.includes(type_name)) {
		// R3: inside a generic body the parameter is unbound — defer, the
		// specialization re-checks the cloned body and expands there.
		return { deferred: true };
	}
	const declared = resolve_declared_struct(type_name, status);
	if (!declared) {
		return {
			error: `META.info: unknown type '${type_name}' — reflection is over struct types`,
			start: info_call.start,
		};
	}
	const struct = declared as StructNode;
	if (struct.type_params.length > 0 || struct.is_generic) {
		return {
			error: `META.info: '${type_name}' is generic — reflect over a concrete instantiation`,
			start: info_call.start,
		};
	}
	return { struct };
}

/**
 * Expand a `#for` node into per-field iteration blocks, or return null to
 * defer (R3). Each iteration deep-clones the arm (clone_node preserves
 * prototypes and checker stamps), rewrites the binding's comptime uses
 * into ordinary AST, stamps `spawn_of` (R7), and wraps the result in a
 * fresh block scope (R8). Returns [] on error (the pragma is consumed —
 * downstream never sees a node it doesn't know).
 */
export function expand_pragma_for(node: PragmaForNode, status: CheckStatus): BaseNode[] | null {
	const resolved = resolve_meta_iterable(node.iterable, status);
	if ("error" in resolved) {
		add_error(status, resolved.error, resolved.start);
		return [];
	}
	if ("deferred" in resolved) return null;
	const struct = resolved.struct;

	const typed_fields = struct.fields.filter((f) => f.type && f.type.name);
	const type_argument = iterable_type_argument(node.iterable);
	const iterations: BaseNode[] = [];
	typed_fields.forEach((f, index) => {
		// A mono-NAMED field type (Buffer<T> re-routed to Buffer_Feature)
		// carries no type_args — the backend's spelling dispatch relies on
		// name-only monos, so the args are recovered HERE for reflection
		// (the struct's source_type_args), keeping the AST pristine.
		const raw_type = f.type as Type;
		let reflect_type: Type = raw_type;
		if (!raw_type.type_args?.length && raw_type.name) {
			const mono = status.structs.findLast((s) => s.name === raw_type.name);
			const source_args = (mono as unknown as { source_type_args?: Type[] } | undefined)
				?.source_type_args;
			if (source_args?.length) {
				const synthesized = new Type(raw_type.name);
				synthesized.type_args = source_args.map((arg) => arg);
				synthesized.is_ref = raw_type.is_ref;
				synthesized.is_view = raw_type.is_view;
				synthesized.is_nullable = raw_type.is_nullable;
				reflect_type = synthesized;
			}
		}
		const field: ComptimeField = {
			name: f.name,
			type_name: raw_type.name,
			index,
			type_argument,
			attrs: (f as unknown as { attrs?: AttributeMeta[] }).attrs,
			type_value: reflect_type,
		};
		const body = (node.block.statements ?? []).map((s) => clone_node(s));
		const rewritten: BaseNode[] = [];
		for (const stmt of body) {
			rewritten.push(...rewrite_statement(stmt, node.binding, field, status));
		}
		for (const s of rewritten) {
			// R7: point diagnostics from generated code at the `#for`.
			s.spawn_of = node.start;
		}
		// Generated types carry member pragmas that the check()-start fold
		// never saw — fold them now (stage 3/6) — and stamp them so their
		// own check binds `#self` to the generated name.
		fold_generated_member_pragmas(rewritten, status);
		for (const s of rewritten) {
			if (s.node_type === "struct" || s.node_type === "trait") {
				(s as unknown as { is_comptime_generated?: boolean }).is_comptime_generated = true;
			}
		}
		iterations.push(new NestedBlockNode(node.block.start, rewritten));
	});
	return iterations;
}

/** The type name a `#for`'s iterable reflects over, as written in source. */
function iterable_type_argument(iterable: BaseNode): string {
	const fields_access = unwrap_grouped(iterable);
	if (fields_access.node_type !== "access") return "";
	const info_call = unwrap_grouped((fields_access as AccessNode).target);
	if (info_call.node_type !== "access") return "";
	const args = ((info_call as AccessNode).access as AccessFunctionCallNode).params ?? [];
	const arg = unwrap_grouped(args[0]);
	return arg && arg.node_type === "value" ? (arg as ValueNode).value : "";
}

/**
 * Rename a pragma iterable's type-parameter references through a
 * monomorphization substitution map (`T` -> `Pt`), so a `#for` that
 * deferred inside a generic body resolves once the specialization binds
 * the parameter. Only ValueNodes inside pragma_for ITERABLES are touched —
 * a blanket rename would corrupt ordinary runtime values named `T`.
 */
export function substitute_pragma_iterables(
	statements: BaseNode[],
	substitution: Map<string, string>,
): void {
	const visit = (node: BaseNode): void => {
		if (node.node_type === "pragma_for") {
			const loop = node as PragmaForNode;
			const rename = (n: BaseNode): BaseNode => {
				if (n.node_type === "value") {
					const value = (n as ValueNode).value;
					if (substitution.has(value)) return new ValueNode(n.start, substitution.get(value)!);
					return n;
				}
				for (const key in n) {
					if (key === "parent" || key === "scope") continue;
					const child = (n as unknown as Record<string, unknown>)[key];
					if (Array.isArray(child)) {
						(n as unknown as Record<string, unknown>)[key] = child.map((c) =>
							is_ast_node(c) ? rename(c as BaseNode) : c,
						);
					} else if (is_ast_node(child)) {
						(n as unknown as Record<string, unknown>)[key] = rename(child as BaseNode);
					}
				}
				return n;
			};
			loop.iterable = rename(loop.iterable);
			// Descend into nested pragmas inside the arm too.
			for (const stmt of loop.block.statements ?? []) visit(stmt);
			return;
		}
		for (const key in node) {
			if (key === "parent" || key === "scope") continue;
			const child = (node as unknown as Record<string, unknown>)[key];
			if (Array.isArray(child)) {
				for (const c of child) if (is_ast_node(c)) visit(c as BaseNode);
			} else if (is_ast_node(child)) {
				visit(child as BaseNode);
			}
		}
	};
	for (const stmt of statements) visit(stmt);
}

/**
 * Expand every `#for` in a statement list in place — the mono-clone hook.
 * Used where a cloned body will NOT be re-checked (monomorphized struct
 * methods are stamped `checked = true`), mirroring how the substituted
 * `T_*` condition arms are folded there instead of re-checked. Deferred
 * loops whose parameter still doesn't resolve produce a compile error.
 */
export function expand_pragma_fors_in_list(statements: BaseNode[], status: CheckStatus): void {
	for (let i = 0; i < statements.length; i++) {
		const stmt = statements[i];
		if (stmt.node_type !== "pragma_for") {
			// Descend: arms and bodies can carry their own loops.
			for (const key in stmt) {
				if (key === "parent" || key === "scope") continue;
				const child = (stmt as unknown as Record<string, unknown>)[key];
				if (Array.isArray(child) && child.every(is_ast_node) && key === "statements") {
					expand_pragma_fors_in_list(child as BaseNode[], status);
				} else if (is_ast_node(child)) {
					expand_pragma_fors_in_list([child as BaseNode], status);
				}
			}
			continue;
		}
		const iterations = expand_pragma_for(stmt as PragmaForNode, status);
		if (iterations === null) continue; // deferred — specialization re-checks
		statements.splice(i, 1, ...iterations);
		i += iterations.length - 1;
	}
}

/**
 * Rewrite one arm statement into its comptime-substituted form. Returns a
 * LIST because a comptime `if` folds to zero-or-more statements (the
 * substitutions happen inside `rewrite`; the comptime-constant `if` fold
 * matches the monomorphizer's substituted-condition precedent).
 */
function rewrite_statement(
	stmt: BaseNode,
	binding: string,
	field: ComptimeField,
	status: CheckStatus,
): BaseNode[] {
	// A comptime-constant `if` folds to its live arm — but the condition is
	// substituted and evaluated FIRST, so a dead arm never surfaces comptime
	// errors (e.g. an `.attr` that only exists on the taken side). The
	// comptime analogue of the monomorphizer's substituted-condition fold,
	// with the dead-arm skip the runtime `if` path can't do.
	if (stmt.node_type === "if") {
		const if_else = stmt as IfElseNode;
		if_else.condition = rewrite(if_else.condition, false, binding, field, status);
		const folded = evaluate_comptime(if_else.condition);
		if (folded && folded.kind === "bool") {
			const arm = folded.value
				? (if_else.if_branch ?? { statements: [] as BaseNode[] })
				: (if_else.else_branch ?? { statements: [] as BaseNode[] });
			const out: BaseNode[] = [];
			for (const inner of arm.statements ?? []) {
				out.push(...rewrite_statement(inner, binding, field, status));
			}
			return out;
		}
	}
	const replaced = rewrite(stmt, true, binding, field, status);
	if (replaced !== stmt) return [replaced];
	return [stmt];
}

/**
 * The comptime substitution walk. Mutates freshly-cloned nodes in place;
 * returns a replacement node when the whole node rewrites (a `field.*`
 * chain becomes a literal/access/assignment). Statement-position is
 * tracked so `field.set(obj, v)` is only accepted where an assignment is
 * legal.
 */
function rewrite(
	node: BaseNode,
	statement_position: boolean,
	binding: string,
	field: ComptimeField,
	status: CheckStatus,
): BaseNode {
	// A `#`-spliced comptime NAME or TYPE resolves here, on ANY carrier —
	// declarations, methods, and types — so a member nested one level
	// deeper than the arm (a field of a `#for`-generated struct) resolves
	// too, not just top-level arm statements. The folded string replaces
	// the parser's empty-placeholder name/type before checking.
	const comptime_named = node as unknown as { comptime_name?: string };
	if (comptime_named.comptime_name !== undefined) {
		const name = resolve_comptime_name(
			comptime_named.comptime_name,
			binding,
			field,
			status,
			node.start,
		);
		(node as unknown as { name: string }).name = name ?? "";
	}
	const comptime_typed = node as unknown as { comptime_type_template?: string; type?: Type };
	if (comptime_typed.comptime_type_template !== undefined) {
		const type_name = resolve_comptime_name(
			comptime_typed.comptime_type_template,
			binding,
			field,
			status,
			node.start,
		);
		comptime_typed.type = new Type(type_name ?? "");
	}
	// Comptime TYPE expressions rooted at the binding — `field.type`,
	// `.name`, `.arg_count`, `.args[i]`, recursively (`.args[0].args[0]`).
	// Resolved before the generic descent, whose bare `.type` link would
	// error. Binding members (`.name` of the FIELD, `.get`, `.is_struct`)
	// are separate, below.
	if (node.node_type === "index" || node.node_type === "access") {
		const resolved = resolve_type_member(node, binding, field.type_value);
		if (resolved) {
			if (resolved.kind === "error") {
				add_error(status, resolved.error, resolved.error_start ?? node.start);
				return node;
			}
			if (resolved.kind === "string") return comptime_string(node.start, resolved.value ?? "");
			if (resolved.kind === "int") {
				const literal = new ValueNode(node.start, String(resolved.int ?? 0));
				literal.type = new Type("int", true);
				return literal;
			}
			if (resolved.kind === "type") {
				// `args[i]` (at any depth) denotes a TYPE — usable by name in
				// comparisons (`args[0] == "Feature"`); a bare `field.type`
				// has no value form at all.
				const base = unwrap_grouped(node);
				const is_base =
					base.node_type === "access" &&
					(base as AccessNode).access.node_type === "access_field" &&
					((base as AccessNode).access as AccessFieldNode).name === "type";
				if (!is_base) {
					return comptime_string(node.start, resolved.type?.name ?? "");
				}
				add_error(
					status,
					`#for: '${binding}.type' is only valid as .name, .arg_count or .args[i]`,
					node.start,
				);
				return node;
			}
			add_error(status, `#for: '${binding}.type.args' must be indexed — args[0]`, node.start);
			return node;
		}
	}
	if (node.node_type === "access") {
		const access = node as AccessNode;
		const target = unwrap_grouped(access.target);
		// `META.info(T).name` in expression position — the reflected type's
		// own name as a comptime string (R6). Only the SAME type the loop
		// reflects over resolves here; any other META use is a check error
		// downstream (META is not a runtime value).
		if (
			access.access.node_type === "access_field" &&
			((access.access as AccessFieldNode).name === "name" ||
				(access.access as AccessFieldNode).name === "field_count") &&
			target.node_type === "access" &&
			(target as AccessNode).access.node_type === "access_func" &&
			((target as AccessNode).access as AccessFunctionCallNode).name === "info" &&
			unwrap_grouped((target as AccessNode).target).node_type === "value" &&
			(unwrap_grouped((target as AccessNode).target) as ValueNode).value === "META"
		) {
			const args = ((target as AccessNode).access as AccessFunctionCallNode).params ?? [];
			const arg = unwrap_grouped(args[0]);
			if (
				args.length === 1 &&
				arg.node_type === "value" &&
				(arg as ValueNode).value === field.type_argument
			) {
				if ((access.access as AccessFieldNode).name === "name") {
					return comptime_string(node.start, field.type_name);
				}
				const count = status.structs
					.findLast((s) => s.name === field.type_name)
					?.fields.filter((f) => f.type && f.type.name).length;
				const literal = new ValueNode(node.start, String(count ?? 0));
				literal.type = new Type("int", true);
				return literal;
			}
		}
		if (target.node_type === "value" && (target as ValueNode).value === binding) {
			return rewrite_binding_access(node, access, statement_position, binding, field, status);
		}
	}
	if (node.node_type === "value" && (node as ValueNode).value === binding) {
		add_error(status, `#for binding '${binding}' used without .name, .get or .set`, node.start);
		return node;
	}

	// Comptime string concatenation (R6): `"a" + "b"` (post-substitution —
	// `META.info(T).name` already rewrote to a literal) folds to one
	// literal. Runtime concat (any non-literal operand) is left alone.
	if (node.node_type === "op") {
		const op = node as OperationNode;
		op.left_value = rewrite(op.left_value, false, binding, field, status);
		op.right_value = rewrite(op.right_value, false, binding, field, status);
		if (op.op === "+") {
			const left = literal_string(op.left_value);
			const right = literal_string(op.right_value);
			if (left !== undefined && right !== undefined) {
				return comptime_string(node.start, left + right);
			}
		}
		return node;
	}

	// Comptime-constant `if` folding happens at statement level
	// (rewrite_statement); here we only descend. Statement lists keep
	// statement position for their elements so `field.set` stays legal
	// inside nested bodies.
	for (const key in node) {
		if (key === "parent" || key === "scope") continue;
		const value = (node as unknown as Record<string, unknown>)[key];
		if (Array.isArray(value)) {
			if (value.every(is_ast_node)) {
				const is_statement_list = key === "statements";
				const out: BaseNode[] = [];
				for (const item of value as BaseNode[]) {
					if (is_statement_list) {
						out.push(...rewrite_statement(item, binding, field, status));
					} else {
						out.push(rewrite(item, false, binding, field, status));
					}
				}
				(node as unknown as Record<string, unknown>)[key] = out;
			}
		} else if (is_ast_node(value)) {
			(node as unknown as Record<string, unknown>)[key] = rewrite(
				value,
				false,
				binding,
				field,
				status,
			);
		}
	}
	return node;
}

/** Classify a type name for the comptime predicates: a plain struct (not a
 *  builtin, not generic/container), and a container (generic spelling or a
 *  monomorphized System container). */
function classify_type_name(
	name: string,
	status: CheckStatus,
): { is_struct: boolean; is_container: boolean } {
	const declared = resolve_declared_struct(name, status) as StructNode | undefined;
	const is_builtin = !!get_built_in_type(name);
	const generic_spelling = !!declared && declared.type_params.length > 0;
	// A MONO is a container when its CANONICAL generic is a System library
	// struct (`StableList_float` -> StableList, `Buffer_uint64` -> Buffer).
	// The old suffix-only test (`source_type_args` present) classified any
	// instantiation as a container — including a USER generic's mono, so
	// `Holder<StableList<Leaf>>` (name `Holder_StableList_Leaf`) dispatched
	// into the reflection-driven list encoder instead of the struct walker.
	const source_type_args = (declared as unknown as { source_type_args?: Type[] }).source_type_args;
	let mono_container = false;
	if (declared && source_type_args?.length) {
		const suffix = source_type_args.map((arg) => mono_type_name(arg)).join("_");
		if (declared.name.endsWith(suffix)) {
			const canonical_name = declared.name.slice(0, declared.name.length - suffix.length - 1);
			const canonical = status.structs.find(
				(s) => s.name === canonical_name && s.type_params.length > 0,
			);
			mono_container = !!canonical?.is_library;
		} else {
			// The name doesn't decompose into `<canonical>_<args>` (not
			// expected); keep the conservative container reading.
			mono_container = true;
		}
	}
	return {
		is_struct: !!declared && !is_builtin && !generic_spelling && !mono_container,
		is_container: generic_spelling || mono_container,
	};
}

/**
 * Whether a type name is a hashable scalar — an int type, `bool` or `char`:
 * the types whose value casts to `uint` for hashing. This is the hardcoded
 * derive's `is_hashable_scalar` rule lifted into comptime, exposed as
 * `field.is_scalar` / `META.is_scalar(T)` so library code (the `Hashable`
 * default body) can make the cast-vs-`.hash()` dispatch the old checker
 * synthesis made.
 */
function is_scalar_type_name(name: string): boolean {
	return is_int_type(name) || name === "bool" || name === "char";
}

/**
 * Resolve a comptime TYPE expression rooted at the binding's field type:
 *
 *   field.type                -> { type }
 *   field.type.name           -> { string }   (the type's name)
 *   field.type.arg_count      -> { int }      (number of type arguments)
 *   field.type.args           -> { list }     (indexable only)
 *   field.type.args[i]        -> { type }     (the i-th argument)
 *   ...recursively: field.type.args[0].args[0], .name, .arg_count
 *
 * Returns undefined for expressions not rooted at `field.type` (ordinary
 * user expressions fall through untouched). Structural problems come back
 * as `error` (with the offending start) for the caller to report.
 */
function resolve_type_member(
	node: BaseNode,
	binding: string,
	field_type: Type | undefined,
):
	| { kind: "type"; type?: Type }
	| { kind: "list"; items: Type[]; name?: string }
	| { kind: "string"; value: string }
	| { kind: "int"; int: number }
	| { kind: "error"; error: string; error_start?: number }
	| undefined {
	const n = unwrap_grouped(node);
	if (!n) return undefined;
	if (n.node_type === "index") {
		const index = n as IndexNode;
		const target = resolve_type_member(index.target, binding, field_type);
		if (!target) return undefined;
		if (target.kind === "error") return target;
		if (target.kind !== "list") {
			return { kind: "error", error: "only '.args' can be indexed", error_start: n.start };
		}
		const folded = evaluate_comptime(index.index);
		if (!folded || folded.kind !== "int") {
			return {
				kind: "error",
				error: `#for: '${binding}.type.args[...]' needs a comptime int index`,
				error_start: index.index?.start ?? n.start,
			};
		}
		const items = target.items ?? [];
		const at = folded.value;
		if (at < 0 || at >= items.length) {
			return {
				kind: "error",
				error: `#for: '${binding}.type.args[${at}]' out of range — type '${
					target.name ?? "?"
				}' has ${items.length} argument(s)`,
				error_start: n.start,
			};
		}
		return { kind: "type", type: items[at] };
	}
	if (n.node_type !== "access") return undefined;
	const access = n as AccessNode;
	if (access.access.node_type !== "access_field") return undefined;
	const member = (access.access as AccessFieldNode).name;
	const target = unwrap_grouped(access.target);
	if (target.node_type === "value" && (target as ValueNode).value === binding) {
		// The base: `field.type`.
		if (member !== "type") return undefined;
		return { kind: "type", type: field_type };
	}
	const inner = resolve_type_member(access.target, binding, field_type);
	if (!inner) return undefined;
	if (inner.kind === "error") return inner;
	if (inner.kind !== "type") return undefined;
	const t = inner.type as Type | undefined;
	if (member === "name") return { kind: "string", value: t?.name ?? "" };
	if (member === "arg_count") return { kind: "int", int: (t?.type_args ?? []).length };
	if (member === "args") return { kind: "list", items: t?.type_args ?? [], name: t?.name };
	return undefined;
}

function rewrite_binding_access(
	node: BaseNode,
	access: AccessNode,
	statement_position: boolean,
	binding: string,
	field: ComptimeField,
	status: CheckStatus,
): BaseNode {
	if (access.access.node_type === "access_func") {
		const call = access.access as AccessFunctionCallNode;
		const args = call.params ?? [];
		if (call.name === "has_attr" && args.length === 1) {
			// field.has_attr("Name") -> a comptime bool literal — folds in a
			// comptime `if`, gating the corresponding .attr use.
			const name = attr_arg_name(args[0], status, binding, call.name);
			if (name === undefined) return node;
			const present = (field.attrs ?? []).some((a) => a.name === name);
			const literal = new ValueNode(node.start, present ? "true" : "false");
			literal.type = new Type("bool", true);
			return literal;
		}
		if (call.name === "attr" && args.length === 1) {
			// field.attr("Name") -> the attribute's first value as a
			// comptime string (string content; int/bool literal text).
			const name = attr_arg_name(args[0], status, binding, call.name);
			if (name === undefined) return node;
			const meta = (field.attrs ?? []).find((a) => a.name === name);
			if (!meta || meta.values.length === 0) {
				add_error(
					status,
					`#for: field has no '@${name}' attribute — guard with ${binding}.has_attr("${name}")`,
					node.start,
				);
				return node;
			}
			return comptime_string(node.start, meta.values[0].text);
		}
		if (call.name === "get" && args.length === 1) {
			// field.get(obj) -> obj.<field> — an ordinary field access. The
			// argument is re-walked: it may itself use the binding
			// (`field.get(field.get(inner))`) or fold comptime strings.
			const arg = rewrite(clone_node(unwrap_grouped(args[0])), false, binding, field, status);
			return new AccessNode(node.start, arg, new AccessFieldNode(access.access.start, field.name));
		}
		if (call.name === "set" && args.length === 2) {
			if (!statement_position) {
				add_error(
					status,
					`#for: '${binding}.set(obj, value)' must be a statement — assign through .set at statement level`,
					node.start,
				);
				return node;
			}
			// field.set(obj, v) -> obj.<field> = v — an ordinary assignment,
			// so no lvalue plumbing is needed (R5). The value expression is
			// re-walked: a binding use inside it (`field.set(c, field.get(d))`
			// or a comptime concat) must rewrite too, not just the statement's
			// top level.
			const target = clone_node(unwrap_grouped(args[0]));
			const value = rewrite(clone_node(unwrap_grouped(args[1])), false, binding, field, status);
			return new AssignmentNode(
				node.start,
				new AccessNode(node.start, target, new AccessFieldNode(access.access.start, field.name)),
				value,
			);
		}
		add_error(
			status,
			`#for binding '${binding}' supports .name, .get(obj) and .set(obj, value) — not '.${call.name}'`,
			access.access.start,
		);
		return node;
	}
	const field_name = (access.access as AccessFieldNode).name;
	if (field_name === "name") {
		return comptime_string(node.start, field.name);
	}
	if (field_name === "is_struct") {
		// comptime bool: the field's type is a NON-builtin, non-generic
		// struct — a value the reflective decoder recurses into. Built-ins
		// (string/int/…) and container instantiations (StableList<float>,
		// StableList_Feature — source_type_args marks the mono) are false,
		// so scalar and struct branches never double-fire.
		const is_struct = classify_type_name(field.type_name, status).is_struct;
		const literal = new ValueNode(node.start, is_struct ? "true" : "false");
		literal.type = new Type("bool", true);
		return literal;
	}
	if (field_name === "is_scalar") {
		// comptime bool: the field's type is an int/bool/char — a value the
		// hash combine casts to uint (the lifted is_hashable_scalar rule).
		const literal = new ValueNode(
			node.start,
			is_scalar_type_name(field.type_name) ? "true" : "false",
		);
		literal.type = new Type("bool", true);
		return literal;
	}
	if (field_name === "type") {
		add_error(
			status,
			`#for: '${binding}.type' is only valid as '${binding}.type.name', '${binding}.type.arg_count' or '${binding}.type.args[i]'`,
			access.access.start,
		);
		return node;
	}
	add_error(
		status,
		`#for binding '${binding}' supports .name, .type.name, .type.arg_count, .type.args[i], .is_struct, .is_scalar, .get(obj) and .set(obj, value) — not '.${field_name}'`,
		access.access.start,
	);
	return node;
}

/** A comptime string literal node: a checked-shape static string value. */
function comptime_string(start: number, text: string): ValueNode {
	const value = new ValueNode(start, `"${text}"`);
	value.type = new Type("string", true);
	return value;
}

/** The (string-literal) argument of an attr/has_attr call, or an error. */
function attr_arg_name(
	arg: BaseNode | undefined,
	status: CheckStatus,
	binding: string,
	method: string,
): string | undefined {
	const value = unwrap_grouped(arg);
	if (!value || value.node_type !== "value") {
		add_error(
			status,
			`#for: '${binding}.${method}' takes an attribute name string`,
			arg?.start ?? 0,
		);
		return undefined;
	}
	const text = (value as ValueNode).value;
	if (text.length < 2 || !text.startsWith('"')) {
		add_error(status, `#for: '${binding}.${method}' takes an attribute name string`, value.start);
		return undefined;
	}
	return text.substring(1, text.length - 1);
}

function literal_string(node: BaseNode): string | undefined {
	const value = unwrap_grouped(node);
	if (value.node_type !== "value") return undefined;
	const text = (value as ValueNode).value;
	if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
		return text.substring(1, text.length - 1);
	}
	return undefined;
}

/**
 * Rewrite generic-construction calls (`T()`) through a specialization
 * substitution map — the second half of the feature (the declaration pass
 * leaves `T()` deferred: an unresolved call inside a generic body is
 * silently skipped while `status.type_params` is non-empty).
 *
 * A struct target becomes an ordinary constructor call (`T()` -> `Item()`);
 * a scalar target becomes its zero literal (`int` -> `0`, `float` -> `0.0`,
 * `bool` -> `false`, `string` -> `""`) — a call has no scalar form. Names
 * not in the map are untouched, so ordinary calls and enum shorthands pass
 * through. Unchecked bodies (a `#for` arm that deferred as a whole) are
 * covered too: any call whose name is a substituted type parameter can only
 * be the generic construct — types are not callable otherwise.
 *
 * With a `status`, a struct target whose constructor REQUIRES arguments
 * (fields without defaults) gets reflection-driven default construction
 * (COMPTIME_PLAN_2 stage 4 residual): the call synthesizes a zero value
 * per required parameter, recursively — a scalar parameter becomes its
 * zero literal, a nullable one `null`, a struct parameter a nested
 * constructor call built the same way (`Pair(0, 0)`, `Outer(Inner(0))`).
 * A shape the walk can't synthesize (variadic init, an enum/func/array
 * parameter, a cycle) leaves the call untouched, so the constructor's own
 * "Parameters missing" error surfaces — loud, never silently wrong.
 */
export function substitute_generic_constructs(
	statements: BaseNode[],
	substitution: Map<string, string>,
	status?: CheckStatus,
): void {
	const scalar_zero: Record<string, string> = {
		int: "0",
		int8: "0",
		int16: "0",
		int32: "0",
		int64: "0",
		uint: "0",
		uint8: "0",
		uint16: "0",
		uint32: "0",
		uint64: "0",
		float: "0.0",
		float32: "0.0",
		float64: "0.0",
		bool: "false",
		string: '""',
	};
	const zero_literal = (target: string, start: number): ValueNode | undefined => {
		const text = scalar_zero[target];
		if (text === undefined) return undefined;
		const literal = new ValueNode(start, text);
		literal.type = new Type(target, true);
		return literal;
	};

	// The zero-value EXPRESSION for a required constructor parameter's type.
	// `seen` is the per-path cycle guard: a value struct cannot contain
	// itself (infinite size), but a synthesized recursion must never walk
	// in circles — an impossible shape just fails the synthesis.
	const zero_expr_for_type = (
		t: Type | undefined,
		start: number,
		seen: Set<string>,
	): BaseNode | undefined => {
		if (!t?.name) return undefined;
		const scalar = scalar_zero[t.name];
		if (scalar !== undefined) {
			const literal = new ValueNode(start, scalar);
			literal.type = new Type(t.name, true);
			return literal;
		}
		if (t.is_nullable) {
			const literal = new ValueNode(start, "null");
			literal.type = new Type("null", true);
			return literal;
		}
		if (seen.has(t.name)) return undefined;
		const struct = status!.structs.findLast((s) => s.name === t.name);
		if (!struct || struct.is_generic) return undefined;
		const init = struct.functions.find((f) => f.name === "#init");
		if (!init || init.params.some((p) => p.is_variadic)) return undefined;
		const required = init.params.filter(
			(p) => !p.is_self_param && !p.default_value && !p.is_variadic,
		);
		const call = new FunctionCallNode(start, t.name);
		if (required.length > 0) {
			const inner_seen = new Set(seen);
			inner_seen.add(t.name);
			for (const param of required) {
				const expr = zero_expr_for_type(param.type, start, inner_seen);
				if (!expr) return undefined;
				call.params.push(expr);
			}
		}
		return call;
	};

	// Zero-value ARGUMENTS for a `T()` whose target's constructor requires
	// them (`given` = arguments the call already carries). Returns [] when
	// nothing is missing, undefined when the shape is out of scope.
	const zero_args_for = (target: string, start: number, given: number): BaseNode[] | undefined => {
		if (!status) return undefined;
		const struct = status.structs.findLast((s) => s.name === target);
		if (!struct || struct.is_generic) return undefined;
		const init = struct.functions.find((f) => f.name === "#init");
		if (!init || init.params.some((p) => p.is_variadic)) return undefined;
		const required = init.params.filter(
			(p) => !p.is_self_param && !p.default_value && !p.is_variadic,
		);
		if (given >= required.length) return [];
		const args: BaseNode[] = [];
		for (let i = given; i < required.length; i++) {
			const expr = zero_expr_for_type(required[i].type, start, new Set([target]));
			if (!expr) return undefined;
			args.push(expr);
		}
		return args;
	};

	const visit = (node: BaseNode): BaseNode => {
		// Recurse first so nested lists (arms, bodies) are processed.
		for (const key in node) {
			if (key === "parent" || key === "scope") continue;
			const value = (node as unknown as Record<string, unknown>)[key];
			if (Array.isArray(value)) {
				if (value.every(is_ast_node)) {
					(node as unknown as Record<string, unknown>)[key] = (value as BaseNode[]).map((c) =>
						visit(c),
					);
				}
			} else if (is_ast_node(value)) {
				(node as unknown as Record<string, unknown>)[key] = visit(value as BaseNode);
			}
		}
		if (node.node_type !== "func_call") return node;
		const call = node as FunctionCallNode;
		if (call.is_enum_shorthand) return node;
		const target = substitution.get(call.name);
		if (target === undefined) return node;
		const zero = zero_literal(target, node.start);
		if (zero) return zero;
		call.name = target;
		// The bound struct's constructor needs arguments the call doesn't
		// carry — synthesize the zero-value tail (default construction).
		const zero_args = zero_args_for(target, node.start, call.params.length);
		if (zero_args?.length) call.params.push(...zero_args);
		return node;
	};

	const fold_statement = (stmt: BaseNode): BaseNode[] => {
		const replaced = visit(stmt);
		return replaced === stmt ? [stmt] : [replaced];
	};

	for (let i = 0; i < statements.length; i++) {
		const stmt = statements[i];
		// Statement lists inside statements are handled by visit's array case;
		// a constructor statement (`T()` alone) may be replaced entirely.
		if (stmt.node_type === "func_call") {
			const replacement = fold_statement(stmt);
			if (replacement[0] !== stmt) statements.splice(i, 1, ...replacement);
			else visit(stmt);
			continue;
		}
		visit(stmt);
	}
}

/**
 * Rewrite `META.info(T).name` chains — in ANY statement position, not just
 * `#for` arms — into the reflected type's name as a comptime string
 * literal (R6). Runs per block before the statement walk, so re-checked
 * specialization clones resolve too. `T` still in `status.type_params`
 * (declaration-time generic bodies) is skipped — the specialization's own
 * pass handles it. `substitution` renames type parameters first (the
 * mono-method clones that are stamped checked without a re-check).
 * Mutates in place; idempotent.
 */
export function rewrite_meta_name_chains(
	statements: BaseNode[],
	status: CheckStatus,
	substitution?: Map<string, string>,
): void {
	const visit = (node: BaseNode): BaseNode => {
		const n = unwrap_grouped(node);
		// META.name(T) / META.is_struct(T) / META.is_container(T) — comptime
		// predicates over a TYPE (the element decoder dispatches on these).
		if (
			n.node_type === "access" &&
			(n as AccessNode).access.node_type === "access_func" &&
			unwrap_grouped((n as AccessNode).target).node_type === "value" &&
			(unwrap_grouped((n as AccessNode).target) as ValueNode).value === "META"
		) {
			const predicate = (n as AccessNode).access as AccessFunctionCallNode;
			const args = predicate.params ?? [];
			const arg = unwrap_grouped(args[0]);
			if (
				args.length === 1 &&
				arg.node_type === "value" &&
				(predicate.name === "name" ||
					predicate.name === "is_struct" ||
					predicate.name === "is_container" ||
					predicate.name === "is_scalar")
			) {
				let type_name = (arg as ValueNode).value;
				if (substitution?.has(type_name)) type_name = substitution.get(type_name)!;
				// Skip names that resolve to NOTHING: an unbound type parameter
				// scanned from the outside (the per-block pass walks deferred
				// generic bodies, where T has no binding yet). Classifying it
				// would fold `META.is_struct(T)` to a wrong `false` before the
				// specialization ever sees it.
				const known =
					!!get_built_in_type(type_name) || !!resolve_declared_struct(type_name, status);
				if (!known) return n;
				if (!status.type_params.includes(type_name)) {
					if (predicate.name === "name") return comptime_string(n.start, type_name);
					if (predicate.name === "is_scalar") {
						const literal = new ValueNode(
							n.start,
							is_scalar_type_name(type_name) ? "true" : "false",
						);
						literal.type = new Type("bool", true);
						return literal;
					}
					const kind = classify_type_name(type_name, status);
					const value = predicate.name === "is_struct" ? kind.is_struct : kind.is_container;
					const literal = new ValueNode(n.start, value ? "true" : "false");
					literal.type = new Type("bool", true);
					return literal;
				}
			}
		}
		if (
			n.node_type === "access" &&
			((n as AccessNode).access.node_type === "access_field" ||
				(n as AccessNode).access.node_type === "access_func")
		) {
			const member = (n as AccessNode).access as AccessFieldNode | AccessFunctionCallNode;
			// META.info(T).name / .field_count / .attr("X") / .has_attr("X") —
			// struct-level reflection (stage 3). Resolved against the
			// substitution map when one is supplied (mono-clone path).
			let meta_arg: string | undefined;
			if (member.node_type === "access_field" && member.name === "name") {
				meta_arg = "";
			} else if (member.node_type === "access_field" && member.name === "field_count") {
				meta_arg = "#count";
			} else if (
				member.node_type === "access_func" &&
				(member.name === "attr" || member.name === "has_attr") &&
				(member as AccessFunctionCallNode).params?.length === 1
			) {
				const arg = unwrap_grouped((member as AccessFunctionCallNode).params![0]);
				if (arg.node_type === "value" && (arg as ValueNode).value.startsWith('"')) {
					meta_arg = (arg as ValueNode).value.substring(1, (arg as ValueNode).value.length - 1);
				}
			}
			if (meta_arg !== undefined) {
				const info_call = unwrap_grouped((n as AccessNode).target);
				if (
					info_call.node_type === "access" &&
					(info_call as AccessNode).access.node_type === "access_func" &&
					((info_call as AccessNode).access as AccessFunctionCallNode).name === "info" &&
					unwrap_grouped((info_call as AccessNode).target).node_type === "value" &&
					(unwrap_grouped((info_call as AccessNode).target) as ValueNode).value === "META"
				) {
					const args = ((info_call as AccessNode).access as AccessFunctionCallNode).params ?? [];
					const arg = unwrap_grouped(args[0]);
					if (args.length === 1 && arg.node_type === "value") {
						let type_name = (arg as ValueNode).value;
						if (substitution?.has(type_name)) type_name = substitution.get(type_name)!;
						if (!status.type_params.includes(type_name)) {
							const declared = resolve_declared_struct(type_name, status);
							if (declared && (declared as StructNode).type_params.length === 0) {
								const struct = declared as StructNode;
								if (meta_arg === "") return comptime_string(n.start, struct.name);
								if (meta_arg === "#count") {
									// A comptime int: the number of fields `#for`
									// iterates (typed fields — the same filter
									// expand_pragma_for applies), so computed sizes
									// and richer conditions can key on it.
									const count = struct.fields.filter((f) => f.type && f.type.name).length;
									const literal = new ValueNode(n.start, String(count));
									literal.type = new Type("int", true);
									return literal;
								}
								const attr = (struct.attrs ?? []).find((a) => a.name === meta_arg);
								if (member.node_type === "access_func" && member.name === "has_attr") {
									const literal = new ValueNode(n.start, attr ? "true" : "false");
									literal.type = new Type("bool", true);
									return literal;
								}
								if (attr && attr.values.length > 0) {
									return comptime_string(n.start, attr.values[0].text);
								}
								add_error(
									status,
									`struct '${struct.name}' has no '@${meta_arg}' attribute — guard with META.info(${type_name}).has_attr("${meta_arg}")`,
									n.start,
								);
								return n;
							}
						}
					}
				}
			}
		}
		for (const key in n) {
			if (key === "parent" || key === "scope") continue;
			const value = (n as unknown as Record<string, unknown>)[key];
			if (Array.isArray(value)) {
				if (value.every(is_ast_node)) {
					(n as unknown as Record<string, unknown>)[key] = (value as BaseNode[]).map((c) =>
						visit(c),
					);
				}
			} else if (is_ast_node(value)) {
				(n as unknown as Record<string, unknown>)[key] = visit(value as BaseNode);
			}
		}
		return n === node ? node : node;
	};
	// Fold comptime-constant `if`s once their META predicates have become
	// literals (`if META.name(T) == "int"`). Folded BEFORE checking, so a
	// dead arm's type errors (e.g. an `mv` push of a scalar) never fire —
	// the same contract the `#for` expansion gives its arms.
	const fold_list = (list: BaseNode[]): void => {
		for (let i = list.length - 1; i >= 0; i--) {
			const stmt = list[i];
			visit(stmt);
			if (stmt.node_type !== "if") continue;
			const if_else = stmt as IfElseNode;
			const folded = evaluate_comptime(if_else.condition);
			if (!folded || folded.kind !== "bool") continue;
			const arm = folded.value
				? (if_else.if_branch ?? { statements: [] as BaseNode[] })
				: (if_else.else_branch ?? { statements: [] as BaseNode[] });
			// Keep the arm's lexical SCOPE: destroying at the block end is
			// observable (auto-free timing), so the fold wraps the kept
			// statements in a block instead of splicing them into the parent.
			const kept: BaseNode[] = [...(arm.statements ?? [])];
			fold_list(kept);
			list.splice(i, 1, new NestedBlockNode(stmt.start, kept));
		}
	};
	fold_list(statements);
}

function evaluate_comptime(node: BaseNode | undefined): ComptimeValue | undefined {
	if (!node) return undefined;
	const n = unwrap_grouped(node);
	switch (n.node_type) {
		case "value": {
			const text = (n as ValueNode).value;
			if (text === "true") return { kind: "bool", value: true };
			if (text === "false") return { kind: "bool", value: false };
			if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
				return { kind: "string", value: text.substring(1, text.length - 1) };
			}
			if (/^\d+$/.test(text)) return { kind: "int", value: parseInt(text, 10) };
			return undefined;
		}
		case "op": {
			const op = n as OperationNode;
			if (op.op === "!") {
				const inner = evaluate_comptime(op.right_value);
				if (!inner || inner.kind !== "bool") return undefined;
				return { kind: "bool", value: !inner.value };
			}
			const left = evaluate_comptime(op.left_value);
			if (!left) return undefined;
			const right = evaluate_comptime(op.right_value);
			if (!right) return undefined;
			if (op.op === "==") {
				return left.kind === right.kind
					? { kind: "bool", value: left.value === right.value }
					: undefined;
			}
			if (op.op === "!=") {
				return left.kind === right.kind
					? { kind: "bool", value: left.value !== right.value }
					: undefined;
			}
			if (op.op === "&&") {
				if (left.kind !== "bool" || right.kind !== "bool") return undefined;
				return { kind: "bool", value: left.value && right.value };
			}
			if (op.op === "||") {
				if (left.kind !== "bool" || right.kind !== "bool") return undefined;
				return { kind: "bool", value: left.value || right.value };
			}
			if (left.kind !== "int" || right.kind !== "int") return undefined;
			switch (op.op) {
				case "+":
					return { kind: "int", value: left.value + right.value };
				case "-":
					return { kind: "int", value: left.value - right.value };
				case "*":
					return { kind: "int", value: left.value * right.value };
				case "/":
					return { kind: "int", value: Math.trunc(left.value / right.value) };
				case "%":
					return { kind: "int", value: left.value % right.value };
				case "<":
					return { kind: "bool", value: left.value < right.value };
				case "<=":
					return { kind: "bool", value: left.value <= right.value };
				case ">":
					return { kind: "bool", value: left.value > right.value };
				case ">=":
					return { kind: "bool", value: left.value >= right.value };
				default:
					return undefined;
			}
		}
		default:
			return undefined;
	}
}
