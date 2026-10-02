import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test, vi } from "vite-plus/test";

import {
	collect_test_files,
	extract_bench_functions,
	extract_leaks,
	extract_test_functions,
	generate_harness,
	parse_records,
	run_test_file,
	runTests,
} from "../cli/src/test.ts";

// ---------------------------------------------------------------------------
// collect_test_files
// ---------------------------------------------------------------------------

test("collect_test_files discovers *.test.nm recursively and sorts", () => {
	const files = collect_test_files("cli/test/fixtures");
	expect(files.length).toBe(3);
	expect(files[0].replace(/\\/g, "/")).toMatch(/calc\.test\.nm$/);
	expect(files[1].replace(/\\/g, "/")).toMatch(/fileio\.test\.nm$/);
	expect(files[2].replace(/\\/g, "/")).toMatch(/spawn\.test\.nm$/);
});

test("collect_test_files returns [] for a missing folder", () => {
	expect(collect_test_files("does/not/exist")).toEqual([]);
});

// ---------------------------------------------------------------------------
// extract_test_functions
// ---------------------------------------------------------------------------

test("extract_test_functions finds pub func (ref Tester t) declarations", () => {
	const src = `
		import System::Test
		func helper = () {}
		pub func test_add = (ref Tester t) { t.expect(true, "") }
		pub func test_sub = (Tester t) {}
		pub func not_a_test = (int x) {}
	`;
	const tests = extract_test_functions(src);
	expect(tests.map((t) => t.name).sort()).toEqual(["test_add", "test_sub"]);
});

test("extract_test_functions returns [] when there are none", () => {
	expect(extract_test_functions("pub func main = () {}")).toEqual([]);
});

// ---------------------------------------------------------------------------
// extract_bench_functions
// ---------------------------------------------------------------------------

test("extract_bench_functions captures label, target and default samples", () => {
	const src = `
		func add_once = () {}
		pub func bench_add = (ref Tester t) {
			t.bench("add", add_once)
		}
	`;
	const benches = extract_bench_functions(src);
	expect(benches).toHaveLength(1);
	expect(benches[0]).toEqual({
		name: "bench_add",
		label: "add",
		target: "add_once",
		samples: undefined,
	});
});

test("extract_bench_functions reads an explicit sample count from bench_n", () => {
	const src = `
		func step = () {}
		pub func bench_step = (ref Tester t) {
			t.bench_n("stepping", step, 42)
		}
	`;
	const benches = extract_bench_functions(src);
	expect(benches).toHaveLength(1);
	expect(benches[0]).toMatchObject({ label: "stepping", target: "step", samples: 42 });
});

test("extract_bench_functions ignores a plain test with no t.bench call", () => {
	const src = `
		pub func test_plain = (ref Tester t) { t.expect(true, "ok") }
	`;
	expect(extract_bench_functions(src)).toEqual([]);
});

// ---------------------------------------------------------------------------
// generate_harness
// ---------------------------------------------------------------------------

test("generate_harness leaves no unsubstituted placeholders", () => {
	const tests = [{ name: "test_a" }];
	const benches = [{ name: "bench_a", label: "a", target: "run_a", samples: undefined }];
	const harness = generate_harness(tests as any, benches as any);
	expect(harness).not.toContain("__NAME__");
	expect(harness).not.toContain("__TARGET__");
	expect(harness).not.toContain("__N__");
});

test("generate_harness wires each test through begin/end_test", () => {
	const harness = generate_harness([{ name: "test_thing" } as any], []);
	expect(harness).toContain('t.begin_test("test_thing")');
	expect(harness).toContain("test_thing(ref t)");
	expect(harness).toContain("t.end_test()");
});

test("generate_harness names the bench loop bench_loop_<name> and calls the target", () => {
	const harness = generate_harness(
		[],
		[{ name: "bench_add", label: "add", target: "add_once", samples: undefined } as any],
	);
	// The generated loop function and its call site must agree on the name.
	expect(harness).toMatch(/func bench_loop_bench_add\s*=/);
	expect(harness).toContain("bench_loop_bench_add(ref t)");
	expect(harness).toContain("add_once()");
});

test("generate_harness resets has_failed/bench_pending before each bench", () => {
	const harness = generate_harness(
		[],
		[{ name: "bench_add", label: "add", target: "add_once", samples: undefined } as any],
	);
	expect(harness).toContain("t.has_failed = false");
	expect(harness).toContain("t.bench_pending = false");
});

test("generate_harness clamps the sample count to 4096", () => {
	const huge = generate_harness(
		[],
		[{ name: "b", label: "x", target: "f", samples: 999999 } as any],
	);
	expect(huge).toContain("while __i < 4096");
	const small = generate_harness([], [{ name: "b", label: "x", target: "f", samples: 5 } as any]);
	expect(small).toContain("while __i < 5");
});

test("generate_harness excludes bench functions from the plain test list", () => {
	const harness = generate_harness(
		[{ name: "test_one" } as any],
		[{ name: "bench_one", label: "l", target: "f", samples: undefined } as any],
	);
	// bench_one must not be run as a plain test (no begin/end bracket for it).
	expect(harness).not.toContain('begin_test("bench_one")');
});

// ---------------------------------------------------------------------------
// parse_records
// ---------------------------------------------------------------------------

test("parse_records reads done/fail/bench records and forwards other lines", () => {
	const prefix = "\\nomen|";
	const stdout = [
		"some stray output",
		`${prefix}start|test_a`,
		`${prefix}done|test_a|3|0|1500`,
		`${prefix}fail|test_b|boom|with|pipes`,
		`${prefix}done|test_b|1|1|2000`,
		`${prefix}bench|add|1000|10|20|30|30.5|4.2`,
		"another stray line",
	].join("\n");
	const r = parse_records(stdout);
	expect(r.tests).toEqual([
		{ name: "test_a", passed: 3, failed: 0, ns: 1500 },
		{ name: "test_b", passed: 1, failed: 1, ns: 2000 },
	]);
	// The message keeps its embedded pipes (only split up to fixed arity).
	expect(r.fails).toEqual([{ test: "test_b", message: "boom|with|pipes" }]);
	expect(r.benches).toEqual([
		{ label: "add", n: 1000, min: 10, median: 20, max: 30, mean: 30.5, stddev: 4.2 },
	]);
	expect(r.other).toEqual(["some stray output", "another stray line"]);
});

test("parse_records treats an empty stdout as nothing", () => {
	const r = parse_records("");
	expect(r.tests).toEqual([]);
	expect(r.fails).toEqual([]);
	expect(r.benches).toEqual([]);
	expect(r.other).toEqual([]);
});

// ---------------------------------------------------------------------------
// per-test timeout policy
// ---------------------------------------------------------------------------

// A per-test timeout BELOW the global is the cold-run flake generator: the
// slowest legitimate test (an ObjC/GUI build, which cannot use the precompiled
// system object and so recompiles all of System per test, on both backends)
// costs ~1.4s warm and ~2.7s solo-cold, and 4-8x that under worker contention.
// `layout_container.test.ts` shipped a 10-second override on all 35 of its
// tests and failed 9 ways on a fully cold run while being green warm — so the
// budget is policed here rather than left to each file.
test("no test sets a per-test timeout below the global 60s", () => {
	const global_timeout = 60_000;
	const offenders: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "out") continue;
				walk(full);
				continue;
			}
			if (!entry.name.endsWith(".test.ts")) continue;
			const source = fs.readFileSync(full, "utf8");
			// vitest's per-test override is the trailing argument of a
			// test()/it() call — a trailing `}, <ms>);`.
			for (const m of source.matchAll(/\},?\s*([0-9][0-9_]*)\s*\);/g)) {
				const ms = Number(m[1].replaceAll("_", ""));
				if (ms < global_timeout) {
					offenders.push(`${path.relative(".", full)}: ${m[0].trim()}`);
				}
			}
		}
	};
	walk(path.resolve(".", "test"));
	expect(offenders).toEqual([]);
});

// ---------------------------------------------------------------------------
// extract_leaks
// ---------------------------------------------------------------------------

test("extract_leaks pulls exit-time audit leak lines out of stdout", () => {
	const stdout = ["\\nomen|done|t|1|0|5", "LEAK: 256 allocation(s)", "trailing noise"].join("\n");
	expect(extract_leaks(stdout)).toEqual(["LEAK: 256 allocation(s)"]);
});

test("extract_leaks returns [] for a clean run", () => {
	expect(extract_leaks("\\nomen|done|t|1|0|5\n")).toEqual([]);
});

// A free that matched no live audit allocation (a foreign pointer, a double
// free). Like a leak line it fails the file — and unlike the previous
// behaviour it is reported at all: the runtime no longer passes such a pointer
// to libc free, which aborted inside the allocator.
test("extract_leaks pulls unmatched-free lines out of stdout", () => {
	const stdout = [
		"\\nomen|done|t|1|0|5",
		"AUDIT-STALE-FREE: 2 pointer(s) freed that were not live audit allocations",
		"trailing noise",
	].join("\n");
	expect(extract_leaks(stdout)).toEqual([
		"AUDIT-STALE-FREE: 2 pointer(s) freed that were not live audit allocations",
	]);
});

// ---------------------------------------------------------------------------
// run_test_file (end-to-end: parse + build + link + run the calc fixture)
// ---------------------------------------------------------------------------

test("run_test_file compiles, runs and reports the calc fixture in both modes", async () => {
	// The fixture intentionally fails two asserts; both the default (debug)
	// and --release builds must agree on that and report the bench record.
	for (const release of [false, true]) {
		const result = await run_test_file(
			"cli/test/fixtures/calc.test.nm",
			"core",
			"aarch64",
			false,
			undefined,
			release,
		);
		expect(result.phase).toBeUndefined();
		expect(result.crashed).toBeUndefined();
		expect(result.ok).toBe(false);
		expect(result.tests.map((t) => t.name)).toEqual([
			"test_add",
			"test_mul",
			"test_assert_not_null",
		]);
		expect(result.fails.map((f) => f.test)).toEqual(["test_mul", "test_assert_not_null"]);
		expect(result.benches).toHaveLength(1);
		expect(result.benches[0].label).toBe("add");
		expect(result.leaks).toEqual([]);
	}
}, 60_000);

test("run_test_file links the companion C file (spawn fixture)", async () => {
	// The spawn fixture's aarch64 .s calls into the pool/fiber runtime that
	// lives in the companion C file — a regression here shows up as a link
	// failure, not a silent pass.
	for (const release of [false, true]) {
		const result = await run_test_file(
			"cli/test/fixtures/spawn.test.nm",
			"core",
			"aarch64",
			false,
			undefined,
			release,
		);
		expect(result.crashed).toBeUndefined();
		expect(result.ok).toBe(true);
		expect(result.tests.map((t) => t.name)).toEqual(["test_fiber_result", "test_thread_string"]);
		expect(result.fails).toEqual([]);
	}
}, 60_000);

test("run_test_file links aarch64 with System::Stream::File and honors the CWD contract", async () => {
	// Two contracts in one fixture:
	// 1. aarch64 link: `import System::Stream::File` pulls Tcp's
	//    `aarch64_use_c` companions into the object — the generated main
	//    references the Tcp_* thunks even though the test never calls Tcp,
	//    and the link must provide the companion C (the sibling-module
	//    extern leak used to break the test link line).
	// 2. CWD: the fixture reads `fileio_corpus.txt` RELATIVELY; the binary
	//    runs in the --in root, so the relative path resolves even though
	//    this test process's CWD is the repo root and the fixture lives in
	//    cli/test/fixtures.
	for (const arch of ["aarch64", "c"] as const) {
		const result = await run_test_file(
			"cli/test/fixtures/fileio.test.nm",
			"core",
			arch,
			false,
			undefined,
			false,
			path.resolve("cli/test/fixtures"),
		);
		expect(result.phase).toBeUndefined();
		expect(result.crashed).toBeUndefined();
		expect(result.ok).toBe(true);
		expect(result.fails).toEqual([]);
		expect(result.leaks).toEqual([]);
	}
}, 90_000);

// ---------------------------------------------------------------------------
// audit runtime auto-discovery
// ---------------------------------------------------------------------------

test("run_test_file --audit auto-discovers the bundled audit runtime", async () => {
	// A test file in a temp dir has no src/audit_runtime.c to walk up to —
	// before the bundled fallback this failed in setup ("Audit enabled but
	// audit_runtime.c was not found") and forced an explicit --audit-runtime.
	// The audit build must find the CLI-bundled runtime and stay balanced.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomen-audit-"));
	const file = path.join(dir, "audit_lookup.test.nm");
	fs.writeFileSync(
		file,
		`import System
import System::Test

pub func test_ok = (ref Tester t) {
	t.expect(1 + 1 == 2, "math should math")
}
`,
	);
	try {
		for (const arch of ["aarch64", "c"] as const) {
			const result = await run_test_file(file, "core", arch, true, undefined, false);
			expect(result.phase).toBeUndefined();
			expect(result.crashed).toBeUndefined();
			expect(result.ok).toBe(true);
			expect(result.tests.map((t) => t.name)).toEqual(["test_ok"]);
			expect(result.leaks).toEqual([]);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}, 90_000);

// ---------------------------------------------------------------------------
// runTests (parallel test-file execution + ordered reporting)
// ---------------------------------------------------------------------------

test("runTests runs files concurrently but reports them in discovery order", async () => {
	// Three fixtures (one intentionally failing). With jobs > 1 the
	// latency-bound clang/link/run steps overlap across files, yet the
	// per-file report must stay in the discovery (sorted) order and the
	// aggregate result must be identical to the sequential run.
	const logs: string[] = [];
	const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
	});
	let parallel_ok: boolean;
	try {
		parallel_ok = await runTests("cli/test/fixtures", { jobs: 3 });
	} finally {
		spy.mockRestore();
	}
	// calc.test.nm intentionally fails two asserts.
	expect(parallel_ok).toBe(false);

	const order = logs
		.filter((l) => l.includes("cli/test/fixtures/") && l.includes(".test.nm"))
		.map((l) => l.replace(/.*fixtures\//, "").replace(/ .*/, ""));
	expect(order).toEqual(["calc.test.nm", "fileio.test.nm", "spawn.test.nm"]);
}, 120_000);
