import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports, { parse_raw } from "./parse_with_imports";

// Task + spawn tests — run on both C and aarch64 backends. Each runtime test
// loops over both architectures to ensure parity. See ASYNC.md for the design.

const ARCHITECTURES = ["c", "aarch64"] as const;
const OPTIONS = { audit: true } as const;

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
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`spawn_and_wait_${arch}`, result, "hello from task\ndone\n", options);
		}
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
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`spawn_passes_arg_${arch}`, result, "got it\n", options);
		}
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
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			// Both tasks print; relative order is nondeterministic.
			await check_output(`task_two_both_run_${arch}`, result, "", options);
		}
	});
});

describe("spawn keyword", () => {
	test("spawn fires and forgets", async () => {
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
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`spawn_fire_forget_${arch}`, result, "from background\n", options);
		}
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
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`spawn_with_arg_${arch}`, result, "ok\n", options);
		}
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
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`spawn_returns_task_${arch}`, result, "from task\nafter wait\n", options);
		}
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
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`spawn_result_value_${arch}`, result, "correct\n", options);
		}
	});

	test("Task.cancel() sets the flag; current_cancelled observes it", async () => {
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
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`spawn_cancel_${arch}`, result, "cancelled\n", options);
		}
	});

	test("async timeout cancels long-running task", async () => {
		const input = `
func busy = (uint64 arg) {
	var int i = 0
	while i < 10000000 {
		if Task.current_cancelled() {
			Console.write_line("cancelled")
			return
		}
		i = i + 1
	}
	Console.write_line("done")
}

async(timeout: 50) {
	spawn busy(0)
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`async_timeout_${arch}`, result, "cancelled\n", options);
		}
	});

	test("worker pool handles more tasks than workers", async () => {
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
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`pool_many_tasks_${arch}`, result, "all ran\n", options);
		}
	});

	test("producer/filter/consumer pipeline via channels", async () => {
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
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`pipeline_${arch}`, result, "pipeline ok\n", options);
		}
	});

	test("Task.set_pool_size configures the pool before first spawn", async () => {
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
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`pool_size_configurable_${arch}`, result, "ok\n", options);
		}
	});

	test("nested spawns do not deadlock the pool", async () => {
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
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`pool_nested_spawn_${arch}`, result, "no deadlock\n", options);
		}
	});

	test("fire-and-forget tasks are joined at process exit", async () => {
		const input = `
func bg = (uint64 arg) {
	Console.write_line("from background")
}

spawn bg(0)
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`pool_joined_at_exit_${arch}`, result, "from background\n", options);
		}
	});

	test("Task.shutdown_pool joins outstanding tasks explicitly", async () => {
		const input = `
func bg = (uint64 arg) {
	Console.write_line("from background")
}

spawn bg(0)
Task.shutdown_pool()
Console.write_line("after shutdown")
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(
				`pool_explicit_shutdown_${arch}`,
				result,
				"from background\nafter shutdown\n",
				options,
			);
		}
	});
});

describe("async nursery", () => {
	test("async block waits for spawned tasks", async () => {
		const input = `
func bg = (uint64 arg) {
	Console.write_line("from background")
}

async {
	spawn bg(0)
}

Console.write_line("after block")
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(
				`async_nursery_waits_${arch}`,
				result,
				"from background\nafter block\n",
				options,
			);
		}
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
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			// Both bg outputs come before "done"; their relative order is nondeterministic.
			await check_output(`async_nursery_multiple_${arch}`, result, "", options);
		}
	});

	test("spawn inside a nursery returns a usable Task", async () => {
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
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`async_spawn_usable_task_${arch}`, result, "usable\n", options);
		}
	});

	test("nursery join after an explicit wait is a no-op", async () => {
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
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`async_join_after_wait_${arch}`, result, "ran\nwaited\nafter\n", options);
		}
	});
});

describe("async race mode", () => {
	test("async(mode: race) exits on first completion and cancels the rest", async () => {
		const input = `
import System

func quick = (Channel ch) {
	ch.send(1)
}

func slow = (Channel ch) {
	var int i = 0
	while i < 100000000 {
		if Task.current_cancelled() {
			return
		}
		i = i + 1
	}
	ch.send(99)
}

pub func main = () {
	var Channel ch = Channel()

	async(mode: race) {
		spawn slow(ch)
		spawn quick(ch)
	}

	var uint64 v = ch.receive()
	if v == 1 {
		Console.write_line("quick won")
	} else {
		Console.write_line("slow won")
	}
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`async_race_first_${arch}`, result, "quick won\n", options);
		}
	});

	test("async(mode: race, timeout: N) exits on first completion or timeout", async () => {
		const input = `
import System

func slow = (Channel ch) {
	var int i = 0
	while i < 100000000 {
		if Task.current_cancelled() {
			return
		}
		i = i + 1
	}
	ch.send(99)
}

pub func main = () {
	var Channel ch = Channel()

	async(mode: race, timeout: 50) {
		spawn slow(ch)
	}

	// Both paths (slow cancels before sending) leave the channel empty.
	// Use a sentinel send after the nursery so receive always has a value.
	ch.send(7)
	var uint64 v = ch.receive()
	if v == 7 {
		Console.write_line("ok")
	} else {
		Console.write_line("wrong")
	}
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`async_race_timeout_${arch}`, result, "ok\n", options);
		}
	});

	test("async(mode: race) with no tasks is a no-op", async () => {
		const input = `
async(mode: race) {
}

Console.write_line("done")
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`async_race_empty_${arch}`, result, "done\n", options);
		}
	});
});

describe("Mutex", () => {
	test("Mutex can be shared between spawned tasks", async () => {
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
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`mutex_shared_spawn_${arch}`, result, "", options);
		}
	});

	test("Mutex lock/unlock smoke test", async () => {
		const input = `
var Mutex mu = Mutex()
mu.lock()
mu.unlock()
Console.write_line("ok")
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`mutex_smoke_${arch}`, result, "ok\n", options);
		}
	});
});

describe("Channel", () => {
	test("Channel passes values between tasks", async () => {
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
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`channel_passes_values_${arch}`, result, "first\nsecond\n", options);
		}
	});
});

describe("Sendable enforcement", () => {
	test("non-Sendable struct arg fails to compile", () => {
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
