import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import build from "../../src/build.ts";
import join from "../../src/join.ts";
import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";

const RECORD_PREFIX = "\\nomen|";

// A discovered test function: `pub func <name> = (ref Tester t)`.
export interface TestFunction {
	name: string;
}

// A discovered benchmark: `pub func <name> = (ref Tester t)` whose body calls
// `t.bench(label, fn)` (or `t.bench_n(...)`). `fn` is the function the harness
// must time.
export interface BenchFunction {
	name: string;
	// The function reference passed to `t.bench`/`t.bench_n`, e.g. `add_once`.
	target: string;
	// The label string passed to `t.bench`.
	label: string;
	// Explicit sample count from `bench_n`, or undefined for the default.
	samples?: number;
}

export interface TestFileResult {
	file: string;
	ok: boolean;
	tests: TestRecord[];
	fails: FailRecord[];
	benches: BenchRecord[];
	other: string[];
	// Set when the compiled binary crashed before finishing (e.g. a segfault
	// in a test). We still surface whatever records it managed to emit.
	crashed?: string;
	ms: number;
}

interface TestRecord {
	name: string;
	passed: number;
	failed: number;
	ns: number;
}

interface FailRecord {
	test: string;
	message: string;
}

interface BenchRecord {
	label: string;
	n: number;
	min: number;
	median: number;
	max: number;
	mean: number;
	stddev: number;
}

/** Recursively collect `*.test.nm` files under `root`, skipping build output. */
export function collect_test_files(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "build" || entry.name === "node_modules") continue;
				walk(full);
			} else if (entry.name.endsWith(".test.nm")) {
				out.push(full);
			}
		}
	};
	walk(root);
	return out;
}

/** Pull `pub func <name> = (ref Tester t)` declarations out of source text. */
export function extract_test_functions(source: string): TestFunction[] {
	const tests: TestFunction[] = [];
	// `pub func NAME = (ref Tester t)`  — Tester may be passed by value too,
	// but `ref` is required for mutation, so accept either.
	const re = /pub\s+func\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\(\s*(?:ref\s+)?Tester\s+t\s*\)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(source))) {
		tests.push({ name: m[1] });
	}
	return tests;
}

/**
 * Find benchmark functions: test functions whose body calls `t.bench(...)` or
 * `t.bench_n(...)`. Returns the target function (the thing to time) and label.
 */
export function extract_bench_functions(source: string): BenchFunction[] {
	const benches: BenchFunction[] = [];
	const testRe = /pub\s+func\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\(\s*(?:ref\s+)?Tester\s+t\s*\)/g;
	let m: RegExpExecArray | null;
	while ((m = testRe.exec(source))) {
		const name = m[1];
		const bodyStart = testRe.lastIndex;
		// Find the matching closing brace by counting depth.
		let depth = 0;
		let i = bodyStart;
		let inStr: string | null = null;
		let escaped = false;
		for (; i < source.length; i++) {
			const ch = source[i];
			if (inStr) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === inStr) inStr = null;
				continue;
			}
			if (ch === '"' || ch === "'") inStr = ch;
			else if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) break;
			}
		}
		const body = source.slice(bodyStart, i);
		// `t.bench("label", fn)` or `t.bench_n("label", fn, 123)`
		const benchRe =
			/\bt\.bench(?:_n)?\s*\(\s*"([^"]*)"\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,\s*(\d+)\s*)?\)/;
		const bm = body.match(benchRe);
		if (bm) {
			benches.push({
				name,
				label: bm[1],
				target: bm[2],
				samples: bm[3] ? parseInt(bm[3], 10) : undefined,
			});
		}
	}
	return benches;
}

function escape_nm_string(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Build the `main` + per-benchmark timing harness for one test file. */
export function generate_harness(tests: TestFunction[], benches: BenchFunction[]): string {
	// A function that is also a benchmark must not run twice — exclude bench
	// functions from the plain test list (they're driven by the bench loop).
	const benchNames = new Set(benches.map((b) => b.name));
	tests = tests.filter((t) => !benchNames.has(t.name));

	const templatePath = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"src",
		"bench_loop.nm",
	);
	const template = fs.readFileSync(templatePath, "utf8");

	const benchLoops = benches
		.map((b) => {
			// Clamp the sample count: insertion-sorting the results is O(n²),
			// so an absurd `bench_n` would dominate the suite. 4096 keeps the
			// sort bounded while leaving plenty of samples for stable stats.
			const raw = b.samples && b.samples > 0 ? b.samples : 1000;
			const n = Math.min(raw, 4096);
			return template
				.replace(/__NAME__/g, b.name)
				.replace(/__TARGET__/g, b.target)
				.replace(/__N__/g, String(n));
		})
		.join("\n");

	let main = "\nimport System\nimport System/Test\n\npub func main = () {\n";
	main += "\tvar Tester t = Tester()\n";
	for (const test of tests) {
		main += `\tt.begin_test("${escape_nm_string(test.name)}")\n`;
		main += `\t${test.name}(ref t)\n`;
		main += `\tt.end_test()\n`;
	}
	for (const bench of benches) {
		// Bench functions run after every test, so reset the per-test failure
		// flag (otherwise a prior test's failure would make `t.bench` a no-op)
		// and any leftover `bench_pending` from an earlier bench.
		main += `\tt.has_failed = false\n`;
		main += `\tt.bench_pending = false\n`;
		main += `\t${bench.name}(ref t)\n`;
		main += `\tif t.bench_pending {\n`;
		main += `\t\tbench_loop_${bench.name}(ref t)\n`;
		main += `\t}\n`;
	}
	main += "}\n";
	return benchLoops + main;
}

interface RunRecord {
	tests: TestRecord[];
	fails: FailRecord[];
	benches: BenchRecord[];
	other: string[];
}

/** Parse the machine-readable records out of a test binary's stdout. */
export function parse_records(stdout: string): RunRecord {
	const tests: TestRecord[] = [];
	const fails: FailRecord[] = [];
	const benches: BenchRecord[] = [];
	const other: string[] = [];
	for (const line of stdout.split("\n")) {
		if (!line.startsWith(RECORD_PREFIX)) {
			if (line.length) other.push(line);
			continue;
		}
		const parts = line.slice(RECORD_PREFIX.length).split("|");
		const kind = parts[0];
		if (kind === "start") {
			// no-op; the `done` record carries the result
		} else if (kind === "done") {
			tests.push({
				name: parts[1],
				passed: parseInt(parts[2] || "0", 10),
				failed: parseInt(parts[3] || "0", 10),
				ns: parseInt(parts[4] || "0", 10),
			});
		} else if (kind === "fail") {
			fails.push({ test: parts[1], message: parts.slice(2).join("|") });
		} else if (kind === "bench") {
			benches.push({
				label: parts[1],
				n: parseInt(parts[2] || "0", 10),
				min: parseInt(parts[3] || "0", 10),
				median: parseInt(parts[4] || "0", 10),
				max: parseInt(parts[5] || "0", 10),
				mean: parseFloat(parts[6] || "0"),
				stddev: parseFloat(parts[7] || "0"),
			});
		}
	}
	return { tests, fails, benches, other };
}

/**
 * Compile one `*.test.nm` file (with the generated harness) and run it,
 * returning its parsed records and any crash info.
 */
export function run_test_file(
	entry_path: string,
	lib_path: string | undefined,
	arch: string,
): TestFileResult {
	const start = performance.now();
	const source_text = fs.readFileSync(entry_path, "utf8");
	const tests = extract_test_functions(source_text);
	const benches = extract_bench_functions(source_text);
	const harness = generate_harness(tests, benches);

	const result: TestFileResult = {
		file: entry_path,
		ok: true,
		tests: [],
		fails: [],
		benches: [],
		other: [],
		ms: 0,
	};

	const resolved = path.resolve(entry_path);
	const input = join(resolved, lib_path);
	const library = lib_path ? get_library(lib_path) : undefined;
	// `harness` carries `import System`, so `parse` will resolve the library
	// types (Tester, Buffer, Time, Math) and append them. The user source is
	// already concatenated into `input` via `join`, which strips its `import`
	// lines — `harness` re-supplies it so library resolution still triggers.
	const source = input + "\n" + harness;
	const parsed = parse(source, library, resolved);
	if (parsed.errors.length) {
		result.ok = false;
		result.crashed = parsed.errors
			.map((e) => `${e.message} (${e.line ?? "?"}:${e.column ?? "?"})`)
			.join("\n");
		result.ms = performance.now() - start;
		return result;
	}

	const buildResult = build(parsed.root, { arch: arch as "aarch64" | "c", audit: false });
	if (buildResult.errors && buildResult.errors.length) {
		result.ok = false;
		result.crashed = buildResult.errors
			.map((e) => `${e.message} (${e.line ?? "?"}:${e.column ?? "?"})`)
			.join("\n");
		result.ms = performance.now() - start;
		return result;
	}

	const buildDir = path.join(path.dirname(resolved), "build");
	if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });
	const ext = arch === "aarch64" ? ".s" : ".c";
	const codefile = path.join(buildDir, path.basename(entry_path, ".nm") + ext);
	const outfile = path.join(buildDir, path.basename(entry_path, ".nm"));
	// The C backend's generated source does `#include "main.h"`, so write the
	// header next to the code. (aarch64 inlines everything into the .s file.)
	fs.writeFileSync(path.join(buildDir, "main.h"), buildResult.headers ?? "");
	fs.writeFileSync(codefile, buildResult.code);

	// Link the harness binary. The harness uses only Console/Time (printf,
	// clock_gettime), so no platform frameworks are required.
	try {
		execFileSync("clang", ["-o", outfile, codefile], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err: any) {
		const stderr = err.stderr ? err.stderr.toString() : (err.message ?? "");
		result.ok = false;
		result.crashed = `link failed: ${stderr.trim() || "clang error"}`;
		result.ms = performance.now() - start;
		return result;
	}

	// Run the binary and collect the records it streams over stdout. A
	// non-zero exit (crash, abort) still surfaces whatever records were
	// emitted before the crash; a timeout is treated as a crash.
	let runStdout = "";
	let crashed: string | undefined;
	try {
		runStdout = execFileSync(outfile, [], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
			maxBuffer: 16 * 1024 * 1024,
		});
	} catch (err: any) {
		runStdout = err.stdout ? err.stdout.toString() : "";
		if (err.signal === "SIGTERM") {
			crashed = "test binary timed out after 30s";
		} else {
			crashed = `test binary exited abnormally (signal ${err.signal ?? err.code})`;
		}
	}

	const records = parse_records(runStdout);
	result.tests = records.tests;
	result.fails = records.fails;
	result.benches = records.benches;
	result.other = records.other;
	result.crashed = crashed;
	// A file "passes" when it reported no failed asserts and didn't crash.
	const failed = result.fails.length > 0 || result.tests.some((t) => t.failed > 0);
	result.ok = !failed && crashed === undefined;

	result.ms = performance.now() - start;
	return result;
}

// Format a millisecond duration (as returned by `performance.now()` deltas)
// as a compact human-readable string.
function format_duration(ms: number): string {
	if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
	if (ms < 1000) return `${ms.toFixed(0)}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

function fmt_ns(ns: number): string {
	if (ns < 1000) return `${ns}ns`;
	if (ns < 1e6) return `${(ns / 1000).toFixed(1)}µs`;
	if (ns < 1e9) return `${(ns / 1e6).toFixed(1)}ms`;
	return `${(ns / 1e9).toFixed(2)}s`;
}

const C = {
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	red: (s: string) => `\x1b[31m${s}\x1b[0m`,
	dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
	yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
	cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

/** Print a vitest-style report for one file's results. */
export function report_file(result: TestFileResult): void {
	const rel = path.relative(process.cwd(), result.file);
	if (result.crashed && result.tests.length === 0 && result.fails.length === 0) {
		console.log(` ${C.red("✗")} ${rel} ${C.red("(failed to build)")}`);
		console.log(C.red(result.crashed));
		return;
	}
	const totalTests = result.tests.length;
	const mark = result.ok ? C.green("✓") : C.red("✗");
	console.log(
		` ${mark} ${rel} ${C.dim(`(${totalTests} tests)`)} ${C.dim(format_duration(result.ms))}`,
	);
	if (result.crashed) {
		console.log(C.red(`   ${result.crashed}`));
	}
	// Each `fail` record already names its test and carries the message; with
	// short-circuiting a test has at most one failure, so the fail lines are
	// the per-test detail and a separate count line would just repeat names.
	for (const f of result.fails) {
		console.log(`   ${C.red("✗")} ${C.bold(f.test)} ${C.dim(">")} ${f.message}`);
	}
	for (const b of result.benches) {
		console.log(
			`   ${C.cyan("⏱")} ${C.bold(b.label)} ${C.dim(`(n=${b.n})`)} ` +
				`${C.dim("min")} ${fmt_ns(b.min)} ${C.dim("median")} ${fmt_ns(b.median)} ` +
				`${C.dim("mean")} ${fmt_ns(Math.round(b.mean))} ${C.dim("max")} ${fmt_ns(b.max)} ` +
				`${C.dim("±")} ${fmt_ns(Math.round(b.stddev))}`,
		);
	}
	if (result.other.length) {
		console.log(C.dim("   --- test stdout ---"));
		for (const line of result.other) console.log(C.dim(`   ${line}`));
	}
}

export interface RunTestsOptions {
	arch?: string;
	filter?: RegExp;
}

/** Discover, run, and report every `*.test.nm` under `root`. */
export function runTests(root: string, options: RunTestsOptions = {}): boolean {
	const arch = options.arch ?? "aarch64";
	const lib = resolve_lib_for(root);
	const files = collect_test_files(root).filter((f) => !options.filter || options.filter.test(f));

	console.log(`\n~ NOMEN TEST ~ ${files.length} file(s)\n`);
	const startTime = performance.now();

	const results: TestFileResult[] = [];
	for (const file of files) {
		const result = run_test_file(file, lib, arch);
		report_file(result);
		results.push(result);
	}

	const elapsed = performance.now() - startTime;
	const totalFiles = results.length;
	// `tests[].failed` (from each test's `done` record) is the authoritative
	// failure count; `result.fails` holds the same failures' messages for
	// display, so don't sum both or failures are double-counted.
	const totalTests = results.reduce((a, r) => a + r.tests.length, 0);
	const totalFailed = results.reduce((a, r) => a + r.tests.reduce((x, t) => x + t.failed, 0), 0);
	const totalPassed = totalTests - totalFailed;
	const anyFailed = results.some((r) => !r.ok);

	console.log("");
	console.log(
		` ${C.bold("Files ")} ${totalFiles} ${anyFailed ? C.red("failed") : C.green("passed")} (${totalFiles})`,
	);
	console.log(
		` ${C.bold("Tests ")} ${totalPassed} ${C.green("passed")}` +
			(totalFailed ? ` | ${C.red(`${totalFailed} failed`)}` : "") +
			` (${totalTests})`,
	);
	console.log(` ${C.bold("Time  ")} ${format_duration(elapsed)}`);
	console.log("");

	return !anyFailed;
}

// Find the System library for a test run rooted at `root`. Mirrors the CLI's
// resolve_lib but also checks the repo's `core/System` layout directly.
function resolve_lib_for(root: string): string | undefined {
	let dir = path.resolve(root);
	// Climb to the filesystem root looking for the System library.
	for (;;) {
		const candidates = [
			path.join(dir, "core", "System", "package.jsonc"),
			path.join(dir, "core", "package.jsonc"),
			path.join(dir, "package.jsonc"),
		];
		for (const c of candidates) {
			if (fs.existsSync(c)) {
				try {
					const json = fs
						.readFileSync(c, "utf8")
						.replace(/\/\/.*$/gm, "")
						.replace(/\/\*[\s\S]*?\*\//g, "");
					const parsed = JSON.parse(json);
					// Return the package directory (where this package.jsonc
					// lives). `get_library` reads package.jsonc from here and
					// finds sources under `<dir>/src` (a symlink to `System`
					// in this repo); resolving `imports.System` to a subdir
					// would point at the source folder instead, which
					// `get_library` cannot use.
					if (parsed.imports?.System) {
						return path.dirname(c);
					}
					if (fs.existsSync(path.join(path.dirname(c), "System"))) {
						return path.dirname(c);
					}
				} catch {
					// ignore
				}
			}
		}
		const systemDir = path.join(dir, "System");
		if (fs.existsSync(systemDir)) return systemDir;
		const globalSystem = path.join(dir, "core", "System");
		if (fs.existsSync(globalSystem)) {
			return path.join(dir, "core");
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}
