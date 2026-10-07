import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";

// STRUCT_PLAN_3 Phase N N4 — Atomic<T>: a lock-free protected slot for
// 64-bit integer state shared across tasks. A type may be mutated through a
// cross-worker borrowed capture iff the mutated slot is protected — the
// Atomic's methods are the sanctioned path, so the R3 freeze exempts them.

const system = get_library(path.resolve("core"));

function check(source: string) {
	return parse(source, system, undefined, { allow_internal: true }).errors;
}

describe("Atomic: runtime", () => {
	test("fetch_add through a ref-param borrow across tasks (both backends)", async () => {
		const input = `
import System

var Atomic<int> counter = Atomic<int>()

func bump = (ref Atomic<int> c) {
	c.fetch_add(1)
}

pub func main = () {
	async {
		var t = Thread(bump(ref counter)).start()
		t.wait()
	}
	Console.write_line("\\{counter.load()}")
}
`;
		await build_and_check_output(input, "atomic_ref_borrow_bump", "1\n", true);
	});

	test("load/store/swap round-trip (both backends)", async () => {
		const input = `
import System

pub func main = () {
	var Atomic<uint64> slot = Atomic<uint64>()
	slot.store(42)
	var uint64 v = slot.load()
	Console.write_line("\\{v}")
	var uint64 old = slot.swap(7)
	Console.write_line("\\{old}")
	Console.write_line("\\{slot.load()}")
}
`;
		await build_and_check_output(input, "atomic_roundtrip", "42\n42\n7\n", true);
	});

	test("fetch_add returns the previous value (both backends)", async () => {
		const input = `
import System

pub func main = () {
	var Atomic<int> n = Atomic<int>()
	var uint64 a = n.fetch_add(5)
	var uint64 b = n.fetch_add(3)
	Console.write_line("\\{a} \\{b}")
	Console.write_line("\\{n.load()}")
}
`;
		await build_and_check_output(input, "atomic_fetch_add_prev", "0 5\n8\n", true);
	});
});

describe("Atomic: the freeze exempts protected slots", () => {
	test("the donor may mutate a borrowed Atomic through its own methods (N4)", () => {
		const input = `
import System

func work = (ref Atomic<int> c) {
	c.fetch_add(1)
}

pub func main = (Init init) {
	var Atomic<int> counter = Atomic<int>()
	async {
		var t = Thread(work(ref counter)).start()
		t.wait()
		counter.fetch_add(10)
	}
	Console.write_line("done")
}
`;
		expect(check(input)).toEqual([]);
	});

	test("replacing the Atomic itself while borrowed is still frozen", () => {
		const input = `
import System

func work = (ref Atomic<int> c) {
	c.fetch_add(1)
}

pub func main = (Init init) {
	var Atomic<int> counter = Atomic<int>()
	async {
		var t = Thread(work(ref counter)).start()
		counter = Atomic<int>()
		t.wait()
	}
	Console.write_line("done")
}
`;
		const messages = check(input).map((e) => e.message);
		expect(messages.some((m) => m.includes("'counter' is borrowed by a task"))).toBe(true);
	});
});
