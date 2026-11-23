import { default_platform } from "./build.ts";
import type QuickFix from "./check/utils/QuickFix.ts";
import type { Library } from "./lib.ts";
import parse from "./parse.ts";

/**
 * The ownership-spelling pass for `nomen format` (FOLLOWUP.md): the three
 * ownership-spelling diagnostics (field requirement, store marker, fresh
 * initializer) carry structured quick fixes, and this pass applies them to a
 * whole file. It is a CHECK-adjacent rewrite, not a token transform — the
 * edits need `slot_requires_mv` classification, which only exists after a
 * parse + check with the library linked — so it runs before the layout
 * formatter and loops (apply, re-check) until no diagnostic remains.
 */
const is_ownership_message = (message: string): boolean =>
	(message.startsWith("field '") && message.includes("owns memory")) ||
	(message.startsWith("storing '") && message.includes("moves it")) ||
	message.includes("transfers nothing");

export function apply_ownership_spellings(
	source: string,
	options: { lib?: Library; file?: string; arches?: string[] } = {},
): { code: string; changed: boolean; rounds: number } {
	const arches = options.arches ?? ["c", "aarch64"];
	const platform = default_platform();
	let code = source;
	// Both targets: a type-body `#if` can select fields per arch, and a fix
	// must only fire for a field that exists in the checked tree. Duplicate
	// sites (a field present for both) dedupe below.
	for (let rounds = 0; rounds < 12; rounds++) {
		const fixes = new Map<string, QuickFix>();
		for (const arch of arches) {
			const parsed = parse(code, options.lib, options.file, { arch, platform });
			for (const diagnostic of [...parsed.errors, ...parsed.warnings]) {
				if (!diagnostic.quick_fix || !is_ownership_message(diagnostic.message)) continue;
				fixes.set(`${diagnostic.start}:${diagnostic.message.slice(0, 32)}`, diagnostic.quick_fix);
			}
		}
		if (!fixes.size) {
			return { code, changed: rounds > 0, rounds };
		}
		// Apply descending by edit start so one round's edits never shift a
		// later offset in the same pass; the next round re-checks the result.
		const edits = [...fixes.values()]
			.map((fix) => ({ fix, at: fix.insert_offset ?? fix.replace_start ?? 0 }))
			.sort((a, b) => b.at - a.at);
		for (const { fix } of edits) {
			if (fix.insert_offset !== undefined && fix.insert_text !== undefined) {
				code = code.slice(0, fix.insert_offset) + fix.insert_text + code.slice(fix.insert_offset);
			} else if (
				fix.replace_start !== undefined &&
				fix.replace_end !== undefined &&
				fix.replace_text !== undefined
			) {
				code = code.slice(0, fix.replace_start) + fix.replace_text + code.slice(fix.replace_end);
			}
		}
	}
	// Fell through: the 12-round cap was hit with fixes still firing.
	return { code, changed: true, rounds: 12 };
}
