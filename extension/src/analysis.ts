import type_name from "../../src/check/utils/type_name.ts";
import type AccessFunctionCallNode from "../../src/nodes/AccessFunctionCallNode.ts";
import type AccessNode from "../../src/nodes/AccessNode.ts";
import type AnonStructNode from "../../src/nodes/AnonStructNode.ts";
import type ArrayValuesNode from "../../src/nodes/ArrayValuesNode.ts";
import type AssignmentNode from "../../src/nodes/AssignmentNode.ts";
import type AsyncBlockNode from "../../src/nodes/AsyncBlockNode.ts";
import type BaseNode from "../../src/nodes/BaseNode.ts";
import type BitsetNode from "../../src/nodes/BitsetNode.ts";
import type BranchNode from "../../src/nodes/BranchNode.ts";
import type CastNode from "../../src/nodes/CastNode.ts";
import type DeclarationNode from "../../src/nodes/DeclarationNode.ts";
import type EnumNode from "../../src/nodes/EnumNode.ts";
import type ExtendNode from "../../src/nodes/ExtendNode.ts";
import type ForLoopNode from "../../src/nodes/ForLoopNode.ts";
import type FunctionCallNode from "../../src/nodes/FunctionCallNode.ts";
import type FunctionNode from "../../src/nodes/FunctionNode.ts";
import type GroupedNode from "../../src/nodes/GroupedNode.ts";
import type IfElseNode from "../../src/nodes/IfElseNode.ts";
import type LetNode from "../../src/nodes/LetNode.ts";
import type MatchNode from "../../src/nodes/MatchNode.ts";
import type OperationNode from "../../src/nodes/OperationNode.ts";
import type ParameterNode from "../../src/nodes/ParameterNode.ts";
import type RangeNode from "../../src/nodes/RangeNode.ts";
import type ReturnNode from "../../src/nodes/ReturnNode.ts";
import type RootNode from "../../src/nodes/RootNode.ts";
import type SpawnNode from "../../src/nodes/SpawnNode.ts";
import type StructNode from "../../src/nodes/StructNode.ts";
import type SwitchNode from "../../src/nodes/SwitchNode.ts";
import type TraitNode from "../../src/nodes/TraitNode.ts";
import type Type from "../../src/nodes/Type.ts";
import type ValueNode from "../../src/nodes/ValueNode.ts";
import type WhileLoopNode from "../../src/nodes/WhileLoopNode.ts";

export type DefKind =
	| "variable"
	| "param"
	| "field"
	| "func"
	| "method"
	| "struct"
	| "class"
	| "trait"
	| "enum"
	| "bitset"
	| "case";

/** A named declaration, located at the offset of its name in the parse source. */
export interface Def {
	name: string;
	kind: DefKind;
	start: number;
	length: number;
	signature: string;
	doc?: string;
	type?: Type;
	/** The struct/trait/enum that owns this field, method or case. */
	container?: string;
	visibility?: "pub" | "private";
	is_static?: boolean;
	/** For locals and parameters: the start of the function they belong to. */
	func_start?: number;
}

/** A use of a `Def` — an identifier, a member access or a call. */
export interface Ref {
	start: number;
	length: number;
	def: Def;
}

export interface TypeInfo {
	name: string;
	def?: Def;
	fields: Map<string, Def>;
	methods: Map<string, Def>;
	cases: Map<string, Def>;
	traits: string[];
}

export interface Analysis {
	defs: Def[];
	refs: Ref[];
	types: Map<string, TypeInfo>;
}

const IDENTIFIER = /[A-Za-z0-9_]/;
const NAME_SEARCH_WINDOW = 400;

export function analyze(root: RootNode, source: string): Analysis {
	const builder = new Builder(source);
	builder.run(root);
	return { defs: builder.defs, refs: builder.refs, types: builder.types };
}

/** The definition whose name covers `offset`, if any. */
export function def_at(analysis: Analysis, offset: number): Def | undefined {
	return analysis.defs.find((d) => offset >= d.start && offset <= d.start + d.length);
}

/** The reference covering `offset`, if any. */
export function ref_at(analysis: Analysis, offset: number): Ref | undefined {
	return analysis.refs.find((r) => offset >= r.start && offset <= r.start + r.length);
}

/** The definition at `offset`, whether the cursor is on a use or the declaration. */
export function symbol_at(analysis: Analysis, offset: number): Def | undefined {
	return ref_at(analysis, offset)?.def ?? def_at(analysis, offset);
}

export function refs_to(analysis: Analysis, def: Def): Ref[] {
	return analysis.refs.filter((r) => r.def.start === def.start && r.def.name === def.name);
}

/**
 * Resolve a dotted identifier chain (e.g. `self.items`) to its type, using the
 * declaration nearest to — and before — `offset`. Used by completion, where the
 * source under the cursor is usually mid-edit.
 */
export function resolve_chain(
	analysis: Analysis,
	chain: string[],
	offset: number,
): { info: TypeInfo; is_static: boolean } | undefined {
	if (!chain.length) return undefined;

	let is_static = false;
	let info: TypeInfo | undefined;

	const head = chain[0];
	const head_type = analysis.types.get(head);
	if (head_type) {
		info = head_type;
		is_static = true;
	} else {
		const def = lookup_at(analysis, head, offset);
		if (!def?.type) return undefined;
		info = analysis.types.get(def.type.name);
	}

	for (const name of chain.slice(1)) {
		if (!info) return undefined;
		const member = find_member(analysis.types, info, name);
		if (!member?.type) return undefined;
		info = analysis.types.get(member.type.name);
		is_static = false;
	}

	return info ? { info, is_static } : undefined;
}

/** A variable or parameter named `name` that is visible at `offset`. */
export function lookup_at(analysis: Analysis, name: string, offset: number): Def | undefined {
	let enclosing: Def | undefined;
	for (const def of analysis.defs) {
		if (def.start > offset) break;
		if (def.kind === "func" || def.kind === "method") enclosing = def;
	}

	let found: Def | undefined;
	for (const def of analysis.defs) {
		if (def.start > offset) break;
		if (def.name !== name) continue;
		if (def.kind === "variable" || def.kind === "param") {
			if (def.func_start === undefined || def.func_start === enclosing?.start) found = def;
		}
	}
	if (found) return found;

	return analysis.defs.find((d) => d.name === name && d.func_start === undefined);
}

/** Look a member up on a type, following the types it conforms to. */
export function find_member(
	types: Map<string, TypeInfo>,
	info: TypeInfo,
	name: string,
	seen = new Set<string>(),
): Def | undefined {
	if (seen.has(info.name)) return undefined;
	seen.add(info.name);
	const found = info.fields.get(name) ?? info.methods.get(name) ?? info.cases.get(name);
	if (found) return found;
	for (const trait of info.traits) {
		const trait_info = types.get(trait);
		if (!trait_info) continue;
		const inherited = find_member(types, trait_info, name, seen);
		if (inherited) return inherited;
	}
	return undefined;
}

/** Every member of a type, including the ones it inherits from its traits. */
export function all_members(
	types: Map<string, TypeInfo>,
	info: TypeInfo,
	seen = new Set<string>(),
): Def[] {
	if (seen.has(info.name)) return [];
	seen.add(info.name);
	const members = [...info.fields.values(), ...info.methods.values(), ...info.cases.values()];
	for (const trait of info.traits) {
		const trait_info = types.get(trait);
		if (trait_info) members.push(...all_members(types, trait_info, seen));
	}
	return members;
}

class Builder {
	source: string;
	defs: Def[] = [];
	refs: Ref[] = [];
	types = new Map<string, TypeInfo>();
	globals = new Map<string, Def>();
	functions = new Map<string, Def>();
	scopes: Map<string, Def>[] = [];
	func_start: number | undefined;
	private defs_by_start = new Map<number, Def>();
	private refs_by_start = new Map<number, Ref>();

	constructor(source: string) {
		this.source = source;
	}

	run(root: RootNode): void {
		for (const statement of root.statements || []) this.collect(statement);
		this.scopes.push(new Map());
		for (const statement of root.statements || []) this.walk(statement);
		this.scopes.pop();
		this.defs.sort((a, b) => a.start - b.start);
		this.refs.sort((a, b) => a.start - b.start);
	}

	// --- Declarations --------------------------------------------------------

	private collect(node: BaseNode): void {
		switch (node.node_type) {
			case "struct":
			case "trait":
				this.collect_type(node as StructNode | TraitNode);
				break;
			case "enum":
				this.collect_enum(node as EnumNode);
				break;
			case "bitset":
				this.collect_bitset(node as BitsetNode);
				break;
			case "func": {
				const def = this.function_def(node as FunctionNode);
				if (def) this.functions.set(def.name, def);
				break;
			}
			case "declare": {
				const def = this.variable_def(node as DeclarationNode, "variable");
				if (def) this.globals.set(def.name, def);
				break;
			}
			case "extend": {
				// An extend's methods belong to the named target struct/class, so
				// index them under that type — editor completion/hover then sees
				// them exactly like in-body methods.
				const ext = node as ExtendNode;
				const info = this.type_info(ext.name);
				for (const func of ext.functions || []) {
					const func_def = this.function_def(func, ext.name);
					if (func_def) info.methods.set(func_def.name, func_def);
				}
				break;
			}
		}
	}

	private collect_type(node: StructNode | TraitNode): void {
		const start = this.find_name(node.start, node.name);
		if (start < 0) return;
		const is_struct = node.node_type === "struct";
		const is_class = is_struct && !!(node as StructNode).is_class;
		const kind: DefKind = is_class ? "class" : is_struct ? "struct" : "trait";
		const def = this.add_def({
			name: node.name,
			kind,
			start,
			length: node.name.length,
			signature: this.type_signature(node, kind),
			doc: node.doc,
			visibility: node.visibility,
		});

		const info = this.type_info(node.name);
		info.def = def;
		info.traits = is_struct ? [...(node as StructNode).traits] : [];

		for (const field of node.fields || []) {
			const field_def = this.variable_def(field, "field", node.name);
			if (field_def) info.fields.set(field_def.name, field_def);
		}
		for (const func of node.functions || []) {
			const func_def = this.function_def(func, node.name);
			if (func_def) info.methods.set(func_def.name, func_def);
		}
	}

	private collect_enum(node: EnumNode): void {
		const start = this.find_name(node.start, node.name);
		if (start < 0) return;
		const def = this.add_def({
			name: node.name,
			kind: "enum",
			start,
			length: node.name.length,
			signature: `enum ${node.name}`,
			doc: node.doc,
			visibility: node.visibility,
		});
		const info = this.type_info(node.name);
		info.def = def;
		let search = start;
		for (const enum_case of node.cases) {
			const case_start = this.find_name(search, enum_case.name);
			if (case_start < 0) continue;
			search = case_start + enum_case.name.length;
			const params = enum_case.params.map((p) => this.param_signature(p)).join(", ");
			info.cases.set(
				enum_case.name,
				this.add_def({
					name: enum_case.name,
					kind: "case",
					start: case_start,
					length: enum_case.name.length,
					signature: `${node.name}.${enum_case.name}${params ? `(${params})` : ""}`,
					container: node.name,
					type: make_type(node.name),
					is_static: true,
				}),
			);
		}
	}

	private collect_bitset(node: BitsetNode): void {
		const start = this.find_name(node.start, node.name);
		if (start < 0) return;
		const def = this.add_def({
			name: node.name,
			kind: "bitset",
			start,
			length: node.name.length,
			signature: `bitset ${node.name}`,
			doc: node.doc,
			visibility: node.visibility,
		});
		const info = this.type_info(node.name);
		info.def = def;
		let search = start;
		for (const name of node.cases) {
			const case_start = this.find_name(search, name);
			if (case_start < 0) continue;
			search = case_start + name.length;
			info.cases.set(
				name,
				this.add_def({
					name,
					kind: "case",
					start: case_start,
					length: name.length,
					signature: `${node.name}.${name}`,
					container: node.name,
					type: make_type(node.name),
					is_static: true,
				}),
			);
		}
	}

	private function_def(node: FunctionNode, container?: string): Def | undefined {
		const start = this.find_name(node.start, node.name);
		if (start < 0) return undefined;
		return this.add_def({
			name: node.name,
			kind: container ? "method" : "func",
			start,
			length: node.name.length,
			signature: this.function_signature(node),
			doc: node.doc,
			type: node.return_type?.name ? node.return_type : undefined,
			container,
			visibility: node.visibility,
			is_static: node.is_static,
		});
	}

	private variable_def(node: DeclarationNode, kind: DefKind, container?: string): Def | undefined {
		const start = node.name_start ?? this.find_name(node.start, node.name);
		if (start === undefined || start < 0 || this.word_at(start) !== node.name) return undefined;
		return this.add_def({
			name: node.name,
			kind,
			start,
			length: node.name.length,
			signature: this.declaration_signature(node),
			doc: node.doc,
			type: node.type?.name ? node.type : undefined,
			container,
			visibility: node.visibility,
			func_start: kind === "variable" ? this.func_start : undefined,
		});
	}

	private param_def(node: ParameterNode, container?: string): Def | undefined {
		const start = node.name_start ?? this.find_name(node.start, node.name);
		if (start === undefined || start < 0 || this.word_at(start) !== node.name) return undefined;
		return this.add_def({
			name: node.name,
			kind: "param",
			start,
			length: node.name.length,
			signature: this.param_signature(node),
			type: node.type?.name ? node.type : node.is_self_param ? make_type(container) : undefined,
			container,
			func_start: this.func_start,
		});
	}

	// Declarations are collected up front and met again while walking bodies,
	// so the first def at an offset wins — that also folds away the clones the
	// checker appends for generic instantiations (they keep the original's
	// offsets).
	private add_def(def: Def): Def {
		const existing = this.defs_by_start.get(def.start);
		if (existing) return existing;
		this.defs_by_start.set(def.start, def);
		this.defs.push(def);
		return def;
	}

	private add_ref(start: number, length: number, def: Def): void {
		if (this.refs_by_start.has(start)) return;
		const ref = { start, length, def };
		this.refs_by_start.set(start, ref);
		this.refs.push(ref);
	}

	private type_info(name: string): TypeInfo {
		let info = this.types.get(name);
		if (!info) {
			info = { name, fields: new Map(), methods: new Map(), cases: new Map(), traits: [] };
			this.types.set(name, info);
		}
		return info;
	}

	// --- Signatures ----------------------------------------------------------

	private type_signature(node: StructNode | TraitNode, kind: DefKind): string {
		const params = node.type_params?.length ? `<${node.type_params.join(", ")}>` : "";
		const traits = node.node_type === "struct" ? (node as StructNode).traits : [];
		const conforms = traits.length ? `: ${traits.join(", ")}` : "";
		return `${node.visibility === "pub" ? "pub " : ""}${kind} ${node.name}${params}${conforms}`;
	}

	private function_signature(node: FunctionNode): string {
		const params = node.params.map((p) => this.param_signature(p));
		if (node.return_type?.name) params.push(`out ${type_name(node.return_type)}`);
		const type_params = node.type_params?.length ? `<${node.type_params.join(", ")}>` : "";
		const visibility = node.visibility === "pub" ? "pub " : "";
		return `${visibility}func ${node.name}${type_params} = (${params.join(", ")})`;
	}

	private param_signature(node: ParameterNode): string {
		if (node.is_self_param) return `${node.is_ref ? "ref " : ""}self`;
		const prefix = node.is_ref
			? "ref "
			: node.is_moved
				? "mov "
				: node.is_copied
					? "cp "
					: node.declaration === "var"
						? "var "
						: "";
		const spread = node.is_variadic ? "..." : "";
		return `${prefix}${spread}${this.type_text(node.type)} ${node.name}`.trim();
	}

	private declaration_signature(node: DeclarationNode): string {
		const visibility = node.visibility === "pub" ? "pub " : "";
		const type = this.type_text(node.type);
		return `${visibility}${node.declaration} ${type} ${node.name}`.replace(/\s+/g, " ").trim();
	}

	private type_text(type: Type | undefined): string {
		if (!type?.name) return "";
		if (type.func_params) {
			const params = type.func_params.map((p) => this.param_signature(p));
			if (type.func_return_type?.name) params.push(`out ${type_name(type.func_return_type)}`);
			return `func (${params.join(", ")})`;
		}
		return type_name(type);
	}

	// --- Bodies --------------------------------------------------------------

	private walk(node: BaseNode | null | undefined): void {
		if (!node) return;
		// The checker hoists sub-expressions (e.g. the parts of an interpolated
		// string) into synthesized declarations, which still hold the original
		// nodes — and so the original offsets.
		for (const allocation of node.allocations || []) this.walk(allocation);
		switch (node.node_type) {
			case "struct":
			case "trait": {
				const type_node = node as StructNode | TraitNode;
				if (this.find_name(type_node.start, type_node.name) < 0) return;
				for (const field of type_node.fields || []) {
					this.walk(field.value);
					this.add_type_ref(field.type, field.type_start);
				}
				for (const func of type_node.functions || []) this.walk_function(func, type_node.name);
				return;
			}
			case "extend": {
				const ext = node as ExtendNode;
				for (const func of ext.functions || []) this.walk_function(func, ext.name);
				return;
			}
			case "func":
				return this.walk_function(node as FunctionNode);
			case "declare":
				return this.walk_declaration(node as DeclarationNode);
			case "assign": {
				const assign = node as AssignmentNode;
				this.walk(assign.left_value);
				this.walk(assign.right_value);
				this.walk(assign.swap);
				return;
			}
			case "op": {
				const op = node as OperationNode;
				this.walk(op.left_value);
				this.walk(op.right_value);
				return;
			}
			case "range": {
				const range = node as RangeNode;
				this.walk(range.left_value);
				this.walk(range.right_value);
				return;
			}
			case "grouped":
				return this.walk((node as GroupedNode).value);
			case "cast":
				return this.walk((node as CastNode).value);
			case "let":
				return this.walk((node as LetNode).value);
			case "return":
				return this.walk((node as ReturnNode).value);
			case "array": {
				for (const value of (node as ArrayValuesNode).values) this.walk(value);
				return;
			}
			case "anon_struct": {
				for (const field of (node as AnonStructNode).fields) this.walk(field.value);
				return;
			}
			case "access":
				return this.walk_access(node as AccessNode);
			case "func_call":
				return this.walk_call(node as FunctionCallNode);
			case "spawn":
				return this.walk((node as SpawnNode).call);
			case "value":
				return this.add_value_ref(node as ValueNode);
			case "if": {
				const if_else = node as IfElseNode;
				this.walk(if_else.condition);
				this.walk_branch(if_else.if_branch);
				this.walk_branch(if_else.else_branch);
				return;
			}
			case "switch": {
				const switch_node = node as SwitchNode;
				for (const branch of switch_node.cases) {
					this.walk(branch.condition);
					this.walk_branch(branch.branch);
				}
				this.walk_branch(switch_node.else_branch);
				return;
			}
			case "match": {
				const match = node as MatchNode;
				this.walk(match.value);
				for (const branch of match.cases) {
					this.walk(branch.match_value);
					this.walk_branch(branch.branch);
				}
				this.walk_branch(match.else_branch);
				return;
			}
			case "for": {
				const loop = node as ForLoopNode;
				this.walk(loop.list);
				this.scopes.push(new Map());
				this.define_binding(loop.item, loop.item?.type);
				if (loop.index?.node_type === "value") this.define_binding(loop.index as ValueNode);
				this.walk_statements(loop.statements);
				this.walk(loop.update);
				this.scopes.pop();
				return;
			}
			case "while": {
				const loop = node as WhileLoopNode;
				this.scopes.push(new Map());
				this.walk(loop.condition);
				this.walk_statements(loop.statements);
				this.walk(loop.update);
				this.scopes.pop();
				return;
			}
			case "branch":
				return this.walk_branch(node as BranchNode);
			case "async_block": {
				const block = node as AsyncBlockNode;
				this.walk(block.timeout);
				this.scopes.push(new Map());
				this.walk_statements(block.statements);
				this.scopes.pop();
				return;
			}
		}
	}

	private walk_statements(statements: BaseNode[] | undefined): void {
		for (const statement of statements || []) this.walk(statement);
	}

	private walk_branch(branch: BranchNode | undefined): void {
		if (!branch) return;
		this.scopes.push(new Map());
		this.walk_statements(branch.statements);
		this.scopes.pop();
	}

	private walk_function(node: FunctionNode, container?: string): void {
		const start = this.find_name(node.start, node.name);
		// Synthesized and monomorphized functions carry the offsets of the
		// original they were cloned from — walking them would double up refs.
		if (start < 0) return;

		const previous = this.func_start;
		this.func_start = start;
		this.scopes.push(new Map());
		for (const param of node.params) {
			this.walk(param.default_value);
			const def = this.param_def(param, container);
			if (def) this.scopes.at(-1)!.set(def.name, def);
			this.add_type_ref(param.type, param.type_start);
			this.walk(param.constraint);
		}
		this.walk_statements(node.statements);
		this.walk(node.return_constraint);
		this.scopes.pop();
		this.func_start = previous;
	}

	private walk_declaration(node: DeclarationNode): void {
		this.walk(node.value);
		this.walk(node.swap);
		this.add_type_ref(node.type, node.type_start);
		const def = this.variable_def(node, "variable");
		if (def) this.scopes.at(-1)?.set(def.name, def);
		this.walk(node.constraint);
	}

	private walk_access(node: AccessNode): void {
		this.walk(node.target);
		const access = node.access;
		if (access.node_type === "access_func") {
			for (const param of (access as AccessFunctionCallNode).params) this.walk(param);
		}

		const name = this.word_at(access.start);
		if (!name) return;
		const target = this.type_of(node.target);
		const def = this.member_of(target, name);
		if (def) this.add_ref(access.start, name.length, def);
	}

	private walk_call(node: FunctionCallNode): void {
		for (const param of node.params) this.walk(param);
		for (const override of node.field_overrides || []) this.walk(override.value);

		const name = this.word_at(node.start);
		if (!name) return;
		// A call to a type name is a constructor — point at the type itself.
		const def = this.lookup(name) ?? this.types.get(name)?.def;
		if (def) this.add_ref(node.start, name.length, def);
	}

	private add_value_ref(node: ValueNode): void {
		const name = this.word_at(node.start);
		if (!name) return;
		const def = this.lookup(name);
		if (def) this.add_ref(node.start, name.length, def);
	}

	private add_type_ref(type: Type | undefined, start: number | undefined): void {
		if (!type || start === undefined || start < 0) return;
		const name = this.word_at(start);
		if (!name) return;
		const def = this.types.get(name)?.def;
		if (def) this.add_ref(start, name.length, def);
	}

	private define_binding(node: ValueNode | undefined, type?: Type): void {
		if (!node) return;
		const name = this.word_at(node.start);
		if (!name) return;
		const def = this.add_def({
			name,
			kind: "variable",
			start: node.start,
			length: name.length,
			signature: type?.name ? `var ${this.type_text(type)} ${name}` : `var ${name}`,
			type: type?.name ? type : undefined,
			func_start: this.func_start,
		});
		this.scopes.at(-1)?.set(name, def);
	}

	// --- Resolution ----------------------------------------------------------

	private lookup(name: string): Def | undefined {
		for (let i = this.scopes.length - 1; i >= 0; i--) {
			const found = this.scopes[i].get(name);
			if (found) return found;
		}
		return this.globals.get(name) ?? this.functions.get(name) ?? this.types.get(name)?.def;
	}

	private member_of(type: Type | undefined, name: string): Def | undefined {
		const info = type?.name ? this.types.get(type.name) : undefined;
		if (info) {
			const found = find_member(this.types, info, name);
			if (found) return found;
		}
		// Without a resolved receiver type, an unambiguous member name is still
		// a safe guess (the same fallback the hover provider has always used).
		let unique: Def | undefined;
		for (const candidate of this.types.values()) {
			const found = candidate.fields.get(name) ?? candidate.methods.get(name);
			if (!found) continue;
			if (unique) return undefined;
			unique = found;
		}
		return unique;
	}

	private type_of(node: BaseNode | undefined): Type | undefined {
		if (!node) return undefined;
		switch (node.node_type) {
			case "value": {
				const name = this.word_at(node.start) || (node as ValueNode).value;
				// A local can shadow a type name, so bindings are checked first.
				const def = this.lookup(name);
				const is_binding =
					def?.kind === "variable" || def?.kind === "param" || def?.kind === "field";
				if (is_binding && def?.type) return def.type;
				if (this.types.has(name)) return make_type(name);
				if (def?.type) return def.type;
				const type = (node as ValueNode).type;
				return type?.name ? type : undefined;
			}
			case "access": {
				const access = (node as AccessNode).access;
				const name = this.word_at(access.start);
				if (name) {
					const def = this.member_of(this.type_of((node as AccessNode).target), name);
					if (def?.type) return def.type;
				}
				return access.type?.name ? access.type : undefined;
			}
			case "func_call": {
				const call = node as FunctionCallNode;
				const name = this.word_at(call.start);
				if (name && this.types.has(name)) return make_type(name);
				if (name) {
					const def = this.functions.get(name);
					if (def?.type) return def.type;
				}
				return call.type?.name ? call.type : undefined;
			}
			case "grouped":
				return this.type_of((node as GroupedNode).value);
			case "cast":
				return (node as CastNode).target_type;
			case "op":
				return (node as OperationNode).type;
			case "array":
				return (node as ArrayValuesNode).type;
			case "anon_struct":
				return (node as AnonStructNode).type;
			default:
				return undefined;
		}
	}

	// --- Source helpers ------------------------------------------------------

	/** The offset of `name` at or shortly after `start`, or -1. */
	private find_name(start: number, name: string): number {
		if (start < 0 || !name) return -1;
		const limit = Math.min(this.source.length, start + NAME_SEARCH_WINDOW);
		let from = start;
		while (from < limit) {
			const found = this.source.indexOf(name, from);
			if (found < 0 || found >= limit) return -1;
			const before = this.source[found - 1];
			const after = this.source[found + name.length];
			const bounded =
				(before === undefined || !IDENTIFIER.test(before)) &&
				(after === undefined || !IDENTIFIER.test(after));
			if (bounded) return found;
			from = found + name.length;
		}
		return -1;
	}

	/** The identifier starting at `offset`, or "" if there isn't one. */
	private word_at(offset: number): string {
		if (offset < 0 || offset >= this.source.length) return "";
		if (!/[A-Za-z_]/.test(this.source[offset])) return "";
		let end = offset;
		while (end < this.source.length && IDENTIFIER.test(this.source[end])) end++;
		return this.source.slice(offset, end);
	}
}

function make_type(name: string | undefined): Type | undefined {
	if (!name) return undefined;
	return { name } as Type;
}
