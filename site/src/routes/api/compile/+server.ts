import type { ServerEndPoint } from "@torpor/build";

import build_js from "../../../../../src/build_js/build_js.ts";
import parse from "../../../../../src/parse.ts";
import { core_library } from "../../../lib/core.ts";

/**
 * Compiles one Nomen program for the REPL.
 *
 * The System library is embedded at build time (`scripts/bundle-core.ts`), so
 * the compiler runs in a Cloudflare Worker with no filesystem access. The
 * response is a self-contained browser script the client executes in a Worker;
 * user code never runs on the server.
 */

interface ReplError {
	message: string;
	line: number;
	column: number;
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** Shift checker positions onto the user's editor: the REPL prepends the
 *  System import (and, for bare statements, a `main` wrapper), so diagnostics
 *  move down by the number of synthetic lines. */
function to_errors(
	errors: { message: string; line?: number; column?: number }[],
	line_offset: number,
): ReplError[] {
	return errors.map((error) => ({
		message: error.message,
		line: Math.max(1, (error.line ?? line_offset + 1) - line_offset),
		column: Math.max(1, error.column ?? 1),
	}));
}

const MAX_SOURCE = 200_000;

export default {
	post: async (event) => {
		let source: string;
		try {
			const body = (await event.json()) as { source?: unknown };
			source = typeof body?.source === "string" ? body.source : "";
		} catch {
			return json(
				{ ok: false, errors: [{ message: "Malformed request", line: 1, column: 1 }] },
				400,
			);
		}
		if (source.length > MAX_SOURCE) {
			return json(
				{ ok: false, errors: [{ message: "Program is too large", line: 1, column: 1 }] },
				413,
			);
		}

		// `#embed_file` reads a server file at compile time; a public REPL must
		// not be a file-read primitive (and the Worker has no filesystem).
		if (/#\s*embed_file\b/.test(source)) {
			return json({
				ok: false,
				errors: [
					{
						message: "#embed_file is not available in the REPL",
						line: 1,
						column: 1,
					},
				],
				warnings: [],
			});
		}

		// The REPL always has the System library available, and imports are
		// blanked rather than removed so diagnostic line numbers keep matching
		// the editor. Bare statements (the common REPL shape) are wrapped in a
		// `main`; a program that declares its own is used as-is.
		const body = source.replace(/^(\s*)import\b.*$/gm, (line) => " ".repeat(line.length));
		const has_main = /^\s*(?:(?:pub|private|internal|export)\s+)*func\s+main\b/m.test(body);
		const user = has_main ? body : `pub func main = () {\n${body}\n}\n`;
		const line_offset = has_main ? 1 : 2;
		const program = `import System\n${user}`;

		try {
			const parsed = parse(program, core_library());
			if (parsed.errors.length > 0) {
				return json({ ok: false, errors: to_errors(parsed.errors, line_offset), warnings: [] });
			}
			const result = build_js(parsed.root, { target: "browser" });
			if (result.errors && result.errors.length > 0) {
				return json({ ok: false, errors: to_errors(result.errors, line_offset), warnings: [] });
			}
			return json({
				ok: true,
				js: result.code,
				warnings: to_errors(parsed.warnings ?? [], line_offset),
			});
		} catch (error) {
			return json({
				ok: false,
				errors: [
					{
						message: String((error as Error)?.message ?? error),
						line: 1,
						column: 1,
					},
				],
				warnings: [],
			});
		}
	},
} satisfies ServerEndPoint;
