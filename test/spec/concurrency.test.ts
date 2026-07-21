import { describe, expect, test } from "vite-plus/test";

import { compile_main, compile_module } from "./_helpers.ts";

// Tests for the concurrency features documented in SPEC.md (see "Concurrency"
// section). The C-backend runtime tests live in test/task.test.ts; these
// just verify the spec examples compile cleanly.

describe("spec: concurrency - Sendable", () => {
	test("Sendable marker trait", () => {
		const input = `
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
		expect(compile_module(input)).toEqual([]);
	});

	test("class must explicitly declare Sendable", () => {
		const input = `
pub class SafeCounter : Sendable {
	var int count = 0
}

pub func work = (SafeCounter c) {
}

pub func main = () {
	var SafeCounter c = SafeCounter()
	spawn work(c)
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("spec: concurrency - spawn", () => {
	test("spawn as statement (fire-and-forget)", () => {
		const input = `
func bg = (uint64 arg) {
	Console.write_line("from task")
}

pub func main = () {
	spawn bg(0)
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("spawn as expression (Task handle)", () => {
		const input = `
func bg = (uint64 arg) {
	Console.write_line("from task")
}

pub func main = () {
	var t = spawn bg(0)
	t.wait()
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("spawn with class arg", () => {
		const input = `
pub class Box : Sendable {
	var int value = 0
}

func work = (Box b) {
}

pub func main = () {
	var Box b = Box()
	spawn work(b)
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("spec: concurrency - async nursery", () => {
	test("async block joins spawned tasks", () => {
		const input = `
func fetch = (uint64 id) {
	Console.write_line("ok")
}

pub func main = () {
	async {
		spawn fetch(1)
		spawn fetch(2)
	}
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("spec: concurrency - Task", () => {
	test("Task wait and result_uint64", () => {
		const input = `
func compute = (uint64 n) => n + 1

pub func main = () {
	var t = spawn compute(41)
	t.wait()
	var uint64 r = t.result_uint64()
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("Task cancel and current_cancelled", () => {
		const input = `
func long_running = (uint64 arg) {
	var int i = 0
	while i < 100 {
		if Task.current_cancelled() {
			return
		}
		i = i + 1
	}
}

pub func main = () {
	var t = spawn long_running(0)
	t.cancel()
	t.wait()
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("spec: concurrency - Mutex", () => {
	test("Mutex lock/unlock", () => {
		const input = `
func worker = (Mutex m) {
	m.lock()
	m.unlock()
}

pub func main = () {
	var Mutex m = Mutex()
	async {
		spawn worker(m)
	}
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("spec: concurrency - Channel", () => {
	test("Channel send/receive", () => {
		const input = `
func producer = (Channel c) {
	c.send(101)
}

pub func main = () {
	var Channel c = Channel()
	async {
		spawn producer(c)
	}
	var uint64 v = c.receive()
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("spec: concurrency - timeout", () => {
	test("async with timeout compiles", () => {
		const input = `
func work = (uint64 arg) {
	var int i = 0
	while i < 1000000 {
		i = i + 1
	}
}

pub func main = () {
	async(timeout: 500) {
		spawn work(0)
	}
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("async with timeout expression compiles", () => {
		const input = `
func work = (uint64 arg) {
}

pub func main = () {
	var uint64 ms = 100
	async(timeout: ms * 2) {
		spawn work(0)
	}
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("async with timeout and multiple tasks compiles", () => {
		const input = `
func work = (uint64 arg) {
}

pub func main = () {
	async(timeout: 1000) {
		spawn work(1)
		spawn work(2)
		spawn work(3)
	}
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});
