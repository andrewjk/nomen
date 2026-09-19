import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// ASYNC.md, "User-defined async primitives": the spawn construction sugar
// is not reserved for Thread/Fiber. Any user CLASS conforming to the core
// `Awaitable` trait and carrying the spawn-field contract (uint64 fields
// task / result_slot / cancel_flag / future) gets the same construction —
// `Job(fn(args))` packs the call eagerly and yields a heap instance whose
// fields hold the launch machinery; the class's own launch methods consume
// them through the library seam (Task.pool_submit / future_* — pure Nomen,
// no raw blocks: those are System-library-only). Must-start is deliberately
// NOT the compiler's business here: it is the class's own `#destroy`
// contract (or none at all).

/** The user primitive under test (module text spliced into each program). */
const JOB_CLASS = `
func produce = (Channel ch) {
	ch.send(42)
}

class Job : Awaitable {
	pub var uint64 task = 0
	pub var uint64 result_slot = 0
	pub var uint64 cancel_flag = 0
	pub var uint64 future = 0
	pub var started = false

	// Launch: hold the wait-side future ref, submit the packed task.
	pub func start = (ref self) {
		Task.future_set_refs(self.future, 2)
		Task.pool_submit(self.task)
		self.started = true
	}

	// Join: park on the future, drop the handle's ref, clear the fields
	// (a second wait is a no-op — the released future is gone).
	pub func wait = (ref self) {
		if self.future != 0 {
			Task.future_wait(self.future)
			Task.future_release(self.future)
			self.future = 0
			self.result_slot = 0
			self.cancel_flag = 0
		}
	}

	// Join and move the uint64 result out (read before the release —
	// the slot is freed with the future's last reference).
	pub func result_uint64 = (ref self, out uint64) {
		if self.future != 0 {
			Task.future_wait(self.future)
			var uint64 r = Task.future_result_uint64(self.future)
			Task.future_release(self.future)
			self.future = 0
			self.result_slot = 0
			self.cancel_flag = 0
			return r
		}
		return 0
	}
}
`;

describe("user-defined async primitives (Awaitable construction sugar)", () => {
	test("a stored user primitive launches, joins, and dispatches through Awaitable", async () => {
		const input = `import System
${JOB_CLASS}
func join_it = (ref Awaitable a) {
	a.wait()
}

pub func main = () {
	var Channel ch = Channel()
	var j = Job(produce(ch))
	j.start()
	join_it(ref j)
	var uint64 v = ch.receive()
	Console.write_line(v.to_string())
}
`;
		await build_and_check_output(input, "awaitable_ctor_job", "42\n", true);
	});

	test("the function-value form works for user primitives", async () => {
		const input = `import System
${JOB_CLASS}
pub func main = () {
	var j = Job(() => 42)
	j.start()
	var uint64 v = j.result_uint64()
	Console.write_line(v.to_string())
}
`;
		await build_and_check_output(input, "awaitable_ctor_fnval", "42\n", true);
	});

	test("a generic user primitive monomorphizes and joins through the trait", async () => {
		const input = `import System
${JOB_CLASS}
class Runner<T> : Awaitable {
	pub var uint64 task = 0
	pub var uint64 result_slot = 0
	pub var uint64 cancel_flag = 0
	pub var uint64 future = 0

	pub func start = (ref self) {
		Task.future_set_refs(self.future, 2)
		Task.pool_submit(self.task)
	}

	pub func wait = (ref self) {
		if self.future != 0 {
			Task.future_wait(self.future)
			Task.future_release(self.future)
			self.future = 0
			self.result_slot = 0
			self.cancel_flag = 0
		}
	}
}

func join_it = (ref Awaitable a) {
	a.wait()
}

pub func main = () {
	var Channel ch = Channel()
	var r = Runner(produce(ch))
	r.start()
	join_it(ref r)
	var uint64 v = ch.receive()
	Console.write_line(v.to_string())
}
`;
		await build_and_check_output(input, "awaitable_ctor_generic", "42\n", true);
	});

	test("an Awaitable class missing the field contract gets a dedicated error", () => {
		const input = `import System

func work = (out uint64) {
	return 1
}

class Timer : Awaitable {
	pub var uint64 task = 0
}

pub func main = () {
	var t = Timer(work())
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("spawn-field contract");
	});

	test("a non-Awaitable class does not get the sugar", () => {
		const input = `import System

func work = (out uint64) {
	return 1
}

class Fake {
	pub var int x = 0
}

pub func main = () {
	var f = Fake(work())
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});

	test("spawn args are Sendable-validated for user primitives", () => {
		const input = `import System

pub class Counter {
	var int count = 0
}

func bump = (Counter c) {
}

class Job : Awaitable {
	pub var uint64 task = 0
	pub var uint64 result_slot = 0
	pub var uint64 cancel_flag = 0
	pub var uint64 future = 0
}

pub func main = () {
	var Counter c = Counter()
	var j = Job(bump(c))
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("not Sendable");
	});
});
