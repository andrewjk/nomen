import type BuildStatus from "../BuildStatus.ts";

/**
 * Redirect `status.code` into a fresh scratch string for a SPECULATIVE
 * emission (the capture + rollback pattern: build a sub-expression, extract
 * the text it appended, and leave the main code untouched). `begin` returns
 * the saved outer code; `end` returns what the speculative build emitted and
 * restores the outer code.
 *
 * This replaces the historical
 * `const before = status.code.length; …; status.code.substring(before);
 * status.code = status.code.substring(0, before);` idiom, whose
 * `substring` calls forced V8 to flatten the accumulated code rope — an
 * O(code) copy at expression frequency, which made builds quadratic in
 * memory (the scratch string is always small, and the restored rope is
 * never flattened). Nested speculative windows compose naturally: every
 * site swaps `status.code` through the same property.
 *
 * CALLERS MUST capture the `end` result in a LOCAL before appending it to
 * `status.code`. A compound `status.code += end_code_scratch(...)` reads the
 * (empty) scratch on the left BEFORE the call restores the outer code —
 * the setter then overwrites the restored code with just the fragment.
 */
export function begin_code_scratch(status: BuildStatus): string {
	const saved = status.code;
	status.code = "";
	return saved;
}

export function end_code_scratch(status: BuildStatus, saved: string): string {
	const scratch = status.code;
	status.code = saved;
	return scratch;
}
