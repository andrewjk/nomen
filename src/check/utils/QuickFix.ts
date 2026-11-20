/**
 * A structured edit the editor can apply to resolve a diagnostic. Offsets are
 * source offsets, same coordinate space as `CompileError.start`. The CLI
 * ignores it; the VSCode extension turns it into a quick fix (matching by
 * message + start offset).
 */
export default interface QuickFix {
	title: string;
	/** The parameter this edit modifies (its first token's offset) — field-set fixes. */
	param_start?: number;
	/** Insert `insert_text` at this offset (creating a new set). */
	insert_offset?: number;
	insert_text?: string;
	/** Replace [replace_start, replace_end) with `replace_text`. */
	replace_start?: number;
	replace_end?: number;
	replace_text?: string;
}
