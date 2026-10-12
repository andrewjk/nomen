import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A local OWNING string that is conditionally MOVED OUT by a `return` inside
// a branch, while an alternate return path does not move it: the not-moved
// paths leaked the local's heap allocation on both backends. The transfer
// sites used STATIC records (the aarch64 `moved` set / the C frame splice),
// which suppressed the free on every later path — but at runtime only the
// branch that executed the return transferred ownership.
//
// Both backends now carry a runtime "moved" flag for owning string locals
// (the same conditional-move contract as owning `mv` structs,
// c_mv_owns_flags / mv_owns_flag): the return site sets it, and every
// cleanup (sibling returns, break/continue, the fall-through tail) frees
// under `flag == 0`.
//
// - aarch64: mark_heap_string allocates the flag next to the string slot;
//   the string-return marks it via mark_local_moved_flag;
//   emit_moved_local_cleanup and the loop-depth walk free under the guard.
// - C: the declaration emits `unsigned char _mv_owns_<name> = 0;` and KEEPS
//   the declaration in its scope frame at the return (setting the flag)
//   instead of splicing it; the auto-free is guarded on the flag.

describe("conditional return of a local owning string", () => {
	const SRC = `
import System

func decode = (bool b, mv out string) {
	const string named = "".to_string()
	if b {
		return named
	}
	return "y"
}

pub func main = (Init init) {
	const bool b = (Time.now_ms() % 2) == 3
	const string d = decode(b)
	Console.write_line("len=\\{d.length}")
}
`;

	test("not-moved return path frees the local", async () => {
		await build_and_check_output(SRC, "cond_return_string_leak", "len=1\n", true);
	});

	test("taken move path transfers without a double free", async () => {
		const input = `
import System

func decode = (bool b, mv out string) {
	const string named = "".to_string()
	if b {
		return named
	}
	return "y"
}

pub func main = (Init init) {
	const bool b = (Time.now_ms() % 2) != 3
	const string d = decode(b)
	Console.write_line("len=\\{d.length}")
}
`;
		await build_and_check_output(input, "cond_return_string_moved", "len=0\n", true);
	});

	test("loop continue path frees the not-moved local", async () => {
		const input = `
import System

func first_long = (ref List<string> items, out string) {
	var i = 0
	while i < items.length {
		const string s = items.at_or_panic(i).to_lowercase()
		if s.length > 3 {
			return s
		}
		i += 1
		continue
	}
	return "none"
}

pub func main = (Init init) {
	var items = List<string>()
	items.push("ab".to_string())
	items.push("cd".to_string())
	const string f = first_long(ref items)
	Console.write_line("f=\\{f}")
}
`;
		await build_and_check_output(input, "cond_return_string_continue", "f=none\n", true);
	});

	test("loop take path transfers the moved local", async () => {
		const input = `
import System

func first_long = (ref List<string> items, out string) {
	var i = 0
	while i < items.length {
		const string s = items.at_or_panic(i).to_lowercase()
		if s.length > 3 {
			return s
		}
		i += 1
		continue
	}
	return "none"
}

pub func main = (Init init) {
	var items = List<string>()
	items.push("abcd".to_string())
	const string f = first_long(ref items)
	Console.write_line("f=\\{f}")
}
`;
		await build_and_check_output(input, "cond_return_string_take", "f=abcd\n", true);
	});
});
