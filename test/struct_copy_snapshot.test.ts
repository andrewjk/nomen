import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// STRUCT COPY WORD-COUNT: a struct whose body carries a 2-word field (a
// nested two-uint64 struct, a Buffer payload, a {handle, func} binding)
// must copy FULLY on every path — assignment, field store, container
// storage, teardown. Guards the aarch64 struct-copy word count (a copy
// loop that counts FIELDS instead of WORDS under-copies a 2-word field,
// leaving the tail words garbage: huge `length` reads, teardown freeing
// garbage slots, SIGBUS through views).
//
// (The original repro here used `.copy()` on a flat-scalars struct — but a
// struct with nothing to deep-copy soundly byte-copies and gets no
// synthesized `copy` method, so that spelling never compiled. The paths
// below cover the same contract through the copies that DO exist.)
describe("struct copy word count", () => {
	test(
		"value copy of a struct with a 2-word nested field is independent",
		{ timeout: 300000 },
		async () => {
			const input = `
import System

struct Inner {
	var uint64 a = 0
	var uint64 b = 0
}

struct Outer {
	var Inner inner = Inner()
	var int n = 0
}

pub func main = (Init init) {
	var Outer o1 = Outer()
	o1.inner.a = 5
	var Outer o2 = o1
	o2.inner.a = 9
	Console.write_line("\\{o1.inner.a}")
	Console.write_line("\\{o2.inner.a}")
}
`;
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			// o1 untouched → 5; the copy mutated → 9 (a shared-tail under-copy
			// reads 9 for both).
			await build_and_check_output(input, "struct_copy_independent", "5\n9", true, {
				audit: false,
			});
		},
	);

	// The on_click storage shape: a mono List whose element is a 2-word mv
	// struct { uint64 handle, func () action }, assigned in a custom #init,
	// pushed, drained, popped, and torn down under the auditor (a fields-
	// counted copy leaves the cap/count word garbage → SIGABRT in the
	// element-destroy walk).
	test(
		"mono List of 2-word mv elements survives assign/push/drain/pop/teardown",
		{ timeout: 300000 },
		async () => {
			const input = `
import System

mv struct Binding {
	var uint64 handle = 0
	var func () action = Console.write_line

	pub func #init = (self) {
	}
}

pub mv struct Store {
	var List<Binding> list = List<Binding>()
	var int ran = 0

	pub func #init = (self) {
		self.list = List<Binding>()
	}

	pub func add = (ref self, uint64 h, func () a) {
		var Binding b = Binding()
		b.handle = h
		b.action = a
		self.list.push(mv b)
	}

	pub func run_all = (ref self) {
		var int i = 0
		while i < self.list.length {
			var Binding b = self.list.at_or_panic(i)
			b.action()
			self.ran += 1
			i += 1
		}
	}

	pub func pop_one = (ref self) {
		var Binding b = self.list.pop()
		b.action()
	}
}

pub func main = (Init init) {
	var Store s = Store()
	s.add(1, func () { Console.write_line("one") })
	s.add(2, func () { Console.write_line("two") })
	s.run_all()
	Console.write_line("\\{s.ran}")
	s.pop_one()
	Console.write_line("\\{s.list.length}")
}
`;
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			await build_and_check_output(input, "struct_copy_binding_list", "one\ntwo\n2\ntwo\n1", true, {
				audit: true,
			});
		},
	);
});
