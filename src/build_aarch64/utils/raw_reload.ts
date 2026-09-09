import type BuildStatus from "../../build_c/BuildStatus.ts";

/**
 * Raw `#arch: aarch64` blocks are spliced verbatim wherever their statement
 * sits, but they read their parameters from the entry ABI registers (x0,
 * x1, … — the values the caller loaded). After any control flow or
 * expression evaluation those registers hold scratch values, so a raw block
 * that is NOT the function's first body statement must re-establish the
 * entry values first. The prologue spilled every register-slot param to its
 * x29 home slot (or parked it in a callee-saved register), and those homes
 * stay live at every statement boundary — so each entry register has a
 * fixed reload.
 *
 * Each prologue builder (build_function_node, build_struct_node,
 * build_custom_init_function, build_inline_method, build_inline_function)
 * records one entry per restorable ABI register while it spills params,
 * then installs the plan around its body build. build_raw_node splices the
 * lines for the registers the block actually names. The C backend is
 * unaffected (raw C bodies reference params by name through the generated
 * glue).
 */
export interface RawParamReloadPlan {
	/** status.code.length captured when the body build begins. A raw block
	 *  spliced at exactly this offset still sees the entry registers and
	 *  needs no reload. */
	entry_marker: number;
	/** One entry per restorable ABI register, in slot order. */
	lines: RawParamReloadLine[];
}

export interface RawParamReloadLine {
	/** The entry ABI register the line restores ("x0".."x7", or "x8" for an
	 *  sret buffer). Overflow args (slot >= 8) never ride a register at
	 *  entry and have no entry to restore. */
	reg: string;
	asm: string;
}

/** Width-aware slot reload — mirrors the prologue's store width so the
 *  register holds exactly the value a body read of the slot would produce
 *  (sub-word stores truncate; a same-width load zero-extends like the
 *  emitters' own slot reads). */
export function raw_slot_reload_line(reg: string, offset: number, size: number): string {
	const wreg = reg.replace("x", "w");
	if (size === 1) return `ldrb ${wreg}, [x29, #${offset}]`;
	if (size === 2) return `ldrh ${wreg}, [x29, #${offset}]`;
	if (size === 4) return `ldr ${wreg}, [x29, #${offset}]`;
	return `ldr ${reg}, [x29, #${offset}]`;
}

/** Capture status.code.length as the entry point and install the plan. */
export function install_raw_reload_plan(
	status: BuildStatus,
	lines: RawParamReloadLine[],
): RawParamReloadPlan {
	const plan: RawParamReloadPlan = { entry_marker: status.code.length, lines };
	status.raw_param_reloads = plan;
	return plan;
}

/**
 * The reload lines a raw block needs: none at the function's entry point
 * (the registers still hold the entry values), otherwise the lines for the
 * ABI registers the block's text references. Registers are matched against
 * comment-stripped instruction text only — a mention in a `//` comment, a
 * label, or a data directive doesn't force a reload (same discipline as
 * build_inline_method's count_x19_reads).
 */
export function raw_reload_lines_for(
	code: string,
	plan: RawParamReloadPlan | undefined,
	current_length: number,
): string[] {
	if (!plan || plan.lines.length === 0 || current_length === plan.entry_marker) return [];
	const referenced = new Set<string>();
	for (const raw_line of code.split("\n")) {
		const comment = raw_line.indexOf("//");
		const line = (comment === -1 ? raw_line : raw_line.slice(0, comment)).trim();
		if (!line || line.endsWith(":") || line.startsWith(".")) continue;
		for (const match of line.matchAll(/\b[wx][0-9]\b/g)) {
			referenced.add(match[0]);
		}
	}
	const out: string[] = [];
	for (const entry of plan.lines) {
		if (referenced.has(entry.reg) || referenced.has(entry.reg.replace("x", "w"))) {
			out.push(entry.asm);
		}
	}
	return out;
}
