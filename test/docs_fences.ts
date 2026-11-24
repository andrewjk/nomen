import fs from "node:fs";
import path from "node:path";

import { test } from "vite-plus/test";

import { compile_main, compile_module } from "./spec/_helpers.ts";

/**
 * Doc-fence conformance: the fenced examples in README.md / SPEC.md ARE the
 * test inputs. Every block that is not marked as an error example must
 * compile — either as written, wrapped as `main` statements, or with the
 * snippets that precede it under the same heading (the docs' examples build
 * on each other). Error examples (`// Error:` comments) stay hand-written in
 * the feature suites, where their exact diagnostics are asserted.
 *
 * A doc change that breaks an example therefore fails CI here, with the
 * file:line and heading — instead of silently drifting from the mirrored
 * feature suites.
 */

export interface DocFence {
	/** `<doc>|<heading trail>|<index within heading>` — the stable table key. */
	key: string;
	file: string;
	heading: string[];
	index: number;
	line: number;
	code: string;
}

interface HeadingBlock {
	heading: string[];
	fences: DocFence[];
}

const ERROR_MARK = /\/\/[^\n]*Error:|\/\/[^\n]*error:/;

/**
 * Snippets that are not standalone examples: library-only demos, display
 * fragments, and examples that need a file/assets on disk. Each entry records
 * WHY, so the allowance stays visible and reviewable.
 */
const SKIP: Record<string, string> = {
	// README — the `foreign func` half is System-library code (the user-side
	// block next to it is a real, compiled example).
	"README.md|The Nomen Programming Language > Language Overview > FFI|0":
		"library-only: foreign declarations are System-library-only",
	// SPEC — display/asset/library-only blocks.
	"SPEC.md|Nomen Language Specification > Types > Reference Types|0":
		"display: type-spelling list, not a program",
	"SPEC.md|Nomen Language Specification > Statements > Return|0":
		"display: bare `return value` fragment",
	"SPEC.md|Nomen Language Specification > Expressions > Compile-time Embedding|0":
		"needs an assets/banner.txt on disk",
	"SPEC.md|Nomen Language Specification > Declarations > Functions > Foreign Functions|0":
		"library-only: foreign declarations are System-library-only",
	"SPEC.md|Nomen Language Specification > Unsafe Code|1":
		"library-only: unsafe is reserved for the System library",
	"SPEC.md|Nomen Language Specification > Compile-Time Conditionals > Compile-Time Errors (`#error`)|1":
		"intentional #error example (always fails)",
	"SPEC.md|Nomen Language Specification > Compile-Time Conditionals > Compile-Time Errors (`#error`)|2":
		"intentional #error example (always fails)",
	"SPEC.md|Nomen Language Specification > Concurrency > Nursery (escape hatch)|2":
		"display: `async nursery { … }` name-menu placeholder",
	"SPEC.md|Nomen Language Specification > Concurrency > The Task Handle|0":
		"display: body-less method signature listing",
};

/**
 * Context a snippet assumes but does not show: a variable the surrounding
 * prose introduces, or declarations from an earlier section. The text is
 * prepended to the compiled unit; the block itself stays the doc's own.
 */
const CONTEXT: Record<string, string> = {
	"README.md|The Nomen Programming Language > Language Overview > Strings|0": `const name = "Alice"
var age = 30`,
	"README.md|The Nomen Programming Language > Language Overview > Pattern Matching|0": `enum Shape {
    case circle(int radius)
    case rect(int width, int height)
}

const shape = Shape.rect(10, 20)`,
	"SPEC.md|Nomen Language Specification > Errors > The `!!` Result Coalesce|0": `error FetchError {
    case notfound
}

func fetch = (string url, out int ! FetchError) {
    if url == "" {
        return .notfound
    }
    return 7
}`,
	"SPEC.md|Nomen Language Specification > Errors > Postfix `!` — Propagate|0": `error FetchError {
    case notfound
}`,
	"SPEC.md|Nomen Language Specification > Errors > Handling the Error Side: `try / catch`|2": `error LoadError {
    case timeout
    case offline
}

error ParseError {
    case syntax
    case corrupt
}

func load = (string path, out int ! LoadError, ParseError) {
    if path == "/slow" {
        return .timeout
    }
    if path == "/bad" {
        return .syntax
    }
    return 7
}`,
	"SPEC.md|Nomen Language Specification > Declarations > Match, Switch and If as Expressions|0":
		"var x = 5",
	"SPEC.md|Nomen Language Specification > Declarations > Match, Switch and If as Expressions|1":
		"var x = 5",
	"SPEC.md|Nomen Language Specification > Declarations > Match, Switch and If as Expressions|2":
		"var ok = true",
	"SPEC.md|Nomen Language Specification > Statements > If/Else|0": "var x = 5",
	"SPEC.md|Nomen Language Specification > Statements > If/Else|1": "var x = 5",
	"SPEC.md|Nomen Language Specification > Statements > If/Else|2": "var x = 5",
	"SPEC.md|Nomen Language Specification > Statements > If Expression (with `->` return syntax)|0":
		"var condition = true",
	"SPEC.md|Nomen Language Specification > Statements > Match Statement|0": "var x = 1",
	"SPEC.md|Nomen Language Specification > Statements > Match Statement|2": "var flag = true",
	"SPEC.md|Nomen Language Specification > Statements > Switch Statement|0": "var x = 1",
	"SPEC.md|Nomen Language Specification > Statements > While Loop|0": "var x = 0",
	"SPEC.md|Nomen Language Specification > Statements > For Loop|2": `struct Point {
    var int x
    var int y
}`,
	"SPEC.md|Nomen Language Specification > Statements > For Loop|3": "const int[] items = [1, 2, 3]",
	"SPEC.md|Nomen Language Specification > Statements > Let and Arrow Shorthand|0": "var x = 1",
	"SPEC.md|Nomen Language Specification > Expressions > String Operations|0":
		'const name = "World"',
	"SPEC.md|Nomen Language Specification > Expressions > String Interpolation|0": `const name = "Alice"
const age = 30`,
	"SPEC.md|Nomen Language Specification > Expressions > Field Access|0": `struct Point {
    var int x
    var int y
}`,
	"SPEC.md|Nomen Language Specification > Expressions > Method Calls|0": `struct Point {
    var int x
    var int y

    func add = (self, Point other, out Point) {
        return Point(self.x + other.x, self.y + other.y)
    }
}

const point = Point(5, 10)
const other = Point(1, 2)`,
	"SPEC.md|Nomen Language Specification > Compile-Time Conditionals > Type-Body Loops and Generated Names (`#` splices)|0": `struct Base {
    var width = 0
}`,
	"SPEC.md|Nomen Language Specification > Standard Library > Task|0": `func compute = (uint64 n, out uint64) {
    return n + 1
}`,
	"SPEC.md|Nomen Language Specification > Standard Library > Task|1": `func compute = (uint64 n, out uint64) {
    return n + 1
}`,
	"SPEC.md|Nomen Language Specification > Concurrency > Thread|3": `func fetch = (uint64 id) {
    Console.write_line("fetching \\{id}")
}`,
	"SPEC.md|Nomen Language Specification > Concurrency > async block (nursery)|1": `func long_running = (uint64 n) {
    Console.write_line("long")
}`,
	"SPEC.md|Nomen Language Specification > Concurrency > async block (nursery)|2": `const key = 1

func fetch_from_cache = (int k, out int) {
    return k
}

func fetch_from_db = (int k, out int) {
    return k
}`,
	"SPEC.md|Nomen Language Specification > Concurrency > Nursery (escape hatch)|0": `const conn = 1

func parse = (uint64 conn) {
    Console.write_line("\\{conn}")
}

func respond = (uint64 conn) {
    Console.write_line("\\{conn}")
}`,
	"SPEC.md|Nomen Language Specification > Concurrency > Nursery (escape hatch)|3": `const key = 1

func fetch_from_cache = (int k, out int) {
    return k
}

func fetch_from_db = (int k, out int) {
    return k
}`,
};

/** Extract fenced blocks with their heading trail and per-heading index. */
function extract_fences(file: string, lang: string): DocFence[] {
	const source = fs.readFileSync(path.resolve(import.meta.dirname, "..", file), "utf8");
	const lines = source.split("\n");
	const fences: DocFence[] = [];
	const headings: string[] = [];
	const seen = new Map<string, number>();
	let in_fence = false;
	let fence_lang = "";
	let code: string[] = [];
	let start = 0;
	let fence_heading: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (!in_fence && heading) {
			const level = heading[1].length;
			headings.length = level - 1;
			headings[level - 1] = heading[2].trim();
			continue;
		}
		const fence = /^```(.*)$/.exec(line);
		if (fence) {
			if (!in_fence) {
				in_fence = true;
				fence_lang = fence[1].trim();
				code = [];
				start = i + 1;
				fence_heading = headings.slice();
			} else {
				in_fence = false;
				if (fence_lang !== lang) continue;
				const trail = fence_heading.join(" > ");
				const index = seen.get(trail) ?? 0;
				seen.set(trail, index + 1);
				fences.push({
					key: `${file}|${trail}|${index}`,
					file,
					heading: fence_heading,
					index,
					line: start,
					code: code.join("\n"),
				});
			}
			continue;
		}
		if (in_fence) code.push(line);
	}
	return fences;
}

/** Compile one fence (with its context and same-heading predecessors). */
function fence_errors(
	fence: DocFence,
	predecessors: string[],
): { errors: { message?: string }[] } | undefined {
	const context = CONTEXT[fence.key] ?? "";
	const body = context ? `${context}\n${fence.code}` : fence.code;
	const attempts = [
		() => compile_module(body),
		() => compile_main(body),
		() => compile_module(`${context}\n${predecessors.join("\n")}\n${fence.code}`),
		() => compile_main(`${context}\n${predecessors.join("\n")}\n${fence.code}`),
	];
	for (const attempt of attempts) {
		const errors = attempt();
		if (errors.length === 0) return undefined;
	}
	return { errors: compile_module(body) };
}

/**
 * Register one test per heading section: every non-error fence under that
 * heading must compile. A failure names the file, line, heading, the first
 * diagnostic, and the offending block.
 */
export function doc_fence_suite(file: string, lang: string): void {
	const fences = extract_fences(file, lang);
	const sections: HeadingBlock[] = [];
	const by_trail = new Map<string, HeadingBlock>();
	for (const fence of fences) {
		if (ERROR_MARK.test(fence.code)) continue; // covered by feature suites
		if (SKIP[fence.key]) continue;
		const trail = fence.heading.join(" > ");
		let section = by_trail.get(trail);
		if (!section) {
			section = { heading: fence.heading, fences: [] };
			by_trail.set(trail, section);
			sections.push(section);
		}
		section.fences.push(fence);
	}

	for (const section of sections) {
		const title = section.heading.filter(Boolean).slice(-2).join(" > ");
		test(`${file} — ${title}`, () => {
			for (let i = 0; i < section.fences.length; i++) {
				const fence = section.fences[i];
				const predecessors = section.fences.slice(0, i).map((f) => f.code);
				const result = fence_errors(fence, predecessors);
				if (result) {
					const first = result.errors[0]?.message ?? "compile failed";
					throw new Error(
						`${fence.file}:${fence.line} [${section.heading.filter(Boolean).join(" > ")}]\n` +
							`${first}\n--- block ---\n${fence.code}`,
					);
				}
			}
		});
	}
}
