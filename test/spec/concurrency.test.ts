import { describe, expect, test } from "vite-plus/test";

import { compile_module } from "./_helpers.ts";

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
	Thread(work(p)).start()
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
	Thread(work(c)).start()
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("spec: concurrency - spawn", () => {
	test("a Thread construction is a storable value started later", () => {
		// SPEC.md, "Thread": the construction binds its arguments eagerly;
		// the call happens at start() — including for a stored value.
		const input = `
func bg = (uint64 arg) {
	Console.write_line("from task")
}

pub func main = () {
	var job = Thread(bg(0))
	job.start()
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("spawn as statement (fire-and-forget)", () => {
		const input = `
func bg = (uint64 arg) {
	Console.write_line("from task")
}

pub func main = () {
	Thread(bg(0)).start()
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
	var t = Thread(bg(0)).start()
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
	Thread(work(b)).start()
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("spec: concurrency - daemon tasks", () => {
	test("Thread(fn(args)).detach() runs a process-lifetime service", () => {
		const input = `
func flusher = (Channel sink) {
	sink.send(1)
	while true { Time.sleep_ms(1000) }
}

pub func main = () {
	var Channel sink = Channel()
	Thread(flusher(sink)).detach()
	var uint64 v = sink.receive()
	Console.write_line("daemon alive")
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
		Thread(fetch(1)).start()
		Thread(fetch(2)).start()
	}
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("spec: concurrency - Nursery escape hatch", () => {
	test("passed nursery spawns into the caller's nursery", () => {
		const input = `
func parse = (uint64 conn) {
}

func respond = (uint64 conn) {
}

func handle_connection = (uint64 conn, ref Nursery pool) {
	pool.start(Thread(parse(conn)))
	pool.start(Thread(respond(conn)))
}

pub func main = () {
	var uint64 conn = 0
	async pool {
		handle_connection(conn, ref pool)
	}
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("nursery.spawn returns a Task handle", () => {
		const input = `
func compute = (uint64 n) => n + 1

func spawn_one = (uint64 n, ref Nursery pool) {
	var t = pool.start(Thread(compute(n)))
	var uint64 r = t.result_uint64()
}

pub func main = () {
	async pool {
		spawn_one(41, ref pool)
	}
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("nursery.spawn directly in async block", () => {
		const input = `
func parse = (uint64 conn) {
}

pub func main = () {
	var uint64 conn = 0
	async pool {
		pool.start(Thread(parse(conn)))
	}
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("named nursery with config", () => {
		const input = `
func work = (uint64 arg) {
}

pub func main = () {
	async pool = Nursery(timeout: 500, mode: race) {
		Thread(work(0)).start()
	}
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("non-Sendable nursery.spawn arg is rejected", () => {
		const input = `
pub class Counter {
	var int count = 0
}

func work = (Counter c) {
}

pub func main = () {
	var Counter c = Counter()
	async pool {
		pool.start(Thread(work(c)))
	}
}
`;
		const errors = compile_module(input);
		expect(errors.some((e) => e.message.includes("not Sendable"))).toBe(true);
	});
});

describe("spec: concurrency - Task", () => {
	test("Task wait and result_uint64", () => {
		const input = `
func compute = (uint64 n) => n + 1

pub func main = () {
	var t = Thread(compute(41)).start()
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
	var t = Thread(long_running(0)).start()
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
		Thread(worker(m)).start()
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
		Thread(producer(c)).start()
	}
	var uint64 v = c.receive()
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("Channel send_string/receive_string", () => {
		const input = `
func producer = (Channel c) {
	c.send_string("hello")
}

pub func main = () {
	var Channel c = Channel()
	async {
		Thread(producer(c)).start()
	}
	var string s = c.receive_string()
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
		Thread(work(0)).start()
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
		Thread(work(0)).start()
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
		Thread(work(1)).start()
		Thread(work(2)).start()
		Thread(work(3)).start()
	}
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("spec: concurrency - race mode", () => {
	test("async(mode: race) compiles", () => {
		const input = `
func work = (uint64 arg) {
}

pub func main = () {
	async(mode: race) {
		Thread(work(0)).start()
		Thread(work(1)).start()
	}
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("async(mode: race, timeout: N) compiles", () => {
		const input = `
func work = (uint64 arg) {
}

pub func main = () {
	async(mode: race, timeout: 500) {
		Thread(work(0)).start()
		Thread(work(1)).start()
	}
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("spec: concurrency - Fiber", () => {
	test("Fiber spawn yields a parkable Task", () => {
		const input = `
func compute = (uint64 n, out uint64) {
	return n + 1
}

pub func main = () {
	var f = Fiber(compute(41)).start()
	var uint64 r = f.result()
	Console.write_line("\\{r}")
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("yield and is_fiber", () => {
		const input = `
func step = (Channel ch, uint64 id) {
	ch.send(id)
	Fiber.yield()
	ch.send(id)
}

pub func main = () {
	var Channel ch = Channel()
	var a = Fiber(step(ch, 1)).start()
	var b = Fiber(step(ch, 2)).start()
	a.wait()
	b.wait()
	Fiber.yield()
	if Fiber.is_fiber() {
		Console.write_line("in a fiber")
	}
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("start_on runs a fiber on a caller-provided stack", () => {
		const input = `
func work = (uint64 n) {
	Console.write_line("static stack")
}

pub func main = () {
	var uint64[2048] stack_buf
	var f = Fiber(work(0)).start_on(stack_buf)
	f.wait()
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("cooperative mode defers execution to waits or exit", () => {
		const input = `
func background = (uint64 n) {
	Console.write_line("ran")
}

pub func main = () {
	Fiber.set_cooperative(true)
	Fiber(background(0)).start()
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});
