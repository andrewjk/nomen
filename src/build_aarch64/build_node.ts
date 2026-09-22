import type BuildStatus from "../build_c/BuildStatus.ts";
import emission_label from "../build_common/emission_label.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AnonStructNode from "../nodes/AnonStructNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import CastNode from "../nodes/CastNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
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
import SwitchNode from "../nodes/SwitchNode.ts";
import TodoNode from "../nodes/TodoNode.ts";
import UnsafeBlockNode from "../nodes/UnsafeBlockNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import WhileLoopNode from "../nodes/WhileLoopNode.ts";
import build_access_node from "./build_access_node.ts";
import build_array_values_node from "./build_array_values_node.ts";
import build_assignment_node from "./build_assignment_node.ts";
import build_async_block_node from "./build_async_block_node.ts";
import build_block_node from "./build_block_node.ts";
import build_break_node from "./build_break_node.ts";
import build_cast_node from "./build_cast_node.ts";
import build_continue_node from "./build_continue_node.ts";
import build_declaration_node from "./build_declaration_node.ts";
import build_for_loop_node from "./build_for_loop_node.ts";
import build_function_call_node from "./build_function_call_node.ts";
import build_function_node from "./build_function_node.ts";
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
import build_switch_node from "./build_switch_node.ts";
import build_todo_node from "./build_todo_node.ts";
import build_value_node from "./build_value_node.ts";
import build_while_loop_node from "./build_while_loop_node.ts";
import { emit_malloc, emit_strdup } from "./utils/audit.ts";
import {
	closure_env_layout_a64,
	emit_descriptor_address,
	emit_env_free_a64,
	materialize_lambda_descriptor_a64,
} from "./utils/closure_a64.ts";
import { emit_asm, ensure_newline } from "./utils/code_buffer.ts";
import { emit_var_address } from "./utils/stack_var.ts";
import { get_struct_size } from "./utils/struct_layout.ts";

/**
 * Emit a capturing lambda's value (CLOSURE.md Phase 2): heap-allocate the
 * env, copy each capture (scalar, 8-byte field) from the enclosing scope, then
 * heap-allocate the descriptor { code, env, owned = 1 }. Leaves the descriptor
 * pointer in x0. The env pointer is parked on the stack across the capture
 * builds (build_node clobbers x9/x10 freely).
 */
function emit_capturing_closure_value_a64(fn: FunctionNode, status: BuildStatus): void {
	const { offsets, size: env_size } = closure_env_layout_a64(fn, status);
	emit_asm(status, `mov x0, #${env_size}\n`);
	emit_malloc(status);
	emit_asm(status, `str x0, [sp, #-16]!\n`);
	for (const cap of fn.captures!) {
		const off = offsets.get(cap.name)!;
		const is_string = cap.type.name === "string" && !cap.type.is_view && !cap.type.is_array;
		const cap_struct = status.structs.find(
			(s) => s.name === cap.type.name && !s.is_simple_type && !s.is_class,
		);
		if (cap_struct) {
			// A value struct captures by COPY: take the source's ADDRESS (a
			// value struct is accessed by address) and memcpy its bytes into
			// the env field. build_node would LOAD the first word instead.
			// (A MOVE capture transfers those bytes; the donor is marked moved
			// below so it is not destroyed at scope exit.)
			emit_var_address(status, "x0", cap.name);
			ensure_newline(status);
			const cap_size = get_struct_size(cap.type.name, status);
			emit_asm(status, `mov x1, x0\n`);
			emit_asm(status, `ldr x9, [sp]\n`);
			emit_asm(status, `add x0, x9, #${off}\n`);
			emit_asm(status, `mov x2, #${cap_size}\n`);
			emit_asm(status, `bl _memcpy\n`);
		} else {
			// Scalars, class instance pointers, and func descriptors transfer
			// by value (build_node loads the descriptor / instance pointer).
			build_node(new ValueNode(fn.start, cap.name, cap.type), status);
			ensure_newline(status);
			if (is_string) {
				// Deep-copy the captured string into the env (the env destructor
				// frees the copy); emit_strdup preserves the len half in x1.
				emit_strdup(status);
				emit_asm(status, `ldr x9, [sp]\n`);
				emit_asm(status, `str x0, [x9, #${off}]\n`);
				emit_asm(status, `str x1, [x9, #${off + 8}]\n`);
			} else {
				emit_asm(status, `ldr x9, [sp]\n`);
				emit_asm(status, `str x0, [x9, #${off}]\n`);
			}
		}
		// A MOVE capture transfers ownership out of the donating local: mark it
		// so scope exit skips destroying it (the env destructor owns it now),
		// and drop its heap-string-field records (the env's <T>_destroy frees
		// them). Mirrors the `move`-arg path.
		if (cap.is_move) {
			if (!status.moved) status.moved = new Set();
			status.moved.add(cap.name);
			const prefix = `${cap.name}.`;
			for (const key of Array.from(status.heap_string_fields ?? [])) {
				if (key.startsWith(prefix)) status.heap_string_fields!.delete(key);
			}
		}
	}
	emit_asm(status, `mov x0, #32\n`);
	emit_malloc(status);
	emit_asm(status, `ldr x9, [sp], #16\n`);
	emit_asm(status, `str x9, [x0, #8]\n`);
	emit_asm(status, `adr x10, ${emission_label(fn)}\n`);
	emit_asm(status, `str x10, [x0]\n`);
	emit_asm(status, `mov w10, #1\n`);
	emit_asm(status, `str w10, [x0, #16]\n`);
	const destroy = emit_env_free_a64(fn, status);
	if (destroy) {
		emit_asm(status, `adr x10, ${destroy}\n`);
		emit_asm(status, `str x10, [x0, #24]\n`);
	} else {
		emit_asm(status, `str xzr, [x0, #24]\n`);
	}
}

export default function build_node(node: BaseNode, status: BuildStatus, with_semicolon = false) {
	// Build any associated declarations first, e.g. for function call params
	// that will later be freed. The C backend relies on `emit_allocations`
	// (called per-statement from build_block_node) to surface these before
	// the consuming statement runs; aarch64 needs that path too (for cases
	// like LayoutLength-by-value params whose allocations live on a nested
	// call arg), but emit_allocations doesn't recurse into every node kind
	// (match branches, if bodies, …). Both paths therefore check
	// `status.emitted_allocations` so an allocation is emitted at most once
	// per build — and the AST is shared across the aarch64 and C builds, so
	// we can't clear-as-we-go.
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
			build_block_node(node as RootNode, status);
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
		case "func": {
			// A lambda in VALUE position (a func-typed call argument, or a
			// declaration/assignment initializer): its body emits as a
			// function (buffered after the enclosing one via the nested-func
			// path) and the value is the function's address. A named `func`
			// STATEMENT never reaches build_node — block builders call
			// build_function_node directly — so anything here is a lambda.
			// Outside a function body (a file-scope declaration) there is no
			// x0 to leave a value in; the definition alone is the emission.
			build_function_node(node as FunctionNode, status);
			if (status.function_return_label) {
				// The value is the lambda's closure DESCRIPTOR
				// (CLOSURE.md), not the raw code address. A capturing
				// lambda builds a heap env (one 8-byte scalar per capture) plus
				// a heap descriptor (owned = 1); a capture-free one points at a
				// static descriptor.
				const fn = node as FunctionNode;
				if (fn.captures?.length) {
					emit_capturing_closure_value_a64(fn, status);
				} else {
					const desc = materialize_lambda_descriptor_a64(fn, status);
					emit_descriptor_address(status, "x0", desc);
				}
			}
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
		case "grouped": {
			build_node((node as GroupedNode).value, status);
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
		case "cast": {
			build_cast_node(node as CastNode, status);
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
			build_break_node(status);
			break;
		}
		case "continue": {
			build_continue_node(status);
			break;
		}
		case "return": {
			build_return_node(node as ReturnNode, status);
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
		case "access": {
			const access = node as AccessNode;
			if (with_semicolon && access.access.node_type === "access_func") {
				const afn = access.access as AccessFunctionCallNode;
				if (afn.is_nursery_spawn) afn.is_statement = true;
			}
			build_access_node(access, status);
			break;
		}
		case "panic": {
			build_panic_node(node as PanicNode, status);
			break;
		}
		case "todo": {
			build_todo_node(node as TodoNode, status);
			break;
		}
		case "raw": {
			build_raw_node(node as RawNode, status);
			with_semicolon = false;
			break;
		}
		case "async_block": {
			build_async_block_node(node as any, status);
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
			with_semicolon = false;
			break;
		}
		case "unsafe": {
			for (const stmt of (node as UnsafeBlockNode).statements) {
				build_node(stmt, status, true);
			}
			with_semicolon = false;
			break;
		}
		case "enum":
		case "bitset":
		case "extend": {
			// `extend` methods were merged into the target struct during check
			// and are emitted by build_struct_node; nothing to emit here.
			break;
		}
		default: {
			throw Error("Invalid node: " + node.node_type);
		}
	}

	if (with_semicolon) {
		ensure_newline(status);
	}
}
