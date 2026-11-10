import fs from "node:fs";
import path from "node:path";

import { type ServerEndPoint } from "@torpor/build";

import build from "../../../../../src/build.ts";
import { get_library, type Library } from "../../../../../src/lib.ts";
import parse from "../../../../../src/parse.ts";

/**
 * Compiles one Nomen program for the REPL.
 *
 * The compiler runs on the server (it reads `core/` from disk); the response
 * is a self-contained browser script the client executes in a Worker. Only
 * compilation happens here — user code never runs on this host.
 */

interface ReplError {
	message: string;
	line: number;
	column: number;
}

/** Locate the System library: `NOMEN_CORE`, or the nearest `core/` above the
 *  working directory (the site runs from `site/`, so that is the repo root).
 *  The built server's own directory is searched too, for hosts that start it
 *  from somewhere else. */
function find_core(): string {
	const override = process.env.NOMEN_CORE;
	if (override) return path.resolve(override);
	for (const start of [process.cwd(), import.meta.dirname]) {
		let dir = start;
		for (let i = 0; i < 10; i++) {
			const candidate = path.join(dir, "core");
			if (fs.existsSync(path.join(candidate, "package.jsonc"))) return candidate;
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	throw new Error("Could not find the Nomen System library (set NOMEN_CORE)");
}

function library(): Library {
	return get_library(find_core());
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** Shift checker positions onto the user's editor: the REPL prepends a line
 *  and blanks `import` lines (keeping their newlines) for the library. */
function to_errors(errors: { message: string; line?: number; column?: number }[]): ReplError[] {
	return errors.map((error) => ({
		message: error.message,
		line: Math.max(1, (error.line ?? 2) - 1),
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
		// not be a file-read primitive.
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
		// the editor.
		const blanked = source.replace(/^(\s*)import\b.*$/gm, (line) => " ".repeat(line.length));
		const program = `import System\n${blanked}`;

		try {
			const parsed = parse(program, library());
			if (parsed.errors.length > 0) {
				return json({ ok: false, errors: to_errors(parsed.errors), warnings: [] });
			}
			const result = build(parsed.root, { arch: "js", js_target: "browser" });
			if (result.errors && result.errors.length > 0) {
				return json({ ok: false, errors: to_errors(result.errors), warnings: [] });
			}
			return json({
				ok: true,
				js: result.code,
				warnings: to_errors(parsed.warnings ?? []),
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
