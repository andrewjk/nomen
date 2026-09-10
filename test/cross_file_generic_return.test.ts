import path from "node:path";

import { expect, test } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

/**
 * Element type of a cross-file generic return must not depend on merge order.
 *
 * The program is split the way `join` concatenates it: the ENTRY file (with
 * `main`) first, the callee's file later, and the System library appended
 * after both by parse(). The callee's `out List<Diff>` annotation used to be
 * instantiated only during the callee's own check — so a `const diffs =
 * combined(a, b)` binding in the entry resolved `.at()` against the bare
 * generic (`out T`), and the first element-typed access degraded
 * order-dependently ("Field not found: moved" + "condition must be a bool,
 * not <empty>"). The mono instantiation is now flowed at call-resolution
 * time and materialized on demand at member-access sites, so both merge
 * orders check clean.
 */

const callee_file = `
// file://src/combined.nm
pub class Diff {
	var moved = false
}

pub func combined = (string a, string b, out List<Diff>) {
	var List<Diff> d = List<Diff>()
	if a == b {
		var Diff e = Diff()
		e.moved = true
		d.push(move e)
	}
	return d
}
`;

const entry_file = `
// file://test/main.test.nm
import System

pub func main = (Init init) {
	const diffs = combined("a", "a")
	var int i = 0
	while i < diffs.length {
		if diffs.at(i).moved {
			Console.write_line("moved")
		} else {
			Console.write_line("not moved")
		}
		i += 1
	}
}
`;

const user_generic_callee_file = `
// file://src/holder.nm
pub struct Holder<T> {
	var T value

	pub func get = (self, out T) {
		return self.value
	}
}

pub func make_holder = (int v, out Holder<int>) {
	var Holder<int> h = Holder<int>(v)
	return h
}
`;

const user_generic_entry_file = `
// file://test/main.test.nm
import System

pub func main = (Init init) {
	const h = make_holder(41)
	const v = h.get()
	var int doubled = v + v
	Console.write_line("\\{doubled}")
}
`;

function check_merged(callee: string, entry: string) {
	// Entry first, callee later — the shape of a `*.test.nm` compile (or any
	// merge where the callee's file trails the calling one).
	return parse(entry + "\n" + callee, system);
}

test("cross-file generic return -- element type resolves in entry-first merge order", () => {
	const parsed = check_merged(callee_file, entry_file);
	expect(parsed.errors).toEqual([]);
});

test("cross-file generic return -- element type resolves in callee-first merge order", () => {
	const parsed = check_merged(callee_file, entry_file);
	const flipped = parse(callee_file + "\n" + entry_file, system);
	expect(parsed.errors).toEqual(flipped.errors);
	expect(flipped.errors).toEqual([]);
});

test("cross-file user-declared generic return -- element type resolves regardless of merge order", () => {
	const entry_first = check_merged(user_generic_callee_file, user_generic_entry_file);
	expect(entry_first.errors).toEqual([]);
	const callee_first = parse(user_generic_callee_file + "\n" + user_generic_entry_file, system);
	expect(callee_first.errors).toEqual([]);
});
