import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";
import { compile_module } from "./spec/_helpers.ts";

// ASYNC_PLAN.md, "Awaitable trait": the consumption side of the async model
// is trait-able. `Task<T>` conforms — `wait` may park the current context —
// so a generic helper taking `Awaitable` waits on any task, whatever started
// it (a Thread, a Fiber, or a nursery spawn).

describe("Awaitable (Task<T> conforms)", () => {
	test("a Task-typed value dispatches wait through the trait", async () => {
		const input = `import System

func work = (uint64 n, out uint64) {
	return n * 2
}

func join_it = (ref Awaitable a) {
	a.wait()
}

pub func main = () {
	var t = Thread(work(21)).start()
	join_it(ref t)
	Console.write_line(t.result_uint64().to_string())
}
`;
		await build_and_check_output(input, "awaitable_dispatch", "42\n", true);
	});

	test("a Fiber's task is Awaitable too", async () => {
		const input = `import System

func work = (uint64 n, out uint64) {
	return n + 1
}

func join_it = (ref Awaitable a) {
	a.wait()
}

pub func main = () {
	var f = Fiber(work(41))
	var h = f.start()
	join_it(ref h)
	Console.write_line(h.result_uint64().to_string())
}
`;
		await build_and_check_output(input, "awaitable_fiber", "42\n", true);
	});

	test("non-conforming types are rejected as Awaitable", () => {
		const input = `import System

pub class NotATask {
	var int x = 0
}

func join_it = (ref Awaitable a) {
	a.wait()
}

pub func main = () {
	var NotATask n = NotATask()
	join_it(ref n)
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});

	test("the Awaitable SPEC example compiles", () => {
		const input = `import System

func work = (uint64 n, out uint64) {
	return n * 2
}

func join_it = (ref Awaitable a) {
	a.wait()
}

pub func main = () {
	var t = Thread(work(21)).start()
	join_it(ref t)
	Console.write_line(t.result_uint64().to_string())
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});
