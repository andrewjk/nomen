import { expect, test } from "vite-plus/test";

import {
	collect_test_files,
	extract_bench_functions,
	extract_test_functions,
	generate_harness,
	parse_records,
} from "../cli/src/test.ts";

// ---------------------------------------------------------------------------
// collect_test_files
// ---------------------------------------------------------------------------

test("collect_test_files discovers *.test.nm recursively and sorts", () => {
	const files = collect_test_files("cli/test/fixtures");
	expect(files.length).toBe(1);
	expect(files[0].replace(/\\/g, "/")).toMatch(/calc\.test\.nm$/);
});

test("collect_test_files returns [] for a missing folder", () => {
	expect(collect_test_files("does/not/exist")).toEqual([]);
});

// ---------------------------------------------------------------------------
// extract_test_functions
// ---------------------------------------------------------------------------

test("extract_test_functions finds pub func (ref Tester t) declarations", () => {
	const src = `
		import System/Test
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
