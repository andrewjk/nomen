/**
 * A tiny constant-propagation peephole over monomorphized raw aarch64
 * assembly (`#arch: aarch64` blocks after T → concrete-type substitution).
 *
 * Raw library code is written generically: `mov x3, #T_SIZE` followed by a
 * runtime width dispatch (`cmp x3, #8 / b.gt … / cmp x3, #1 / b.eq …`).
 * After substitution T_SIZE is a literal, so every dispatched branch has a
 * compile-time outcome — but as TEXT, so nothing folds it. This pass tracks
 * `mov <reg>, #<imm>` definitions per basic block and:
 *
 *   - folds `cmp <reg>, #<imm>` + following `b.<cond> <label>` when the
 *     comparison's outcome is known: never-taken branches are dropped,
 *     always-taken ones become unconditional `b <label>`,
 *   - rewrites `madd <d>, <n>, <m>, xzr` / `mul <d>, <n>, <m>` as
 *     `lsl <d>, <n>, #<log2>` when `<m>` is a known power-of-two constant
 *     (the element-stride multiply in every load_T/store_T body).
 *
 * Soundness: a register's definition is only tracked from its immediate
 * `mov` to its next write; the map is cleared at labels (jump targets may
 * arrive with different values), at unconditional branches, at calls
 * (`bl`/`blr` clobber the caller-saved set), and at any instruction form we
 * do not model. Dead code left behind dropped branches (e.g. the
 * width-matched tails and the memcpy copy path) stays in place — it is
 * unreachable, and removing it would require a full reachability pass.
 * Comments (`// …`) are ignored.
 */

const REG = /^[wx][0-9]+$/;
const COND_OPS = new Set(["eq", "ne", "gt", "ge", "lt", "le", "hi", "hs", "lo", "ls", "al"]);

function split_comment(line: string): string {
	return line.replace(/\/\/.*$/, "");
}

/** Does `a <cond> b` hold? (signed semantics; immediates here are small.) */
function cond_holds(cond: string, a: number, b: number): boolean {
	switch (cond) {
		case "eq":
			return a === b;
		case "ne":
			return a !== b;
		case "gt":
			return a > b;
		case "ge":
			return a >= b;
		case "lt":
			return a < b;
		case "le":
			return a <= b;
		case "hi":
			return a > b;
		case "hs":
			return a >= b;
		case "lo":
			return a < b;
		case "ls":
			return a <= b;
		case "al":
			return true;
		default:
			return false;
	}
}

function is_pow2(n: number): number | undefined {
	if (n > 0 && (n & (n - 1)) === 0) return Math.log2(n);
	return undefined;
}

export function fold_asm_constants(asm: string): string {
	const lines = asm.split("\n");
	const out: string[] = [];
	const defs = new Map<string, number>();

	const clear = () => defs.clear();
	/** Invalidate the destination register of a general instruction. */
	const invalidate_dest = (ops: string) => {
		const first = ops.split(",")[0]?.trim();
		if (first && REG.test(first)) defs.delete(first);
	};

	let i = 0;
	while (i < lines.length) {
		const raw_line = lines[i];
		const line = split_comment(raw_line).trim();
		if (!line) {
			out.push(raw_line);
			i++;
			continue;
		}

		// Label or assembler directive: a possible join point — drop all
		// tracked constants.
		if (/^\.[\w$]+:$/.test(line) || line.startsWith(".")) {
			clear();
			out.push(raw_line);
			i++;
			continue;
		}

		const m = /^(\w+)\s*(.*)$/.exec(line);
		if (!m) {
			clear();
			out.push(raw_line);
			i++;
			continue;
		}
		const mn = m[1];
		const ops = m[2].trim();

		// Calls / unconditional branches / returns: nothing after is in the
		// same straight-line block as the constants before.
		if (mn === "bl" || mn === "blr" || mn === "b" || mn === "br" || mn === "ret") {
			clear();
			out.push(raw_line);
			i++;
			continue;
		}

		if (mn === "mov") {
			const mm = /^([wx][0-9]+)\s*,\s*#(-?\d+)$/.exec(ops);
			if (mm) {
				defs.set(mm[1], parseInt(mm[2], 10));
				out.push(raw_line);
				i++;
				continue;
			}
			invalidate_dest(ops);
			out.push(raw_line);
			i++;
			continue;
		}

		if (mn === "cmp") {
			const cm = /^([wx][0-9]+)\s*,\s*#(-?\d+)$/.exec(ops);
			if (cm && defs.has(cm[1])) {
				const a = defs.get(cm[1])!;
				const b = parseInt(cm[2], 10);
				// Collect the RUN of consecutive conditional branches that
				// decide on this comparison (blank/comment lines skipped).
				// Every b.cond in the run has a known outcome given the cmp
				// result, so the whole run — and the cmp itself — folds
				// together. This matters for dispatches like Array.set's
				// `b.eq .L8 / b.gt .Lcopy` pair: both test the SAME cmp, so
				// dropping the cmp with only the first branch would leave the
				// second reading stale flags.
				const run: { cond: string; label: string; line_idx: number }[] = [];
				let j = i + 1;
				while (j < lines.length) {
					const t = split_comment(lines[j]).trim();
					if (!t) {
						j++;
						continue;
					}
					const bm = /^b\.(\w+)\s+(\S+)$/.exec(t);
					if (bm && COND_OPS.has(bm[1])) {
						run.push({ cond: bm[1], label: bm[2], line_idx: j });
						j++;
						continue;
					}
					break;
				}
				// Safe-follower check: after dropping the cmp, execution
				// continues at the line following the run, which must not
				// read the now-unset flags. The dispatch shapes we fold end
				// at another cmp, a label/directive, an unconditional
				// branch/call/return, or a cbz/cbnz (which tests a register,
				// not nzcv). Anything else: keep the cmp and run unfolded.
				if (run.length > 0) {
					let follower = "";
					for (let k = run[run.length - 1].line_idx + 1; k < lines.length; k++) {
						const t = split_comment(lines[k]).trim();
						if (!t) continue;
						follower = t;
						break;
					}
					const follower_mn = /^(\S+)/.exec(follower)?.[1] ?? "";
					const follower_safe =
						follower === "" ||
						follower.startsWith(".") ||
						["cmp", "tst", "cmn", "b", "bl", "ret", "cbz", "cbnz"].includes(follower_mn);
					if (follower_safe) {
						for (const r of run) {
							if (cond_holds(r.cond, a, b)) {
								// First always-taken branch becomes an
								// unconditional b; anything after it in the
								// run is unreachable.
								out.push(`b ${r.label}`);
								break;
							}
						}
						// Never-taken branches (and lines after an
						// always-taken one) are dropped: advance past the run.
						i = run[run.length - 1].line_idx + 1;
						continue;
					}
				}
			}
			out.push(raw_line);
			i++;
			continue;
		}

		if (mn === "madd" || mn === "mul") {
			const parts = ops.split(",").map((p) => p.trim());
			if (parts.length === (mn === "madd" ? 4 : 3)) {
				const dest = parts[0];
				const srcs = [parts[1], parts[2]];
				const addend = mn === "madd" ? parts[3] : undefined;
				// madd folds only when the addend is zero (plain multiply).
				const addend_zero = mn === "madd" ? /^(x|w)zr$/.test(addend ?? "") : true;
				let folded = false;
				if (addend_zero && REG.test(dest)) {
					for (const [n_reg, m_reg] of [
						[srcs[0], srcs[1]],
						[srcs[1], srcs[0]],
					]) {
						const c = m_reg !== undefined && REG.test(m_reg) ? defs.get(m_reg) : undefined;
						const shift = c !== undefined ? is_pow2(c) : undefined;
						if (shift !== undefined && REG.test(n_reg) && !defs.has(n_reg)) {
							out.push(`lsl ${dest}, ${n_reg}, #${shift}`);
							defs.delete(dest);
							i++;
							folded = true;
							break;
						}
					}
				}
				if (folded) continue;
			}
			invalidate_dest(ops);
			out.push(raw_line);
			i++;
			continue;
		}

		// Any other instruction: invalidate its destination if tracked
		// (AArch64 datapath ops are dest-first; stores write memory).
		if (!["str", "stp", "cmp", "tst", "cbz", "cbnz", "tbz", "tbnz"].includes(mn)) {
			invalidate_dest(ops);
		}
		out.push(raw_line);
		i++;
	}

	return out.join("\n");
}
