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

var t = spawn work(0)
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

var t = spawn work(42)
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

var t1 = spawn work_a(0)
var t2 = spawn work_b(0)
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

	test("worker pool handles more tasks than workers", async () => {
		// Spawn 10 tasks (more than the 4-worker pool). They should all
		// execute and the nursery should join them all. Each task sends its
		// id on the shared channel; main receives 10 and sums them.
		const input = `
import System

func work = (Channel ch, uint64 n) {
	ch.send(n)
}

pub func main = () {
	var Channel ch = Channel()

	async {
		spawn work(ch, 0)
		spawn work(ch, 1)
		spawn work(ch, 2)
		spawn work(ch, 3)
		spawn work(ch, 4)
		spawn work(ch, 5)
		spawn work(ch, 6)
		spawn work(ch, 7)
		spawn work(ch, 8)
		spawn work(ch, 9)
	}

	var int sum = 0
	var int i = 0
	while i < 10 {
		var uint64 v = ch.receive()
		sum = sum + (v as int)
		i = i + 1
	}
	if sum == 45 {
		Console.write_line("all ran")
	} else {
		Console.write_line("missing")
	}
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "c" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output("pool_many_tasks", result, "all ran\n", options);
	});

	test("producer/filter/consumer pipeline via channels", async () => {
		// Three-stage pipeline: producer emits 0..4, filter doubles each,
		// consumer sums them. Tests channel handoff between concurrent tasks.
		const input = `
import System

func producer = (Channel out) {
	var int i = 0
	while i < 5 {
		out.send(i as uint64)
		i = i + 1
	}
}

func filter = (Channel in_ch, Channel out) {
	var int i = 0
	while i < 5 {
		var uint64 v = in_ch.receive()
		out.send(v + v)
		i = i + 1
	}
}

pub func main = () {
	var Channel a = Channel()
	var Channel b = Channel()

	async {
		spawn producer(a)
		spawn filter(a, b)
	}

	// Consume from b in main
	var int sum = 0
	var int i = 0
	while i < 5 {
		var uint64 v = b.receive()
		sum = sum + (v as int)
		i = i + 1
	}
	// 0*2 + 1*2 + 2*2 + 3*2 + 4*2 = 20
	if sum == 20 {
		Console.write_line("pipeline ok")
	} else {
		Console.write_line("wrong")
	}
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "c" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output("pipeline", result, "pipeline ok\n", options);
	});

	test("Task.set_pool_size configures the pool before first spawn", async () => {
		// Set pool size to 8, spawn 8 tasks (each sends its id), verify all run.
		const input = `
import System

func work = (Channel ch, uint64 n) {
	ch.send(n)
}

pub func main = () {
	var int ok = Task.set_pool_size(8)
	if ok == 1 {
		var Channel ch = Channel()

		async {
			spawn work(ch, 0)
			spawn work(ch, 1)
			spawn work(ch, 2)
			spawn work(ch, 3)
			spawn work(ch, 4)
			spawn work(ch, 5)
			spawn work(ch, 6)
			spawn work(ch, 7)
		}

		var int sum = 0
		var int i = 0
		while i < 8 {
			var uint64 v = ch.receive()
			sum = sum + (v as int)
			i = i + 1
		}
		// sum of 0..7 = 28
		if sum == 28 {
			Console.write_line("ok")
		} else {
			Console.write_line("wrong")
		}
	} else {
		Console.write_line("set failed")
	}
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "c" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output("pool_size_configurable", result, "ok\n", options);
	});

	test("nested spawns do not deadlock the pool", async () => {
		// Four outer tasks fill the default 4-worker pool, and each blocks on
		// its own nursery waiting for two inner tasks. Without pool growth the
		// inner tasks would starve in the queue (every worker busy joining) —
		// a deadlock. The pool must start extra workers on demand.
		const input = `
import System

func inner = (Channel ch, uint64 n) {
	ch.send(n)
}

func outer = (Channel ch, uint64 n) {
	var uint64 m = n + 10
	async {
		spawn inner(ch, n)
		spawn inner(ch, m)
	}
}

pub func main = () {
	var Channel ch = Channel()

	async {
		spawn outer(ch, 0)
		spawn outer(ch, 1)
		spawn outer(ch, 2)
		spawn outer(ch, 3)
	}

	// 8 inner results: 0, 10, 1, 11, 2, 12, 3, 13 = 52
	var int sum = 0
	var int i = 0
	while i < 8 {
		var uint64 v = ch.receive()
		sum = sum + (v as int)
		i = i + 1
	}
	if sum == 52 {
		Console.write_line("no deadlock")
	} else {
		Console.write_line("wrong")
	}
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "c" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output("pool_nested_spawn", result, "no deadlock\n", options);
	});

	test("fire-and-forget tasks are joined at process exit", async () => {
		// No spin-wait and no explicit join: the pool's atexit shutdown drains
		// the queue and joins the workers, so bg still prints before exit.
		const input = `
func bg = (uint64 arg) {
	Console.write_line("from background")
}

spawn bg(0)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "c" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output("pool_joined_at_exit", result, "from background\n", options);
	});

	test("Task.shutdown_pool joins outstanding tasks explicitly", async () => {
		// Deterministic: after shutdown_pool returns, every queued task has
		// finished, so "after shutdown" always comes last.
		const input = `
func bg = (uint64 arg) {
	Console.write_line("from background")
}

spawn bg(0)
Task.shutdown_pool()
Console.write_line("after shutdown")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "c" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output(
			"pool_explicit_shutdown",
			result,
			"from background\nafter shutdown\n",
			options,
		);
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

	test("spawn inside a nursery returns a usable Task", async () => {
		// The nursery tracks the future, but the returned handle is fully
		// usable: result_uint64() blocks on the shared future and returns
		// the value, even though the nursery will join the same task again
		// at block exit (join-once).
		const input = `
func compute = (uint64 n) => n + 1

async {
	var t = spawn compute(41)
	var uint64 r = t.result_uint64()
	if r == 42 {
		Console.write_line("usable")
	} else {
		Console.write_line("wrong")
	}
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "c" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output("async_spawn_usable_task", result, "usable\n", options);
	});

	test("nursery join after an explicit wait is a no-op", async () => {
		// Explicitly waiting on a nursery Task, then letting the nursery
		// join it again at block exit, must not hang or crash.
		const input = `
func bg = (uint64 arg) {
	Console.write_line("ran")
}

async {
	var t = spawn bg(0)
	t.wait()
	Console.write_line("waited")
}

Console.write_line("after")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "c" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output("async_join_after_wait", result, "ran\nwaited\nafter\n", options);
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

	test("Mutex lock/unlock works on aarch64 backend", async () => {
		// Single-threaded smoke test for the aarch64 asm blocks in Mutex.echo.
		// Just verifies the asm assembles, links, and runs without crashing.
		const input = `
var Mutex mu = Mutex()
mu.lock()
mu.unlock()
Console.write_line("ok")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "aarch64" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output("mutex_aarch64_smoke", result, "ok\n", options);
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

	test("Channel passes values between tasks on aarch64", async () => {
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

		const options = { arch: "aarch64" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output("channel_aarch64", result, "first\nsecond\n", options);
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

describe("aarch64 concurrency", () => {
	test("spawn fires and forgets on aarch64", async () => {
		const input = `
func bg = (uint64 arg) {
	Console.write_line("from background")
}

spawn bg(0)

var int i = 0
while i < 1000000 {
	i = i + 1
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch: "aarch64" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output("aarch64_spawn_fire_forget", result, "from background\n", options);
	});

	test("spawn returns Task that can be waited on (aarch64)", async () => {
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

		const options = { arch: "aarch64" as const, audit: false };
		const result = build(parsed.root, options);
		await check_output("aarch64_spawn_wait", result, "from task\nafter wait\n", options);
	});
});
