import type { NirStmt } from "../nir/nir.ts";
import type DeclarationNode from "../nodes/DeclarationNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import WhileLoopNode from "../nodes/WhileLoopNode.ts";
import collect_allocations from "../build_common/collect_allocations.ts";
import build_auto_free from "./build_auto_free.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { build_block_with_cursor } from "./emit_nir.ts";
import build_condition from "./utils/build_condition.ts";
import { enter_c_scope, leave_c_scope, pop_c_loop_frame, push_c_loop_frame } from "./utils/c_scope.ts";
import build_parameter_node from "./build_parameter_node.ts";

/**
 * Whether a hoisted condition temporary can be RE-EVALUATED per iteration
 * with a plain C assignment (`name = value;`). Array/range literals carry
 * inline data (no C array assignment) and nullable structs use the paired
 * `_has` flag protocol — those keep the declare-once-before-the-loop shape.
 */
function is_reevaluatable(alloc: BaseNode): boolean {
	const decl = alloc as DeclarationNode;
	if (!decl.value) return false;
	if (decl.type?.is_array) return false;
	if (decl.type?.is_nullable) return false;
	if (decl.value.node_type === "array" || decl.value.node_type === "range") return false;
	if ((decl as unknown as { is_heap_array_literal?: boolean }).is_heap_array_literal) return false;
	if ((decl as unknown as { is_heap_array_copy?: boolean }).is_heap_array_copy) return false;
	return true;
}

export default function build_while_loop_node(
	node: WhileLoopNode,
	status: BuildStatus,
	nir?: NirStmt & { kind: "while" },
) {
	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = enter_c_scope(status);
	const old_deferred_frees = status.deferred_frees;
	status.deferred_frees = [];
	push_c_loop_frame(status);

	// (String `.length` is a field load on the fat nomen_string value —
	// no strlen hoisting is needed anymore.)

	// Hoisted condition temporaries: the declarations must sit before the
	// `while` (a C declaration cannot live inside the controlling expression),
	// but a temp capturing a loop-mutated variable would be FROZEN at its
	// pre-loop value — `while is_num(code_at(src, i))` never re-reads `i`
	// (infinite loop / early exit). Re-evaluatable temps therefore get a
	// bare (or null-initialized) declaration before the loop and an
	// ASSIGNMENT inside the condition's statement expression, so the value —
	// and every side effect feeding it — re-evaluates on every check.
	const reeval_allocs: DeclarationNode[] = [];
	{
		if (!status.emitted_allocations) status.emitted_allocations = new Set();
		// The checker promotes the loop's hoisted condition (and update)
		// temporaries onto the while statement itself; collecting from the
		// node picks them up in dependency order.
		const allocations = collect_allocations(node, { let_values: true });
		for (const alloc of allocations) {
			if (status.emitted_allocations.has(alloc)) continue;
			status.emitted_allocations.add(alloc);
			if (is_reevaluatable(alloc)) {
				const decl = alloc as DeclarationNode;
				reeval_allocs.push(decl);
				// Bare declaration; owning shapes null-initialize so the
				// per-iteration displaced free below is a no-op on entry.
				build_parameter_node(new ParameterNode(decl.start, decl.name, decl.type), status);
				if (decl.type?.name === "string" && !decl.type?.is_view) {
					status.code += ` = (nomen_string){0, 0}`;
				} else if (
					status.structs.find((s) => s.name === decl.type?.name && s.is_class) ||
					status.traits.find((t) => t.name === decl.type?.name)
				) {
					status.code += ` = 0`;
				}
				status.code += `;\n`;
				// Register for loop-exit auto_free so the LAST value of an
				// owning temp is reclaimed (mirrors the declaration path,
				// which never registers view-typed declarations — a view's
				// ptr aliases its source's storage and must not be freed).
				if (!decl.type?.is_view) {
					status.scoped_declarations.push(decl);
				}
			} else {
				build_node(alloc, status, true);
			}
		}
	}

	const emit_condition_reeval = (): boolean => {
		if (reeval_allocs.length === 0) return false;
		status.code += `({ `;
		for (const decl of reeval_allocs) {
			// Reclaim the displaced value before the re-store: an owning temp
			// (heap string / class / trait instance) would leak every
			// iteration otherwise.
			if (decl.type?.name === "string" && !decl.type?.is_view) {
				status.code += `free(${decl.name}.ptr); `;
			} else if (
				status.structs.find((s) => s.name === decl.type?.name && s.is_class) ||
				status.traits.find((t) => t.name === decl.type?.name)
			) {
				status.code += `if (${decl.name}) { ${decl.type?.name}_destroy(${decl.name}); free(${decl.name}); } `;
			}
			status.code += `${decl.name} = `;
			build_node(decl.value!, status);
			status.code += `; `;
		}
		return true;
	};

	// When there's an update clause (e.g. `while n <= 20; n += 1`), emit a
	// C `for` loop so that `continue` inside the body still runs the update
	// before re-checking the condition — matching the language's semantics.
	if (node.update) {
		status.code += `for (; `;
		const has_reeval = emit_condition_reeval();
		build_condition(node.condition, status);
		if (has_reeval) status.code += `; })`;
		status.code += `; `;
		build_node(node.update, status);
		status.code += `) {\n`;
	} else {
		status.code += `while (`;
		const has_reeval = emit_condition_reeval();
		build_condition(node.condition, status);
		if (has_reeval) status.code += `; })`;
		status.code += `) {\n`;
	}

	build_block_with_cursor(node, nir?.body, status);

	build_auto_free(status);

	status.code += `}\n`;

	pop_c_loop_frame(status);
	leave_c_scope(status);
	status.scoped_declarations = old_scoped_declarations;
	status.deferred_frees = old_deferred_frees;
}
