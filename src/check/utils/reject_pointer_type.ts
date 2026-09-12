import add_error from "../../add_error.ts";
import Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";

/**
 * `ptr T` types may only be INTRODUCED inside an unsafe context (the System
 * library): locals, struct fields, parameters, and return types. Casts and
 * indexing are gated separately (check_cast_node / check_index_node); this
 * closes the remaining holes — a user declaration of a pointer-typed slot
 * would otherwise be accepted (inert but constructible), and a pointer-typed
 * parameter or field would let a type escape the library's unsafe internals.
 */
export default function reject_pointer_type(
	type: Type | undefined,
	status: CheckStatus,
	start: number,
): void {
	if (type?.is_pointer && !status.in_unsafe) {
		add_error(
			status,
			`'ptr' types are reserved for the System library — raw pointer manipulation is not available to user code`,
			start,
		);
	}
}
