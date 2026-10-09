import { expect, describe, test } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";

const system = get_library("core");

// STRUCT_PLAN_3 Phase R, tranche 1: the `#spawn` construction hook on a
// VALUE-STRUCT spawnable (a mv struct). The construction was
// class-shaped in both backends — the C statement expression yielded a
// heap pointer and the aarch64 helper returned a malloc'd instance — which
// crashed against the inline value the declaration side types. The
// value-struct construction yields the instance itself (C) / writes it
// through the sret pointer (aarch64), so a mv struct can carry the
// launch surface `class` used to monopolize.

// A minimal user spawnable: the construction packs the machinery, `start`
// submits the task closure through Task's runtime seam and hands back the
// Task<T> handle (the same shape Thread.start's body uses). `#destroy`
// releases the machinery of a never-started construction, so a dropped
// value is reclaimed instead of leaking (a started value's fields are
// zeroed — its destroy is a no-op).
const SPAWNABLE = `
import System

mv pub struct Job {
	pub var uint64 task = 0
	pub var uint64 result_slot = 0
	pub var uint64 cancel_flag = 0
	pub var uint64 future = 0
	#spawn = () {
	}
	pub func start = (ref self, mv out Task<uint64>) {
		Task.future_set_refs(self.future, 2)
		Task.pool_submit(self.task)
		var t = Task<uint64>()
		t.result_slot = self.result_slot
		t.cancel_flag = self.cancel_flag
		t.future = self.future
		self.task = 0
		self.result_slot = 0
		self.cancel_flag = 0
		self.future = 0
		return t
	}
	pub func #destroy = () {
		if self.future != 0 {
			Task.future_release(self.future)
			self.future = 0
			self.result_slot = 0
			self.cancel_flag = 0
			self.task = 0
		}
	}
}
`;

describe("spawn construction on a mv struct (Phase R)", () => {
	test("deferred-call form constructs, starts, and joins", async () => {
		const input = `
${SPAWNABLE}
func work = (uint64 n, out uint64) {
	return n * 2
}

pub func main = () {
	var j = Job(work(21))
	var h = j.start()
	Console.write_line("\\{h.result()}")
}
`;
		await build_and_check_output(input, "spawn_struct_call_form", "42\n", true);
	});

	test("function-value form constructs, starts, and joins", async () => {
		const input = `
${SPAWNABLE}
pub func main = () {
	var j = Job(() => 7 * 6)
	var h = j.start()
	Console.write_line("\\{h.result()}")
}
`;
		await build_and_check_output(input, "spawn_struct_fnval_form", "42\n", true);
	});

	test("two constructions in one scope carry independent machinery", async () => {
		const input = `
${SPAWNABLE}
func work = (uint64 n, out uint64) {
	return n
}

pub func main = () {
	var a = Job(work(11))
	var b = Job(work(22))
	const x = a.start().result()
	const y = b.start().result()
	Console.write_line("\\{x} \\{y}")
}
`;
		await build_and_check_output(input, "spawn_struct_two_sites", "11 22\n", true);
	});

	test("a string-returning task result survives the value-struct construction", async () => {
		const input = `
import System

mv pub struct Greeter {
	pub var uint64 task = 0
	pub var uint64 result_slot = 0
	pub var uint64 cancel_flag = 0
	pub var uint64 future = 0
	#spawn = () {
	}
	pub func start = (ref self, mv out Task<string>) {
		Task.future_set_refs(self.future, 2)
		Task.pool_submit(self.task)
		var t = Task<string>()
		t.result_slot = self.result_slot
		t.cancel_flag = self.cancel_flag
		t.future = self.future
		self.task = 0
		self.result_slot = 0
		self.cancel_flag = 0
		self.future = 0
		return t
	}
	pub func #destroy = () {
		if self.future != 0 {
			Task.future_release(self.future)
			self.future = 0
			self.result_slot = 0
			self.cancel_flag = 0
			self.task = 0
		}
	}
}

func greet = (string name, out string) {
	return "hi " + name
}

pub func main = () {
	var g = Greeter(greet("ada"))
	var h = g.start()
	Console.write_line("\\{h.result()}")
}
`;
		await build_and_check_output(input, "spawn_struct_string_result", "hi ada\n", true);
	});

	test("a generic mv-struct spawnable monomorphizes", async () => {
		const input = `
import System

	mv pub struct Job<T> {
		pub var uint64 task = 0
		pub var uint64 result_slot = 0
		pub var uint64 cancel_flag = 0
		pub var uint64 future = 0
		#spawn = () {
		}
		pub func start = (ref self, mv out Task<T>) {
			Task.future_set_refs(self.future, 2)
			Task.pool_submit(self.task)
			var t = Task<T>()
			t.result_slot = self.result_slot
			t.cancel_flag = self.cancel_flag
			t.future = self.future
			self.task = 0
			self.result_slot = 0
			self.cancel_flag = 0
			self.future = 0
			return t
		}
		pub func #destroy = () {
			if self.future != 0 {
				Task.future_release(self.future)
				self.future = 0
				self.result_slot = 0
				self.cancel_flag = 0
				self.task = 0
			}
		}
	}

func work = (uint64 n, out uint64) {
	return n + 1
}

pub func main = () {
	var j = Job<uint64>(work(41))
	var h = j.start()
	Console.write_line("\\{h.result()}")
}
`;
		await build_and_check_output(input, "spawn_struct_generic", "42\n", true);
	});

	test("an unstarted construction is reclaimed at scope exit", async () => {
		const input = `
${SPAWNABLE}
func work = (out uint64) {
	return 5
}

pub func main = () {
	// A bare nested block is not statement syntax — an if scopes the
	// construction: the instance's #destroy releases the machinery when
	// the branch exits.
	if true {
		var j = Job(work())
		Console.write_line("packed")
	}
	Console.write_line("done")
}
`;
		await build_and_check_output(input, "spawn_struct_unstarted_destroy", "packed\ndone\n", true);
	});

	test("a fresh construction is a real expression: receiver of .start()", async () => {
		const input = `
${SPAWNABLE}
func work = (out uint64) {
	return 9
}
pub func main = () {
	var h = Job(work()).start()
	Console.write_line("\\{h.result()}")
}
`;
		await build_and_check_output(input, "spawn_struct_expr_receiver", "9\n", true);
	});

	test("a fresh construction passes to a mv param", async () => {
		const input = `
${SPAWNABLE}
func work = (out uint64) {
	return 9
}
func launch = (mv Job j, mv out Task<uint64>) {
	return j.start()
}
pub func main = () {
	var h = launch(Job(work()))
	Console.write_line("\\{h.result()}")
}
`;
		await build_and_check_output(input, "spawn_struct_expr_arg", "9\n", true);
	});

	test("a plain struct (no #spawn) still constructs ordinarily", () => {
		const input = `
import System

mv pub struct Plain {
	pub var uint64 v = 0
	pub func #init = (self, uint64 n) {
		self.v = n
	}
}

pub func main = () {
	var p = Plain(3)
	Console.write_line("\\{p.v}")
}
`;
		const parsed = parse(input, system, undefined, { allow_user_raw: true, allow_internal: true });
		expect(parsed.errors).toEqual([]);
	});
});
