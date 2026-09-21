import type BuildStatus from "../../build_c/BuildStatus.ts";

/**
 * Chunked code buffer for the aarch64 emitter.
 *
 * The emitter appends assembly at per-instruction frequency and used to
 * guard line breaks with `status.code.endsWith("\n")` peeks. Every peek
 * forced V8 to flatten the accumulated code rope — an O(code) copy at
 * instruction frequency, which made builds quadratic in time and memory
 * (the C-emitter quadratic fix does not port: aarch64 has no scratch
 * capture sites, only newline guards).
 *
 * This module replaces both halves of the disease:
 *
 * - `emit_asm(status, s)` appends `s` to a chunk list with O(1) cost and
 *   tracks whether the buffer's tail ends with a newline.
 * - `ensure_newline(status)` answers the guard from the tracked flag —
 *   never peeking the accumulated text — and appends only when needed.
 * - `asm_code_len(status)` is an O(1) length for the mid-body markers
 *   (raw-reload entry points, access-staging windows, SLP pair rollback)
 *   that used to read `status.code.length` and would otherwise force a
 *   materialize per statement.
 * - `install_asm_code_buffer(status)` redefines `status.code` as an
 *   accessor over the chunk list: reads materialize (join once, cached in
 *   `state.flat`), writes reset the chunks. Raw `status.code +=` sites mix
 *   safely — they simply materialize first — so conversion is incremental
 *   and behavior is byte-identical.
 *
 * `status.code = ""` at function-entry redirects (and the exit restores)
 * go through the setter, so each function body accumulates its own chunk
 * window; the per-function peephole/placeholder passes materialize it
 * exactly once.
 */

export interface AsmCodeState {
	/** Pending chunks. `null` = `flat` is the authoritative (materialized) text. */
	chunks: string[] | null;
	/** The materialized code. Only guaranteed current when `chunks` is null. */
	flat: string;
	/** Whether the buffer's tail ends with "\n". `undefined` = unknown (the
	 *  last write was a setter assignment too large to scan cheaply). */
	ends_nl: boolean | undefined;
	/** Total length across `flat`/`chunks`. */
	len: number;
}

/** Setter inputs at or below this size are tail-scanned eagerly; larger
 *  ones leave the flag unknown for a one-time materialized peek. */
const EAGER_TAIL_LIMIT = 4096;

/**
 * Convert `status.code` into the chunked buffer. Called once per build,
 * before the aarch64 root build. The C backend never installs it and is
 * unaffected.
 */
export function install_asm_code_buffer(status: BuildStatus): void {
	const state: AsmCodeState = {
		chunks: null,
		flat: status.code,
		ends_nl: status.code.length <= EAGER_TAIL_LIMIT ? status.code.endsWith("\n") : undefined,
		len: status.code.length,
	};
	status.asm_code_state = state;
	Object.defineProperty(status, "code", {
		configurable: true,
		enumerable: true,
		get(): string {
			if (state.chunks) {
				state.flat = state.chunks.join("");
				state.chunks = null;
			}
			return state.flat;
		},
		set(v: string): void {
			state.flat = v;
			state.chunks = null;
			state.len = v.length;
			state.ends_nl = v.length <= EAGER_TAIL_LIMIT ? v.endsWith("\n") : undefined;
		},
	});
}

function state_of(status: BuildStatus): AsmCodeState | undefined {
	return status.asm_code_state;
}

/** Append `s` to the emitted code. O(1) (chunk push) with tail tracking. */
export function emit_asm(status: BuildStatus, s: string): void {
	const state = state_of(status);
	if (!state) {
		status.code += s;
		return;
	}
	if (s.length === 0) return;
	if (!state.chunks) state.chunks = [state.flat];
	state.chunks.push(s);
	state.len += s.length;
	state.ends_nl = s.endsWith("\n");
}

/** The newline guard: append "\n" only when the code doesn't already end
 *  with one — answered from the tracked tail, never by peeking the whole
 *  buffer. */
export function ensure_newline(status: BuildStatus): void {
	const state = state_of(status);
	if (!state) {
		if (!status.code.endsWith("\n")) status.code += "\n";
		return;
	}
	if (state.ends_nl === undefined) {
		if (state.chunks) {
			state.flat = state.chunks.join("");
			state.chunks = null;
		}
		state.ends_nl = state.flat.endsWith("\n");
	}
	if (!state.ends_nl) emit_asm(status, "\n");
}

/** O(1) current code length (the mid-body markers' replacement for
 *  `status.code.length`, which would force a materialize per statement). */
export function asm_code_len(status: BuildStatus): number {
	const state = state_of(status);
	return state ? state.len : status.code.length;
}
