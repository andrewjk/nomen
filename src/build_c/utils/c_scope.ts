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
