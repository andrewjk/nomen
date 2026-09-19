import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import check_output from "./check_output";
import { parse_raw } from "./parse_with_imports";

// docs/CLOSURE_PLAN.md Phase 3c: the spawn construction accepts a
// zero-argument FUNCTION VALUE — `Thread(() => work(n))`. The lambda's
// CAPTURES are the eager arguments (Sendable-validated), the task closure
// is a per-site adapter that calls the value through the descriptor ABI
// and owns (disposes) it afterwards, and `.detach()` / a nursery's
// `.start(...)` accept the form. A func-typed LOCAL is moved into the
// task: using it afterwards is a use-after-move error.

describe("Thread from a function value (Phase 3c)", () => {
	test("capture-free lambda literal, chained start", async () => {
		const input = `import System

func work = (int n, out uint64) {
	return n * 2
}

pub func main = () {
	var t = Thread(() => work(21)).start()
	Console.write_line(t.result_uint64().to_string())
}
`;
		await build_and_check_output(input, "fnval_chained", "42\n", true);
	});

	test("a capturing lambda crosses the thread boundary", async () => {
		const input = `import System

func work = (int n, out uint64) {
	return n * 2
}

pub func main = () {
	var int base = 20
	var t = Thread(() => work(base + 1)).start()
	Console.write_line(t.result_uint64().to_string())
}
`;
		await build_and_check_output(input, "fnval_capturing", "42\n", true);
	});

	test("a string-capturing lambda returning a string", async () => {
		const input = `import System

pub func main = () {
	var string who = "closure"
	var t = Thread(() => "hello " + who).start()
	Console.write_line(t.result())
}
`;
		await build_and_check_output(input, "fnval_string_ret", "hello closure\n", true);
	});

	test("a stored function-value Thread starts later", async () => {
		const input = `import System

func work = (int n, out uint64) {
	return n + 1
}

pub func main = () {
	var int base = 41
	var t = Thread(() => work(base))
	Console.write_line("made")
	var h = t.start()
	Console.write_line(h.result_uint64().to_string())
}
`;
		await build_and_check_output(input, "fnval_store_later", "made\n42\n", true);
	});

	test("a func-typed local moves into the task", async () => {
		const input = `import System

func work = (int n, out uint64) {
	return n + 1
}

pub func main = () {
	var int base = 41
	var func (out uint64) job = () => work(base)
	var t = Thread(job).start()
	Console.write_line(t.result_uint64().to_string())
}
`;
		await build_and_check_output(input, "fnval_local_moved", "42\n", true);
	});

	test("using a moved func local after the construction is an error", () => {
		const input = `import System

func work = (int n, out uint64) {
	return n
}

pub func main = () {
	var int base = 7
	var func (out uint64) job = () => work(base)
	var t = Thread(job).start()
	var u = Thread(job).start()
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("used after move");
	});

	test("a lambda with a parameter is rejected", () => {
		const input = `import System

func work = (int n, out uint64) {
	return n
}

pub func main = () {
	var t = Thread((int x) => work(x)).start()
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("zero-argument");
	});

	test("a non-Sendable capture is rejected", () => {
		const input = `import System

pub class Counter {
	var int count = 0
}

pub func main = () {
	var Counter c = Counter()
	var t = Thread(() => c.count).start()
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("not Sendable");
	});

	test("a lambda daemon detaches", async () => {
		const input = `import System

func bump = (Channel report) {
	report.send(1)
}

pub func main = () {
	var Channel report = Channel()
	var d = Thread(() => { bump(report) })
	d.detach()
	// The construction moved the channel into the daemon's closure — main
	// touches neither the channel nor the handle again. The daemon's send
	// goes into the void; main's output is deterministic.
	Console.write_line("detached")
}
`;
		// Audit off, mirroring daemon.test.ts: a daemon still running (or
		// killed) at process exit leaks its task closure by construction.
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		for (const arch of ["c", "aarch64"] as const) {
			const built = build(parsed.root, { arch, audit: false });
			await check_output("fnval_detach", built, "detached\n", { arch, audit: false });
		}
	});

	test("a lambda spawned through the nursery escape hatch is joined", async () => {
		const input = `import System

func produce = (out uint64) {
	return 42
}

pub func main = () {
	var uint64 got = 0
	async pool {
		var t = pool.start(Thread(() => produce()))
		got = t.result_uint64()
	}
	Console.write_line(got.to_string())
}
`;
		await build_and_check_output(input, "fnval_nursery", "42\n", true);
	});
});
