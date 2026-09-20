import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AnonStructNode from "../nodes/AnonStructNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import AsyncBlockNode from "../nodes/AsyncBlockNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import BitsetNode from "../nodes/BitsetNode.ts";
import BreakNode from "../nodes/BreakNode.ts";
import CastNode from "../nodes/CastNode.ts";
import ContinueNode from "../nodes/ContinueNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import EnumNode from "../nodes/EnumNode.ts";
import ForLoopNode from "../nodes/ForLoopNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import GroupedNode from "../nodes/GroupedNode.ts";
import IfElseNode from "../nodes/IfElseNode.ts";
import IndexNode from "../nodes/IndexNode.ts";
import LetNode from "../nodes/LetNode.ts";
import MatchNode from "../nodes/MatchNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import PanicNode from "../nodes/PanicNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import RawNode from "../nodes/RawNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import RootNode from "../nodes/RootNode.ts";
import StructNode from "../nodes/StructNode.ts";
import SwitchNode from "../nodes/SwitchNode.ts";
import TodoNode from "../nodes/TodoNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import UnsafeBlockNode from "../nodes/UnsafeBlockNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import WhileLoopNode from "../nodes/WhileLoopNode.ts";
import build_access_node from "./build_access_node.ts";
import build_array_values_node from "./build_array_values_node.ts";
import build_assignment_node from "./build_assignment_node.ts";
import build_async_block_node from "./build_async_block_node.ts";
import build_bitset_node from "./build_bitset_node.ts";
import build_break_node from "./build_break_node.ts";
import build_cast_node from "./build_cast_node.ts";
import build_continue_node from "./build_continue_node.ts";
import build_declaration_node from "./build_declaration_node.ts";
import build_enum_node from "./build_enum_node.ts";
import build_for_loop_node from "./build_for_loop_node.ts";
import build_function_call_node from "./build_function_call_node.ts";
import build_if_else_node from "./build_if_else_node.ts";
import build_index_node from "./build_index_node.ts";
import build_let_node from "./build_let_node.ts";
import build_magic_ctor_node from "./build_magic_ctor.ts";
import build_match_node from "./build_match_node.ts";
import build_operation_node from "./build_operation_node.ts";
import build_panic_node from "./build_panic_node.ts";
import build_range_node from "./build_range_node.ts";
import build_raw_node from "./build_raw_node.ts";
import build_return_node from "./build_return_node.ts";
import build_root_node from "./build_root_node.ts";
import build_struct_node from "./build_struct_node.ts";
import build_switch_node from "./build_switch_node.ts";
import build_todo_node from "./build_todo_node.ts";
import build_trait_node from "./build_trait_node.ts";
import build_value_node from "./build_value_node.ts";
import build_while_loop_node from "./build_while_loop_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import build_lambda_value from "./utils/build_lambda_value.ts";
import { statement_ends_with_block } from "./utils/statement_tail.ts";

export default function build_node(node: BaseNode, status: BuildStatus, with_semicolon = false) {
	// Build any associated declarations first, e.g. for function call params that
	// will later be freed. Dedupe via `status.emitted_allocations` so an
	// allocation already surfaced per-statement by `emit_allocations` (or by an
	// earlier build of this shared AST — we must not clear-as-we-go) emits once.
	if (node.allocations) {
		if (!status.emitted_allocations) status.emitted_allocations = new Set();
		for (let decl of node.allocations) {
			if (status.emitted_allocations.has(decl)) continue;
			status.emitted_allocations.add(decl);
			build_node(decl, status, true);
		}
	}

	switch (node.node_type) {
		case "root": {
			build_root_node(node as RootNode, status);
			break;
		}
		case "declare": {
			const decl = node as DeclarationNode;
			build_declaration_node(decl, status);
			if (decl.value?.node_type === "func") {
				with_semicolon = false;
			}
			break;
		}
		case "assign": {
			build_assignment_node(node as AssignmentNode, status);
			break;
		}
		case "struct": {
			build_struct_node(node as StructNode, status);
			break;
		}
		case "extend": {
			// Methods on `extend struct/class Name { ... }` were merged into
			// the target struct's functions during check and are emitted by
			// build_struct_node; the extend node itself carries no code.
			break;
		}
		case "trait": {
			build_trait_node(node as TraitNode, status);
			break;
		}
		case "enum": {
			// Generic enums are templates — only their monomorphized forms
			// (created during check) have a concrete layout to emit.
			if (!(node as EnumNode).is_generic) {
				build_enum_node(node as EnumNode, status);
			}
			break;
		}
		case "bitset": {
			build_bitset_node(node as BitsetNode, status);
			break;
		}
		case "func": {
			// A lambda in VALUE position (a func-typed call argument, or a
			// declaration/assignment initializer): its definition is hoisted
			// to file scope (C may not nest function definitions in an
			// expression) and the value is the function's identifier. A named
			// `func` STATEMENT never reaches build_node — block builders call
			// build_function_node directly — so anything here is a lambda.
			build_lambda_value(node as FunctionNode, status);
			with_semicolon = false;
			break;
		}
		case "func_call": {
			// The compiler-special Thread/Fiber(fn(args)) construction — and
			// the generalized user-Awaitable-class flavor — packs its task
			// eagerly and yields the instance (CLOSURE.md Phase 3b,
			// ASYNC.md "User-defined async primitives") — it never resolves
			// as a call.
			const fc = node as FunctionCallNode;
			if (fc.is_thread_ctor || fc.is_fiber_ctor || fc.is_awaitable_ctor) {
				build_magic_ctor_node(fc, status);
				break;
			}
			build_function_call_node(node as FunctionCallNode, status);
			break;
		}
		case "access": {
			const access = node as AccessNode;
			// A nursery.start(Thread(...)) or Thread(...).start() used as a
			// top-level statement discards its Task → fire-and-forget
			// (a spawn statement discards its Task).
			if (with_semicolon && access.access.node_type === "access_func") {
				const afn = access.access as AccessFunctionCallNode;
				if (
					afn.is_nursery_spawn ||
					afn.is_thread_start ||
					afn.is_thread_detach ||
					afn.is_fiber_start
				)
					afn.is_statement = true;
			}
			build_access_node(access, status);
			break;
		}
		case "grouped": {
			status.code += "(";
			build_node((node as GroupedNode).value, status);
			status.code += ")";
			break;
		}
		case "cast": {
			build_cast_node(node as CastNode, status);
			break;
		}
		case "op": {
			build_operation_node(node as OperationNode, status);
			break;
		}
		case "if": {
			build_if_else_node(node as IfElseNode, status);
			with_semicolon = false;
			break;
		}
		case "match": {
			build_match_node(node as MatchNode, status);
			with_semicolon = false;
			break;
		}
		case "switch": {
			build_switch_node(node as SwitchNode, status);
			with_semicolon = false;
			break;
		}
		case "for": {
			build_for_loop_node(node as ForLoopNode, status);
			with_semicolon = false;
			break;
		}
		case "while": {
			build_while_loop_node(node as WhileLoopNode, status);
			with_semicolon = false;
			break;
		}
		case "break": {
			build_break_node(node as BreakNode, status);
			break;
		}
		case "continue": {
			build_continue_node(node as ContinueNode, status);
			break;
		}
		case "panic": {
			build_panic_node(node as PanicNode, status);
			with_semicolon = false;
			break;
		}
		case "todo": {
			build_todo_node(node as TodoNode, status);
			with_semicolon = false;
			break;
		}
		case "return": {
			if ((node as ReturnNode).from_inline) {
				with_semicolon = false;
			} else {
				build_return_node(node as ReturnNode, status);
			}
			break;
		}
		case "let": {
			build_let_node(node as LetNode, status);
			break;
		}
		case "value": {
			build_value_node(node as ValueNode, status);
			break;
		}
		case "array": {
			build_array_values_node(node as ArrayValuesNode, status);
			break;
		}
		case "range": {
			build_range_node(node as RangeNode, status);
			break;
		}
		case "raw": {
			build_raw_node(node as RawNode, status);
			with_semicolon = false;
			break;
		}
		case "async_block": {
			build_async_block_node(node as AsyncBlockNode, status);
			with_semicolon = false;
			break;
		}
		case "anon_struct": {
			const anon = node as AnonStructNode;
			// A base-bearing literal (`[ .. <base>, ... ]`) emits its base
			// expression — the destination slot gets a copy of the base (the
			// owning-struct copy/move rule was enforced at check time); the
			// destination sites apply the field overrides afterwards.
			if (anon.base) {
				build_node(anon.base, status);
				break;
			}
			for (const field of anon.fields) {
				build_node(field.value, status);
			}
			break;
		}
		case "index": {
			build_index_node(node as IndexNode, status);
			break;
		}
		case "unsafe": {
			// `unsafe { ... }` is a pure checker-level scope: the statements
			// build sequentially. Statements that need their own semicolons
			// handle that themselves (mirrors the root/func block builders).
			for (const stmt of (node as UnsafeBlockNode).statements) {
				build_node(stmt, status, true);
			}
			with_semicolon = false;
			break;
		}
		default: {
			throw Error("Invalid node: " + node.node_type);
		}
	}

	// Add a semicolon if this is a statement
	if (with_semicolon) {
		// But not if the statement's emission ended with a block (a branch
		// lowered to a C if/switch statement — see statement_ends_with_block).
		// The historical `status.code.endsWith("}\n")` peek forced a FULL
		// flatten of the accumulated code rope (an O(code) copy) at
		// per-statement frequency, which made builds quadratic in memory.
		if (!statement_ends_with_block(node, status)) {
			status.code += ";\n";
		}
		// Flush frees deferred from move call sites inside this statement
		// (VALUE-struct string fields — see build_access_node /
		// build_function_call_node). Appending them at the call itself would
		// break the surrounding expression.
		if (status.pending_string_releases?.length) {
			status.code += status.pending_string_releases.join("\n") + "\n";
			status.pending_string_releases.length = 0;
		}
	}
}
