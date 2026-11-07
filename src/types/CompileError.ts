import type { FieldSetQuickFix } from "../check/utils/field_effects.ts";

export default interface CompileError {
	message: string;
	start: number;
	line: number;
	column: number;
	/**
	 * Structured editor edit for declared-field-set diagnostics
	 * (FIELD_EFFECTS.md): add or extend the field set (`{ … }`) on a `ref`
	 * parameter. Offsets share `start`'s coordinate space. The CLI ignores
	 * it; the VSCode extension turns it into a quick fix.
	 */
	quick_fix?: FieldSetQuickFix;
}
