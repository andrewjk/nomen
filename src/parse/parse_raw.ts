import add_error from "../add_error.ts";
import RawNode from "../nodes/RawNode.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

/**
 * `#raw` / `#raw("c")` / `#raw(…, "file")` — a raw code block (C source or
 * assembly spliced verbatim, bypassing Nomen codegen).
 *
 * The TOKENIZER has already isolated the body: `#`, `raw`, the optional
 * argument tokens, `{`, a `raw` marker + the body as one token, and `}`.
 * This parser consumes them, validates the arguments, and builds the node.
 *
 * Target selection is NOT here — it is the ordinary `#if META.arch` fold
 * (docs/COMPTIME_PLAN_2.md stage 5): a raw block is wrapped like any other
 * statement and only the surviving arm is checked. The opener carries the
 * block's own nature instead:
 *
 * - no argument: the target's default dialect (inline asm on aarch64, C on
 *   the C backend);
 * - `"c"`: companion-compiled C source (UI/AppKit/UIKit FFI is the only
 *   blessed use — see AGENTS.md);
 * - `"file"`: hoist to file scope instead of splicing at the statement.
 */
export default function parse_raw(status: ParseStatus) {
	const start = get_index(status);
	accept("#", status);
	accept("raw", status);
	// Lockdown: raw blocks are the library's own escape hatch — they splice
	// arbitrary C/asm into the translation unit, which subsumes everything
	// `unsafe` offers. Reserved for the System library source (the
	// compiler's own machinery tests opt out via `allow_user_raw`).
	if (!status.allow_user_raw && !is_library_region(status, start)) {
		add_error(
			status,
			`'raw' blocks are reserved for the System library — inline architecture code is not available to user code`,
			start,
		);
	}

	let is_c = false;
	let scope: "block" | "file" = "block";
	if (accept("(", status)) {
		const args: string[] = [];
		while (peek_current(status) !== ")" && status.i < status.tokens.length) {
			const token = consume(status);
			if (token === ",") continue;
			args.push(token);
		}
		expect(")", status);
		for (const arg of args) {
			if (arg === '"c"') {
				is_c = true;
			} else if (arg === '"file"') {
				scope = "file";
			} else if (arg === '"block"') {
				scope = "block";
			} else {
				add_error(
					status,
					`Unsupported #raw argument '${arg}' — expected "c" (companion-C source) and/or "file" (file scope)`,
					start,
				);
			}
		}
	}

	expect("{", status);
	// The tokenizer emits the `raw` marker immediately before the body token.
	accept("raw", status);
	const value = consume(status).trim().replaceAll(/^\s+/gm, "");
	expect("}", status);

	// Legacy in-band headers (`#c`, `#scope: file`, and the older target
	// tags) were replaced by the opener's arguments. Reject them loudly so a
	// half-migrated block can't silently become C/asm text in the wrong
	// dialect.
	for (const line of value.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#arch:") || trimmed.startsWith("#platform:")) {
			add_error(
				status,
				`raw blocks no longer take '#arch:' / '#platform:' tags — select the target with #if META.arch == "..." { #raw { ... } }`,
				start,
			);
			break;
		}
		if (trimmed === "#c" || trimmed.startsWith("#scope:")) {
			add_error(
				status,
				`raw block header lines are gone — spell the dialect/scope on the opener: #raw("c", "file") { ... }`,
				start,
			);
			break;
		}
		if (trimmed !== "") break;
	}

	const raw = new RawNode(start, value, is_c, scope);
	add_to_parent(raw, "Raw C", status);
}

/** Same boundary rule as `unsafe`: only the appended System library source
 *  (source offsets at or past the user source's end) may use raw blocks. */
function is_library_region(status: ParseStatus, offset: number): boolean {
	return status.unsafe_boundary !== undefined && offset >= status.unsafe_boundary;
}
