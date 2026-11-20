import type QuickFix from "../check/utils/QuickFix.ts";

export default interface CompileError {
	message: string;
	start: number;
	line: number;
	column: number;
	/**
	 * Secondary location (two-location diagnostics): when the error was
	 * raised on code a compile-time `#for` expansion generated, the source
	 * offset of the generating `#for` statement (`node.spawn_of`). Resolved
	 * to `spawned_line`/`spawned_column` alongside the primary position and
	 * rendered as a "spawned by `#for`" note, so a diagnostic inside an arm
	 * is recognizable as generated code and points back at its loop.
	 */
	spawned_at?: number;
	spawned_line?: number;
	spawned_column?: number;
	/**
	 * Structured editor edit. Two families: declared-field-set diagnostics
	 * (FIELD_EFFECTS.md — add or extend the field set (`{ … }`) on a `ref`
	 * parameter), and ownership-spelling diagnostics (insert or rewrite the
	 * `mv` keyword). Offsets share `start`'s coordinate space. The CLI ignores
	 * it; the VSCode extension turns it into a quick fix.
	 */
	quick_fix?: QuickFix;
}
