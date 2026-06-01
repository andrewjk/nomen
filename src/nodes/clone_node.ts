import AccessFieldNode from "./AccessFieldNode.ts";
import AccessFunctionCallNode from "./AccessFunctionCallNode.ts";
import AccessIndexNode from "./AccessIndexNode.ts";
import AccessNode from "./AccessNode.ts";
import AnonStructNode from "./AnonStructNode.ts";
import ArrayValuesNode from "./ArrayValuesNode.ts";
import AssignmentNode from "./AssignmentNode.ts";
import type BaseNode from "./BaseNode.ts";
import BitsetNode from "./BitsetNode.ts";
import BranchNode from "./BranchNode.ts";
import BreakNode from "./BreakNode.ts";
import CastNode from "./CastNode.ts";
import ContinueNode from "./ContinueNode.ts";
import DeclarationNode from "./DeclarationNode.ts";
import EnumNode from "./EnumNode.ts";
import ForLoopNode from "./ForLoopNode.ts";
import FunctionCallNode from "./FunctionCallNode.ts";
import FunctionNode from "./FunctionNode.ts";
import GroupedNode from "./GroupedNode.ts";
import IfElseNode from "./IfElseNode.ts";
import ImportNode from "./ImportNode.ts";
import LetNode from "./LetNode.ts";
import MatchNode from "./MatchNode.ts";
import OperationNode from "./OperationNode.ts";
import PanicNode from "./PanicNode.ts";
import ParameterNode from "./ParameterNode.ts";
import RangeNode from "./RangeNode.ts";
import RawNode from "./RawNode.ts";
import ReturnNode from "./ReturnNode.ts";
import RootNode from "./RootNode.ts";
import StructNode from "./StructNode.ts";
import SwitchNode from "./SwitchNode.ts";
import TodoNode from "./TodoNode.ts";
import TraitNode from "./TraitNode.ts";
import Type from "./Type.ts";
import ValueNode from "./ValueNode.ts";
import WhileLoopNode from "./WhileLoopNode.ts";

export function clone_type(type: Type): Type {
	const t = new Type(
		type.name,
		type.is_static,
		type.is_array,
		type.length ? clone_node(type.length) : undefined,
	);
	t.is_ref = type.is_ref;
	t.is_return_type = type.is_return_type;
	t.is_nullable = type.is_nullable;
	t.type_args = type.type_args?.map(clone_type);
	t.func_params = type.func_params?.map((p) => clone_node(p) as ParameterNode);
	t.func_return_type = type.func_return_type ? clone_type(type.func_return_type) : undefined;
	return t;
}

export default function clone_node(node: BaseNode): BaseNode {
	switch (node.node_type) {
		case "value": {
			const n = node as ValueNode;
			const c = new ValueNode(n.start, n.value, n.type ? clone_type(n.type) : undefined);
			c.is_enum_shorthand = n.is_enum_shorthand;
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "func_call": {
			const n = node as FunctionCallNode;
			const c = new FunctionCallNode(
				n.start,
				n.name,
				n.type ? clone_type(n.type) : undefined,
				n.params.map(clone_node),
				n.is_static,
			);
			c.is_func_param = n.is_func_param;
			c.type_args = n.type_args?.map(clone_type);
			c.ref_param_indices = n.ref_param_indices?.slice();
			c.mov_param_indices = n.mov_param_indices?.slice();
			c.swap_params = n.swap_params
				? new Map([...n.swap_params].map(([k, v]) => [k, clone_node(v)]))
				: undefined;
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "access": {
			const n = node as AccessNode;
			const c = new AccessNode(n.start, clone_node(n.target), clone_node(n.access) as any);
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "access_field": {
			const n = node as AccessFieldNode;
			const c = new AccessFieldNode(n.start, n.name, n.type ? clone_type(n.type) : undefined);
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "access_func": {
			const n = node as AccessFunctionCallNode;
			const c = new AccessFunctionCallNode(
				n.start,
				n.name,
				n.type ? clone_type(n.type) : undefined,
				n.params.map(clone_node),
				n.is_static,
			);
			c.ref_param_indices = n.ref_param_indices?.slice();
			c.mov_param_indices = n.mov_param_indices?.slice();
			c.swap_params = n.swap_params
				? new Map([...n.swap_params].map(([k, v]) => [k, clone_node(v)]))
				: undefined;
			c.mangled_name = n.mangled_name;
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "access_index": {
			const n = node as AccessIndexNode;
			const c = new AccessIndexNode(
				n.start,
				clone_node(n.index),
				n.type ? clone_type(n.type) : undefined,
			);
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "declare": {
			const n = node as DeclarationNode;
			const c = new DeclarationNode(
				n.start,
				n.visibility,
				n.declaration,
				n.name,
				n.type ? clone_type(n.type) : undefined,
				n.value ? clone_node(n.value) : undefined,
			);
			c.name_start = n.name_start;
			c.type_start = n.type_start;
			c.func_params = n.func_params?.map((p) => clone_node(p) as ParameterNode);
			c.func_return_type = n.func_return_type ? clone_type(n.func_return_type) : undefined;
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "assign": {
			const n = node as AssignmentNode;
			const c = new AssignmentNode(
				n.start,
				clone_node(n.left_value),
				clone_node(n.right_value),
				n.operator,
			);
			c.swap = n.swap ? clone_node(n.swap) : undefined;
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "return": {
			const n = node as ReturnNode;
			const c = new ReturnNode(
				n.start,
				n.value ? clone_node(n.value) : null,
				n.type ? clone_type(n.type) : undefined,
			);
			c.from_c = n.from_c;
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "let": {
			const n = node as LetNode;
			const c = new LetNode(n.start, clone_node(n.value), n.type ? clone_type(n.type) : undefined);
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "if": {
			const n = node as IfElseNode;
			const c = new IfElseNode(
				n.start,
				clone_node(n.condition),
				n.if_branch ? (clone_node(n.if_branch) as BranchNode) : undefined,
				n.else_branch ? (clone_node(n.else_branch) as BranchNode) : undefined,
				n.return_type ? clone_type(n.return_type) : undefined,
			);
			c.has_return = n.has_return;
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "branch": {
			const n = node as BranchNode;
			const c = new BranchNode(n.start, n.statements.map(clone_node));
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "match": {
			const n = node as MatchNode;
			const cases = n.cases.map((mc) => ({
				match_value: clone_node(mc.match_value),
				branch: clone_node(mc.branch) as BranchNode,
			}));
			const c = new MatchNode(
				n.start,
				clone_node(n.value),
				cases,
				n.else_branch ? (clone_node(n.else_branch) as BranchNode) : undefined,
				n.return_type ? clone_type(n.return_type) : undefined,
			);
			c.has_return = n.has_return;
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "switch": {
			const n = node as SwitchNode;
			const cases = n.cases.map((sc) => ({
				condition: clone_node(sc.condition),
				branch: clone_node(sc.branch) as BranchNode,
			}));
			const c = new SwitchNode(
				n.start,
				cases,
				n.else_branch ? (clone_node(n.else_branch) as BranchNode) : undefined,
				n.return_type ? clone_type(n.return_type) : undefined,
			);
			c.has_return = n.has_return;
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "for": {
			const n = node as ForLoopNode;
			const c = new ForLoopNode(
				n.start,
				clone_node(n.item) as ValueNode,
				clone_node(n.list),
				n.statements.map(clone_node),
				n.update ? clone_node(n.update) : undefined,
			);
			c.index = n.index ? clone_node(n.index) : undefined;
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "while": {
			const n = node as WhileLoopNode;
			const c = new WhileLoopNode(
				n.start,
				clone_node(n.condition),
				n.statements.map(clone_node),
				n.update ? clone_node(n.update) : undefined,
			);
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "op": {
			const n = node as OperationNode;
			const c = new OperationNode(
				n.start,
				n.op,
				clone_node(n.left_value),
				clone_node(n.right_value),
				n.type ? clone_type(n.type) : undefined,
			);
			c.operator_func = n.operator_func ? { ...n.operator_func } : undefined;
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "grouped": {
			const n = node as GroupedNode;
			const c = new GroupedNode(n.start, clone_node(n.value));
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "cast": {
			const n = node as CastNode;
			const c = new CastNode(n.start, clone_node(n.value), clone_type(n.target_type));
			c.type = clone_type(n.type);
			c.operator_func = n.operator_func ? { ...n.operator_func } : undefined;
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "range": {
			const n = node as RangeNode;
			const c = new RangeNode(n.start, clone_node(n.left_value), clone_node(n.right_value));
			c.type = clone_type(n.type);
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "anon_struct": {
			const n = node as AnonStructNode;
			const c = new AnonStructNode(
				n.start,
				n.fields.map((f) => ({ name: f.name, value: clone_node(f.value) })),
			);
			c.type = n.type ? clone_type(n.type) : undefined;
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "array": {
			const n = node as ArrayValuesNode;
			const c = new ArrayValuesNode(n.start, n.values.map(clone_node), clone_type(n.type));
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "break": {
			const n = node as BreakNode;
			const c = new BreakNode(n.start);
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "continue": {
			const n = node as ContinueNode;
			const c = new ContinueNode(n.start);
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "panic": {
			const n = node as PanicNode;
			const c = new PanicNode(n.start, n.message);
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "todo": {
			const n = node as TodoNode;
			const c = new TodoNode(n.start, n.message);
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "raw": {
			const n = node as RawNode;
			const c = new RawNode(n.start, n.value);
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "import": {
			const n = node as ImportNode;
			const c = new ImportNode(n.start, n.name);
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "struct": {
			const n = node as StructNode;
			const c = new StructNode(
				n.start,
				n.visibility,
				n.name,
				n.traits.slice(),
				n.fields.map((f) => clone_node(f) as DeclarationNode),
				n.functions.map((f) => clone_node(f) as FunctionNode),
			);
			c.type_params = n.type_params.slice();
			c.is_generic = n.is_generic;
			c.privates_visible = n.privates_visible;
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "func": {
			const n = node as FunctionNode;
			const c = new FunctionNode(
				n.start,
				n.visibility,
				n.name,
				clone_type(n.return_type),
				n.params.map((p) => clone_node(p) as ParameterNode),
				n.statements.map(clone_node),
			);
			c.has_return = n.has_return;
			c.return_type_start = n.return_type_start;
			c.is_static = n.is_static;
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "param": {
			const n = node as ParameterNode;
			const c = new ParameterNode(
				n.start,
				n.name,
				n.type ? clone_type(n.type) : new Type(""),
				n.default_value ? clone_node(n.default_value) : undefined,
				n.is_self_param,
				n.is_copied ? "cp" : n.is_moved ? "mov" : n.declaration,
			);
			c.type_start = n.type_start;
			c.name_start = n.name_start;
			c.default_value_start = n.default_value_start;
			c.func_params = n.func_params?.map((p) => clone_node(p) as ParameterNode);
			c.func_return_type = n.func_return_type ? clone_type(n.func_return_type) : undefined;
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "enum": {
			const n = node as EnumNode;
			const cases = n.cases.map((ec) => ({
				name: ec.name,
				params: ec.params.map((p) => clone_node(p) as ParameterNode),
			}));
			const c = new EnumNode(n.start, n.visibility, n.name, cases);
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "bitset": {
			const n = node as BitsetNode;
			const c = new BitsetNode(n.start, n.visibility, n.name, n.cases.slice());
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "root": {
			const n = node as RootNode;
			const c = new RootNode(
				n.imports.map((i) => clone_node(i) as ImportNode),
				n.statements.map(clone_node),
			);
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		case "trait": {
			const n = node as TraitNode;
			const c = new TraitNode(
				n.start,
				n.visibility,
				n.name,
				n.fields.map((f) => clone_node(f) as DeclarationNode),
				n.functions.map((f) => clone_node(f) as FunctionNode),
			);
			c.allocations = n.allocations?.map(clone_node);
			return c;
		}
		default: {
			return node;
		}
	}
}
