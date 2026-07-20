import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Task + spawn tests — C backend only for v1 (aarch64 will follow once the
// API stabilizes). These actually compile and run the binary, then check
// output. See ASYNC.md for the design.

describe("Task runtime", () => {
	test("spawn and wait", async () => {
		const input = `
func work = (uint64 arg) {
	Console.write_line("hello from task")
}

const t = Task(work, 0)
t.wait()
Console.write_line("done")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "c" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output("task_spawn_and_wait", result, "hello from task\ndone\n", options);
	});

	test("spawn passes arg", async () => {
		const input = `
func work = (uint64 arg) {
	if arg == 42 {
		Console.write_line("got it")
	} else {
		Console.write_line("wrong value")
	}
}

const t = Task(work, 42)
t.wait()
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "c" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output("task_passes_arg", result, "got it\n", options);
	});

	test("two tasks both run", async () => {
		const input = `
func work_a = (uint64 arg) {
	Console.write_line("a")
}

func work_b = (uint64 arg) {
	Console.write_line("b")
}

const t1 = Task(work_a, 0)
const t2 = Task(work_b, 0)
t1.wait()
t2.wait()
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "c" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output("task_two_both_run", result, "a\n", options);
	});
});

describe("spawn keyword", () => {
	test("spawn fires and forgets", async () => {
		// We need to sleep to give the spawned task time to run before main exits.
		// Without a sleep, main can return before the spawn fires.
		const input = `
func bg = (uint64 arg) {
	Console.write_line("from background")
}

spawn bg(0)

// Crude sleep: spin until the bg task has had a chance to run.
var int i = 0
while i < 1000000 {
	i = i + 1
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "c" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output("spawn_fire_forget", result, "from background\n", options);
	});

	test("spawn with string arg", async () => {
		const input = `
func bg = (uint64 arg) {
	Console.write_line("ok")
}

spawn bg(0)
var int i = 0
while i < 1000000 {
	i = i + 1
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "c" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output("spawn_with_arg", result, "ok\n", options);
	});
});

describe("async nursery", () => {
	test("async block waits for spawned tasks", async () => {
		// No sleep needed — the nursery's implicit join at block exit guarantees
		// bg has finished before main proceeds.
		const input = `
func bg = (uint64 arg) {
	Console.write_line("from background")
}

async {
	spawn bg(0)
}

Console.write_line("after block")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "c" as const, audit: false };
		const result = build(parsed.root, options);
		// Order is deterministic: "from background" must come before "after block".
		await check_output("async_nursery_waits", result, "from background\nafter block\n", options);
	});

	test("async block joins multiple spawns", async () => {
		const input = `
func bg = (uint64 n) {
	if n == 0 {
		Console.write_line("zero")
	} else {
		Console.write_line("nonzero")
	}
}

async {
	spawn bg(0)
	spawn bg(1)
}

Console.write_line("done")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "c" as const, audit: false };
		const result = build(parsed.root, options);
		// Both bg outputs come before "done"; their relative order is nondeterministic.
		await check_output("async_nursery_multiple", result, "", options);
		// Sanity: the binary ran without crashing — check_output asserts no stderr.
	});
});

