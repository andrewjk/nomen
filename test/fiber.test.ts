import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports, { parse_raw } from "./parse_with_imports";

// Fiber runtime — Phase 1 of ASYNC_PLAN.md. Each runtime test loops over the
// C and aarch64 backends. A fiber is a stackful coroutine: it parks (frees
// its worker) instead of blocking, and `Fiber.yield()` hands the worker to
// the next runnable fiber.

const ARCHITECTURES = ["c", "aarch64"] as const;
const OPTIONS = { audit: true } as const;

describe("Fiber runtime", () => {
	test("fibers interleave round-robin via yield (cooperative, deterministic)", async () => {
		// Cooperative mode is single-threaded with a FIFO run queue, so the
		// interleaving is fully deterministic: A sends 1, yields; B sends 2,
		// yields; A sends 1; B sends 2 → receive order 1,2,1,2.
		const input = `
import System

func step = (Channel ch, uint64 id) {
	ch.send(id)
	Fiber.yield()
	ch.send(id)
}

pub func main = () {
	Fiber.set_cooperative(true)
	var Channel ch = Channel()
	var f1 = Fiber(step(ch, 1)).start()
	var f2 = Fiber(step(ch, 2)).start()
	// Cooperative mode defers execution to a would-block wait: joining f1
	// drains the shared queue, interleaving both fibers deterministically.
	var uint64 r1 = f1.result_uint64()
	var uint64 r2 = f2.result_uint64()
	var string order = ""
	var uint64 i = 0
	while i < 4 {
		var uint64 v = ch.receive()
		order = order + v.to_string()
		i = i + 1
	}
	Console.write_line(order)
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`fiber_yield_interleave_${arch}`, result, "1212\n", options);
		}
	});

	test("a fiber parks on a Thread task's result and wakes on completion", async () => {
		// The fiber calls result_uint64() on a Thread task: instead of
		// blocking its worker, the fiber parks on the future; when the thread
		// task completes, the fiber is scheduled again and finishes.
		const input = `
import System

func compute = (uint64 n) => n + 1

func waiter = (Channel ch, Task<uint64> handle) {
	var Task<uint64> t = handle
	var uint64 r = t.result_uint64()
	ch.send(r)
}

pub func main = () {
	var Channel ch = Channel()
	const t = Thread(compute(41)).start()
	var f = Fiber(waiter(ch, t)).start()
	// The fiber parks on the Thread task's result, wakes when it completes,
	// and sends it through the channel.
	var uint64 got = ch.receive()
	f.wait()
	if got == 42 {
		Console.write_line("park ok")
	}
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`fiber_park_on_task_${arch}`, result, "park ok\n", options);
		}
	});

	test("Fiber.is_fiber is true inside a fiber and false outside", async () => {
		const input = `
import System

func probe = (Channel ch) {
	ch.send(Fiber.is_fiber() as uint64)
}

pub func main = () {
	Fiber.set_cooperative(true)
	var Channel ch = Channel()
	var f = Fiber(probe(ch)).start()
	var uint64 r = f.result_uint64()
	if Fiber.is_fiber() {
		Console.write_line("main is fiber")
	} else {
		Console.write_line("main not fiber")
	}
	if ch.receive() == 1 {
		Console.write_line("fiber is fiber")
	}
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(
				`fiber_is_fiber_${arch}`,
				result,
				"main not fiber\nfiber is fiber\n",
				options,
			);
		}
	});

	test("start_on runs a fiber on a caller-provided static stack (C backend)", async () => {
		// 64 * 8 bytes would be too small; use a healthy fixed buffer. This
		// is the caller-provided-stack path. C backend only: the aarch64
		// backend cannot take the address of a local past frame offset 4095,
		// and a >=16 KB buffer pushes every later local past it (pre-existing
		// large-frame limitation — see FOLLOWUP.md).
		const input = `
import System

func work = (Channel ch, uint64 n) {
	ch.send(n * 2)
}

pub func main = () {
	Fiber.set_cooperative(true)
	var Channel ch = Channel()
	var uint64[2048] stack_buf
	var f = Fiber(work(ch, 21)).start_on(stack_buf)
	var uint64 r = f.result_uint64()
	var uint64 v = ch.receive()
	if v == 42 {
		Console.write_line("static stack ok")
	}
}
`;
		for (const arch of ["c"] as const) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`fiber_start_on_${arch}`, result, "static stack ok\n", options);
		}
	});

	test("fibers spawned inside a nursery are joined at block exit", async () => {
		const input = `
import System

func producer = (Channel ch) {
	ch.send(7)
}

pub func main = () {
	var Channel ch = Channel()
	async {
		Fiber(producer(ch)).start()
		// block does not exit until the fiber's future completes
	}
	var uint64 v = ch.receive()
	if v == 7 {
		Console.write_line("nursery joined fiber")
	}
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`fiber_nursery_join_${arch}`, result, "nursery joined fiber\n", options);
		}
	});

	test("a string result moves out of a fiber task intact", async () => {
		const input = `
import System

func greet = (uint64 n) => "hello " + "from fiber"

pub func main = () {
	var f = Fiber(greet(0)).start()
	var string s = f.result()
	if s.length == 16 {
		Console.write_line("len ok")
	}
	Console.write_line(s)
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(
				`fiber_string_result_${arch}`,
				result,
				"len ok\nhello from fiber\n",
				options,
			);
		}
	});

	test("nested fibers do not deadlock: a fiber spawning fibers", async () => {
		// A fiber spawns children and yields; the pool (or the cooperative
		// drain) keeps running everyone. Deterministic under cooperative mode.
		const input = `
import System

func leaf = (Channel ch, uint64 n, out uint64) {
	ch.send(n)
	return n
}

func branch = (Channel ch) {
	var c1 = Fiber(leaf(ch, 1)).start()
	var c2 = Fiber(leaf(ch, 2)).start()
	Fiber.yield()
	const uint64 a = c1.result_uint64()
	const uint64 b = c2.result_uint64()
	ch.send(a + b)
}

pub func main = () {
	Fiber.set_cooperative(true)
	var Channel ch = Channel()
	var f = Fiber(branch(ch)).start()
	var uint64 r = f.result_uint64()
	var uint64 v1 = ch.receive()
	var uint64 v2 = ch.receive()
	var uint64 sum = ch.receive()
	if v1 == 1 && v2 == 2 && sum == 3 {
		Console.write_line("nested ok")
	}
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(`fiber_nested_${arch}`, result, "nested ok\n", options);
		}
	});

	test("fire-and-forget fiber runs to completion before process exit", async () => {
		const input = `
import System

func bg = (uint64 arg) {
	Console.write_line("from fiber background")
}

pub func main = () {
	Fiber.set_cooperative(true)
	Fiber(bg(0)).start()
	Console.write_line("after start")
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, ...OPTIONS };
			const result = build(parsed.root, options);
			await check_output(
				`fiber_fire_forget_${arch}`,
				result,
				// Cooperative: the fiber runs at the exit drain, after main.
				"after start\nfrom fiber background\n",
				options,
			);
		}
	});
});

describe("Fiber checking", () => {
	test("non-Sendable fiber arg is rejected", () => {
		const input = `
import System

pub class Counter {
	var int count = 0
}

pub func work = (Counter c) {
}

pub func main = () {
	var Counter c = Counter()
	Fiber(work(c)).start()
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors.some((e) => e.message.includes("not Sendable"))).toBe(true);
	});

	test("start_on rejects a stack below the minimum", () => {
		const input = `
import System

func work = (uint64 n) {
}

pub func main = () {
	var uint64[64] tiny
	Fiber(work(0)).start_on(tiny)
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors.some((e) => e.message.includes("Fiber stack too small"))).toBe(true);
	});

	test("start_on rejects a non-array stack", () => {
		const input = `
import System

func work = (uint64 n) {
}

pub func main = () {
	var uint64 not_a_stack = 7
	Fiber(work(0)).start_on(not_a_stack)
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors.some((e) => e.message.includes("fixed-size array"))).toBe(true);
	});
});
