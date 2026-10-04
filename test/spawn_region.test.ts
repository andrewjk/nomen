import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import test_error from "./test_error";

// STRUCT_PLAN_3 Phase N tranche 1 — checked region borrows at the task
// boundary (src/check/utils/spawn_region.ts):
//   - N1a R2 / N1b E3: inside an `async { }` block, a SHARED class/trait
//     spawn argument's root must outlive the join (declared in the block's
//     own scope or outside it); fresh temporaries must be constructed in the
//     block's own scope.
//   - N2 / R4: detach owns its captures — `.detach()` rejects every
//     non-`move` class/trait argument (globals exempt; process lifetime).

const system = get_library(path.resolve("core"));

function check(source: string) {
	return parse(source, system, undefined, { allow_internal: true }).errors;
}

const sendable_class = `
pub class Job : Sendable {
	var int n
}

func work = (Job j) {
	Console.write_line("\\{j.n}")
}
`;

describe("spawn region: the root rule (R2/E3)", () => {
	test("a donor declared in a loop body inside async is rejected", () => {
		const input = `
import System
${sendable_class}
pub func main = (Init init) {
	async {
		var int i = 0
		while i < 2 {
			var Job inner = Job(i)
			var t = Thread(work(inner)).start()
			t.wait()
			i = i + 1
		}
	}
}
`;
		const errors = check(input);
		expect(errors).toEqual([
			test_error(
				input,
				"'inner' does not outlive the task — the join at 'async' happens after 'inner's scope ends; declare 'inner' in the 'async' block's scope or outside it, or move it in ('move inner')",
				17,
				24,
			),
		]);
	});

	test("a donor declared in the async block's own scope is accepted", () => {
		const input = `
import System
${sendable_class}
pub func main = (Init init) {
	async {
		var Job outer = Job(7)
		var t = Thread(work(outer)).start()
		t.wait()
	}
}
`;
		expect(check(input)).toEqual([]);
	});

	test("a donor declared outside the async block is accepted", () => {
		const input = `
import System
${sendable_class}
pub func main = (Init init) {
	var Job outer = Job(7)
	async {
		var t = Thread(work(outer)).start()
		t.wait()
	}
}
`;
		expect(check(input)).toEqual([]);
	});

	test("a fresh class temporary constructed inside a nested block is rejected", () => {
		const input = `
import System
${sendable_class}
pub func main = (Init init) {
	async {
		var int i = 0
		while i < 2 {
			var t = Thread(work(Job(i))).start()
			t.wait()
			i = i + 1
		}
	}
}
`;
		const errors = check(input);
		expect(
			errors.some((e) =>
				e.message.includes("this task shares a temporary Job that dies before the 'async' join"),
			),
		).toBe(true);
	});

	test("a fresh class temporary constructed in the block's own scope is accepted", () => {
		const input = `
import System
${sendable_class}
pub func main = (Init init) {
	async {
		var t = Thread(work(Job(3))).start()
		t.wait()
	}
}
`;
		expect(check(input)).toEqual([]);
	});

	test("a moved argument is exempt (ownership has no region)", () => {
		const input = `
import System
pub class Job {
	var int n
}
func consume = (move Job j) {
	Console.write_line("\\{j.n}")
}
pub func main = (Init init) {
	async {
		var int i = 0
		while i < 2 {
			var Job inner = Job(i)
			var t = Thread(consume(move inner)).start()
			t.wait()
			i = i + 1
		}
	}
}
`;
		expect(check(input)).toEqual([]);
	});

	test("a scalar argument is exempt", () => {
		const input = `
import System
func workn = (int n) {
	Console.write_line("\\{n}")
}
pub func main = (Init init) {
	async {
		var int i = 0
		while i < 2 {
			var int inner = i
			var t = Thread(workn(inner)).start()
			t.wait()
			i = i + 1
		}
	}
}
`;
		expect(check(input)).toEqual([]);
	});

	test("a non-Sendable class still reports the Sendable error (not the region error)", () => {
		const input = `
import System
pub class Job {
	var int n
}
func work = (Job j) {
	Console.write_line("\\{j.n}")
}
pub func main = (Init init) {
	async {
		var int i = 0
		while i < 2 {
			var Job inner = Job(i)
			var t = Thread(work(inner)).start()
			t.wait()
			i = i + 1
		}
	}
}
`;
		const messages = check(input).map((e) => e.message);
		expect(messages.some((m) => m.includes("is not Sendable"))).toBe(true);
		expect(messages.some((m) => m.includes("does not outlive the task"))).toBe(false);
	});

	test("a spawn outside any async block is not region-checked", () => {
		const input = `
import System
${sendable_class}
pub func main = (Init init) {
	var int i = 0
	while i < 2 {
		var Job inner = Job(i)
		var t = Thread(work(inner)).start()
		t.wait()
		i = i + 1
	}
}
`;
		expect(check(input)).toEqual([]);
	});
});

describe("spawn region: detach owns its captures (N2/R4)", () => {
	test("a shared class argument to a daemon is rejected", () => {
		const input = `
import System
${sendable_class}
pub func main = (Init init) {
	var Job g = Job(1)
	Thread(work(g)).detach()
}
`;
		expect(check(input)).toEqual([
			test_error(
				input,
				"detached task captures 'g' by reference — detach owns its captures; move it in ('move g'), or spawn it into a nursery that outlives the use",
				14,
				14,
			),
		]);
	});

	test("a moved class argument to a daemon is accepted", () => {
		const input = `
import System
pub class Job {
	var int n
}
func consume = (move Job j) {
	Console.write_line("\\{j.n}")
}
pub func main = (Init init) {
	var Job g = Job(1)
	Thread(consume(move g)).detach()
}
`;
		expect(check(input)).toEqual([]);
	});

	test("a global donor is exempt (process lifetime)", () => {
		const input = `
import System
${sendable_class}
var Job g = Job(1)
pub func main = (Init init) {
	Thread(work(g)).detach()
}
`;
		expect(check(input)).toEqual([]);
	});

	test("a scalar/string argument is accepted", () => {
		const input = `
import System
func daemon = (int n, string tag) {
	Console.write_line("\\{tag}: \\{n}")
}
pub func main = (Init init) {
	var int n = 1
	Thread(daemon(n, "tag")).detach()
}
`;
		expect(check(input)).toEqual([]);
	});

	test("a closure-form class capture is rejected", () => {
		const input = `
import System
${sendable_class}
pub func main = (Init init) {
	var Job g = Job(1)
	Thread(() => work(g)).detach()
}
`;
		const messages = check(input).map((e) => e.message);
		expect(messages.some((m) => m.includes("detached task captures 'g' by reference"))).toBe(true);
	});

	test("a Fiber daemon is held to the same rule", () => {
		const input = `
import System
${sendable_class}
pub func main = (Init init) {
	var Job g = Job(1)
	Fiber(work(g)).detach()
}
`;
		const messages = check(input).map((e) => e.message);
		expect(messages.some((m) => m.includes("detached task captures 'g' by reference"))).toBe(true);
	});

	test("a detached task with no shared arguments is accepted", () => {
		const input = `
import System
func daemon = () {
	Console.write_line("up")
}
pub func main = (Init init) {
	Thread(daemon()).detach()
}
`;
		expect(check(input)).toEqual([]);
	});
});

describe("spawn region: owning-struct borrows + the freeze (R1/R3, tranche 2)", () => {
	const owning_case = `
import System

pub func main = (Init init) {
	var List<int> xs = List<int>()
	xs.push(4)
	async {
		%s
	}
}

func len = (List<int> items, out int) {
	return items.length
}
`;

	test("an owning struct bare inside async is a region-checked borrow (accepted)", () => {
		const input = owning_case.replace(
			"%s",
			'var t = Thread(len(xs)).start()\n\t\tConsole.write_line("\\{t.result()}")',
		);
		expect(check(input)).toEqual([]);
	});

	test("an owning struct bare outside async is rejected (no join, no sound copy)", () => {
		const input = `
import System

pub func main = (Init init) {
	var List<int> xs = List<int>()
	xs.push(4)
	var t = Thread(len(xs)).start()
	Console.write_line("\\{t.result()}")
}

func len = (List<int> items, out int) {
	return items.length
}
`;
		const messages = check(input).map((e) => e.message);
		expect(messages.some((m) => m.includes("owns heap memory"))).toBe(true);
	});

	test("an owning donor in a loop body inside async is rejected (root rule)", () => {
		const input = `
import System

pub func main = (Init init) {
	async {
		var int i = 0
		while i < 2 {
			var List<int> xs = List<int>()
			var t = Thread(len(xs)).start()
			t.wait()
			i = i + 1
		}
	}
}

func len = (List<int> items, out int) {
	return items.length
}
`;
		const messages = check(input).map((e) => e.message);
		expect(messages.some((m) => m.includes("does not outlive the task"))).toBe(true);
	});

	test("the freeze: a mutating call on the donor after the construction errors", () => {
		const input = owning_case.replace(
			"%s",
			'var t = Thread(len(xs)).start()\n\t\txs.push(5)\n\t\tConsole.write_line("\\{t.result()}")',
		);
		const messages = check(input).map((e) => e.message);
		expect(messages.some((m) => m.includes("'xs' is borrowed by a task"))).toBe(true);
	});

	test("the freeze: mutating BEFORE the construction is fine", () => {
		const input = owning_case.replace(
			"%s",
			'xs.push(5)\n\t\tvar t = Thread(len(xs)).start()\n\t\tConsole.write_line("\\{t.result()}")',
		);
		expect(check(input)).toEqual([]);
	});

	test("the freeze: moving the donor out errors", () => {
		const input = owning_case.replace(
			"%s",
			"var t = Thread(len(xs)).start()\n\t\tmove List<int> stolen = xs",
		);
		const messages = check(input).map((e) => e.message);
		expect(messages.some((m) => m.includes("'xs' is borrowed by a task"))).toBe(true);
	});

	test("the freeze: mutable-passing the donor errors", () => {
		const input = `
import System

pub func main = (Init init) {
	var List<int> xs = List<int>()
	async {
		var t = Thread(len(xs)).start()
		consume(move xs)
		t.wait()
	}
}

func len = (List<int> items, out int) {
	return items.length
}

func consume = (move List<int> items) {
	Console.write_line("\\{items.length}")
}
`;
		const messages = check(input).map((e) => e.message);
		expect(messages.some((m) => m.includes("'xs' is borrowed by a task"))).toBe(true);
	});

	test("a Task handle shared into a task can still be cancelled (protocol exemption)", () => {
		const input = `
import System

func work = (uint64 n, out uint64) {
	return n
}

pub func main = (Init init) {
	async {
		var t = Thread(work(1)).start()
		var f = Fiber(waiter(t)).start()
		t.cancel()
		f.wait()
	}
}

func waiter = (Task<uint64> handle) {
	ref f = handle
	f.cancel()
}
`;
		expect(check(input)).toEqual([]);
	});
});

describe("spawn region: borrowed owning args at runtime (R1, both backends)", () => {
	test("a task reads the donor's List through the env borrow", async () => {
		const input = `
func sum = (List<int> items, out int) {
	var int total = 0
	for x of items {
		total = total + x
	}
	return total
}

var List<int> xs = List<int>()

xs.push(4)
xs.push(5)
async {
	var t = Thread(sum(xs)).start()
	Console.write_line("\\{t.result()}")
}
`;
		await build_and_check_output(input, "spawn_region_borrow_list", "9\n");
	});
});
