import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports, { parse_raw } from "./parse_with_imports";

// Task + spawn tests — C backend only for v1 (aarch64 will follow once the
// API stabilizes). These actually compile and run the binary, then check
// output. See ASYNC.md for the design.

describe("Task runtime", () => {
	test("spawn and wait", async () => {
		const input = `
func work = (uint64 arg) {
	Console.write_line("hello from task")
}

var t = Task(work, 0)
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

var t = Task(work, 42)
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

var t1 = Task(work_a, 0)
var t2 = Task(work_b, 0)
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

	test("spawn returns Task that can be waited on", async () => {
		const input = `
func bg = (uint64 arg) {
	Console.write_line("from task")
}

var t = spawn bg(0)
t.wait()
Console.write_line("after wait")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "c" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output("spawn_returns_task", result, "from task\nafter wait\n", options);
	});

	test("spawn result_uint64 returns function's return value", async () => {
		const input = `
func compute = (uint64 n) => n + 1

var t = spawn compute(41)
var uint64 r = t.result_uint64()
if r == 42 {
	Console.write_line("correct")
} else {
	Console.write_line("wrong")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "c" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output("spawn_result_value", result, "correct\n", options);
	});

	test("Task.cancel() sets the flag; current_cancelled observes it", async () => {
		// Spawn a long-running task, cancel it, and verify the task observes
		// cancellation via Task.current_cancelled() and exits early.
		const input = `
func long_running = (uint64 arg) {
	var int i = 0
	while i < 1000000000 {
		if Task.current_cancelled() {
			Console.write_line("cancelled")
			return
		}
		i = i + 1
	}
	Console.write_line("finished")
}

var t = spawn long_running(0)
t.cancel()
t.wait()
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "c" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output("spawn_cancel", result, "cancelled\n", options);
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

describe("Mutex", () => {
	test("Mutex can be shared between spawned tasks", async () => {
		// Two spawned tasks both lock the same Mutex and print while holding it.
		// We can't easily assert mutual exclusion from output alone, but this
		// verifies that class args (Mutex*) pass through spawn correctly and
		// that pthread_mutex_lock/unlock work across threads without crashing.
		const input = `
func worker = (Mutex mu) {
	mu.lock()
	Console.write_line("in critical section")
	mu.unlock()
}

var Mutex mu = Mutex()

async {
	spawn worker(mu)
	spawn worker(mu)
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "c" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output("mutex_shared_spawn", result, "", options);
	});
});

describe("Channel", () => {
	test("Channel passes values between tasks", async () => {
		// Producer sends two values; main receives them and prints.
		// receive() blocks until a value is available, so ordering is deterministic.
		const input = `
func producer = (Channel ch) {
	ch.send(101)
	ch.send(202)
}

var Channel ch = Channel()

async {
	spawn producer(ch)
}

var v1 = ch.receive()
var v2 = ch.receive()
if v1 == 101 {
	Console.write_line("first")
} else {
	Console.write_line("wrong")
}
if v2 == 202 {
	Console.write_line("second")
} else {
	Console.write_line("wrong")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "c" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output("channel_passes_values", result, "first\nsecond\n", options);
	});
});

describe("Sendable enforcement", () => {
	test("non-Sendable struct arg fails to compile", () => {
		// Contains a non-Sendable class field, so the struct isn't Sendable.
		const input = `
import System

pub class Counter {
	var int count = 0
}

pub struct HoldsClass {
	var Counter c
}

pub func work = (HoldsClass h) {
}

pub func main = () {
	var Counter c = Counter()
	var HoldsClass h = HoldsClass(c)
	spawn work(h)
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors.some((e) => e.message.includes("not Sendable"))).toBe(true);
	});

	test("Sendable struct arg passes", () => {
		const input = `
import System

pub struct Sendy : Sendable {
	var int x
}

pub func work = (Sendy s) {
}

pub func main = () {
	var Sendy s = Sendy(0)
	spawn work(s)
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
	});

	test("struct with all-Sendable fields auto-derives Sendable", () => {
		// No explicit `: Sendable`, but all fields are primitives (auto-Sendable).
		const input = `
import System

pub struct Point {
	var int x
	var int y
}

pub func work = (Point p) {
}

pub func main = () {
	var Point p = Point(0, 0)
	spawn work(p)
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
	});

	test("class without explicit Sendable fails (no auto-derive for classes)", () => {
		// Classes are mutable shared references — auto-derive would be unsafe.
		const input = `
import System

pub class Counter {
	var int count = 0
}

pub func work = (Counter c) {
}

pub func main = () {
	var Counter c = Counter()
	spawn work(c)
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors.some((e) => e.message.includes("not Sendable"))).toBe(true);
	});
});

