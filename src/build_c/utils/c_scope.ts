import DeclarationNode from "../../nodes/DeclarationNode.ts";
import { free_scoped_declarations } from "../build_auto_free.ts";
import type BuildStatus from "../BuildStatus.ts";

/**
 * Begin a new C scope frame: allocate a fresh declarations array, push it onto
 * c_scope_stack, and make it the active scoped_declarations. Returns the frame
 * so the caller can assign it to status.scoped_declarations (mirroring the
 * existing save/restore idiom). Pair with leave_c_scope at scope exit.
 */
export function enter_c_scope(status: BuildStatus): DeclarationNode[] {
	const frame: DeclarationNode[] = [];
	if (!status.c_scope_stack) status.c_scope_stack = [];
	status.c_scope_stack.push(frame);
	return frame;
}

/** Pop the current scope frame from c_scope_stack (scope-exit counterpart to enter_c_scope). */
export function leave_c_scope(status: BuildStatus) {
	status.c_scope_stack?.pop();
}

/**
 * Mark the current top frame as a loop body, so break/continue know how far up
 * the scope stack to reclaim. Call AFTER entering the loop body scope.
 */
export function push_c_loop_frame(status: BuildStatus) {
	if (!status.c_scope_stack?.length) return;
	if (!status.c_loop_frame_depth) status.c_loop_frame_depth = [];
	status.c_loop_frame_depth.push(status.c_scope_stack.length - 1);
}

export function pop_c_loop_frame(status: BuildStatus) {
	status.c_loop_frame_depth?.pop();
}

/**
 * Reclaim declarations from every scope frame on c_scope_stack — a `return`
 * exits ALL enclosing scopes up to the function boundary, not just the
 * current one, so declarations living in outer frames (e.g. a class instance
 * declared before an `if (...) { ... return }`) must be freed before the
 * jump. Nothing is cleared: sibling return statements and the fall-through
 * path are mutually exclusive at runtime but are ALL emitted, so every path
 * needs its own copy of the frees (the function-tail scope-exit auto_free
 * serves the fall-through). Deferred frees are handled like build_auto_free.
 */
export function reclaim_all_c_scopes(status: BuildStatus) {
	const stack = status.c_scope_stack;
	if (!stack?.length) {
		free_scoped_declarations(status, status.scoped_declarations, true);
	} else {
		for (const frame of stack) {
			free_scoped_declarations(status, frame, true);
		}
	}
	if (status.deferred_frees?.length) {
		status.code += "\n// Deferred frees\n";
		for (const d of status.deferred_frees) {
			if (d.is_nullable) {
				status.code += `if (${d.temp}) { ${d.struct_name}_destroy(${d.temp}); free(${d.temp}); }\n`;
			} else {
				status.code += `${d.struct_name}_destroy(${d.temp}); free(${d.temp});\n`;
			}
		}
	}
}

/**
 * Reclaim declarations from every frame between the current scope and the
 * innermost loop's body frame (inclusive), then return the loop body index.
 * Used by break/continue: the freed declarations' scope-exit auto_free either
 * runs on the (mutually exclusive) non-jump path or is dead code after the
 * jump, so this never double-frees. The innermost frame is cleared afterwards
 * so its dead post-jump auto_free emits nothing.
 */
export function reclaim_to_loop_body(status: BuildStatus): number | undefined {
	const stack = status.c_scope_stack;
	const loopDepth = status.c_loop_frame_depth;
	if (!stack?.length || !loopDepth?.length) return undefined;
	const loopBodyIdx = loopDepth[loopDepth.length - 1];
	for (let i = stack.length - 1; i >= loopBodyIdx; i--) {
		free_scoped_declarations(status, stack[i]);
	}
	// The innermost frame's scope-exit auto_free is unreachable after the jump
	// (the jump exits that scope), so clear it to avoid emitting dead
	// double-free code. Enclosing frames keep their declarations — their
	// auto_free still serves the non-jump path.
	stack[stack.length - 1].length = 0;
	return loopBodyIdx;
}
