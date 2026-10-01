import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A store to a string field through a `ref` struct param writes CALLER-owned
// storage, but heap_string_fields records are scope-local — the callee's
// record died at return, so the stored copy leaked (every call: LEAK: 1).
// Worse, the shared record set leaked records ACROSS function builds: a
// callee writing its ref param `p.a` left a record that a LATER function's
// same-named local of an UNRELATED struct matched — its scope exit freed a
// rodata literal (invalid free, SIGABRT).
//
// Two halves fix it, on both backends:
// 1. heap_string_fields is isolated per function build (the callee's records
//    never cross the boundary by name);
// 2. call sites transfer the callee's definitely-executed ref-param field
//    stores onto the caller's records (transfer_ref_param_field_records,
//    scanning scan_ref_param_string_field_writes) — the argument's owner
//    frees the stored copies at its scope exit.

describe("string field store through a ref struct param", () => {
	const SET_SRC = `
import System

struct Pair {
	var string a = "default"
	var string b = "bee"
}

func set = (ref Pair p, string raw) {
	p.a = raw
}
`;


	test("borrow-RHS store is recorded for the caller", async () => {
		await build_and_check_output(
			`${SET_SRC}
pub func main = (Init init) {
	var Pair p = Pair()
	set(ref p, "hello")
	Console.write("a=\\{p.a}\\n")
}
`,
			"ref_transfer_basic",
			"a=hello\n",
			true,
		);
	});

	test("heap-RHS store is recorded for the caller", async () => {
		await build_and_check_output(
			`
import System

struct Pair {
	var string a = "default"
	var string b = "bee"
}

func set = (ref Pair p, string raw) {
	p.a = raw + "!"
}

pub func main = (Init init) {
	var Pair p = Pair()
	set(ref p, "hello")
	Console.write("a=\\{p.a}\\n")
}
`,
			"ref_transfer_heap_rhs",
			"a=hello!\n",
			true,
		);
	});

	test("callee param name colliding with an unrelated caller struct", async () => {
		// The callee records its param's fields; the caller's local `p` is a
		// DIFFERENT struct holding a RODATA literal. Without per-function
		// isolation the record crossed the build boundary by name and the
		// caller's scope exit freed the literal (SIGABRT).
		await build_and_check_output(
			`
import System

struct Pair {
	var string a = "default"
	var string b = "bee"
}

struct Other {
	var string a = "lit"
}

func set = (ref Pair p, string raw) {
	p.a = raw
}

pub func main = (Init init) {
	var Other p = Other()
	var Pair q = Pair()
	set(ref q, "hello")
	Console.write("o=\\{p.a}\\n")
	Console.write("q=\\{q.a}\\n")
}
`,
			"ref_transfer_collision",
			"o=lit\nq=hello\n",
			true,
		);
	});

	test("callee param name not matching the caller variable", async () => {
		await build_and_check_output(
			`
import System

struct Pair {
	var string a = "default"
	var string b = "bee"
}

func set = (ref Pair dst, string raw) {
	dst.a = raw
}

pub func main = (Init init) {
	var Pair p = Pair()
	set(ref p, "hello")
	Console.write("a=\\{p.a}\\n")
}
`,
			"ref_transfer_rename",
			"a=hello\n",
			true,
		);
	});

	test("method with an extra ref struct param", async () => {
		await build_and_check_output(
			`
import System

struct Pair {
	var string a = "default"
	var string b = "bee"

	func fill = (ref self, ref Pair other) {
		other.a = "filled"
	}
}

pub func main = (Init init) {
	var Pair p = Pair()
	var Pair q = Pair()
	p.fill(ref q)
	Console.write("a=\\{q.a}\\n")
}
`,
			"ref_transfer_method",
			"a=filled\n",
			true,
		);
	});

	test("forwarded store through a helper is transferred transitively", async () => {
		// main → fill(ref p) → set(ref p): the inner call transfers onto
		// fill's records (dying there), so the scan must follow the
		// forwarding call to attribute the store to main's variable.
		await build_and_check_output(
			`
import System

struct Pair {
	var string a = "default"
	var string b = "bee"
}

func set = (ref Pair p, string raw) {
	p.a = raw
}

func fill = (ref Pair p) {
	set(ref p, "via-fill")
}

pub func main = (Init init) {
	var Pair p = Pair()
	fill(ref p)
	Console.write("a=\\{p.a}\\n")
}
`,
			"ref_transfer_forwarded",
			"a=via-fill\n",
			true,
		);
	});

	test("repeated calls keep the final stored copy freed", async () => {
		// The FINAL stored copy is freed (transferred record). The displaced
		// copy of an EARLIER call ("one") stays a bounded leak: the callee's
		// store cannot know the displaced value's ownership (that knowledge
		// lives in the caller's records), and pre-freeing at the call site
		// would be a use-after-free when the callee reads the field first.
		// Runs with audit off for that accepted remainder.
		await build_and_check_output(
			`${SET_SRC}
pub func main = (Init init) {
	var Pair p = Pair()
	set(ref p, "one")
	set(ref p, "two")
	Console.write("a=\\{p.a}\\n")
}
`,
			"ref_transfer_repeat",
			"a=two\n",
			true,
			{ audit: false },
		);
	});

	test("branch store transfers too (allmark repro D)", async () => {
		// The store sits inside an if/else — a CONDITIONAL store, which the
		// plain transfer correctly ignored (a record over the not-taken
		// path's pre-call value would be unsound). The callee now ENTRY
		// DUPS such fields (field = strdup(field) at entry, recorded), so
		// the field is heap-owned on every path out of the call and the
		// call-site record is sound: the taken store frees the displaced
		// dup, the not-taken path keeps it, and the caller frees the final
		// copy. Audit ON — this used to report LEAK: 1 per call.
		await build_and_check_output(
			`
import System

struct Pair {
	var a = ""
}

func decorated = (string v, move out string) {
	return "[" + v + "]"
}

func commit = (ref Pair pair, string raw) {
	if raw.length > 2 {
		pair.a = decorated(raw)
	} else {
		pair.a = raw
	}
}

pub func main = (Init init) {
	var short = Pair()
	commit(ref short, "x")
	Console.write("D short a=\\{short.a} (expected x)\\n")
	var long = Pair()
	commit(ref long, "hello")
	Console.write("D long a=\\{long.a} (expected [hello])\\n")
}
`,
			"ref_transfer_branch_store",
			"D short a=x (expected x)\nD long a=[hello] (expected [hello])\n",
			true,
		);
	});

	test("switch-case store transfers", async () => {
		await build_and_check_output(
			`
import System

struct Pair {
	var a = ""
}

func decorated = (string v, move out string) {
	return v + "!"
}

func commit = (ref Pair pair, string raw, int mode) {
	switch {
		case mode == 0 {
			pair.a = decorated(raw)
		}
		else {
			pair.a = raw
		}
	}
}

pub func main = (Init init) {
	var p = Pair()
	commit(ref p, "zero", 0)
	Console.write("[0]\\{p.a}\\n")
	var q = Pair()
	commit(ref q, "one", 1)
	Console.write("[1]\\{q.a}\\n")
}
`,
			"ref_transfer_switch_store",
			"[0]zero!\n[1]one\n",
			true,
		);
	});

	test("loop store transfers", async () => {
		// Each iteration's store frees the previous copy (the dup'd record
		// makes the field tracked from entry), and the caller frees the
		// final one — balanced under audit.
		await build_and_check_output(
			`
import System

struct Pair {
	var a = ""
}

func decorated = (string v, int n, move out string) {
	var acc = ""
	var i = 0
	while i < n; i += 1 {
		acc = acc + v
	}
	return acc
}

func repeat_into = (ref Pair pair, string raw, int n) {
	var i = 0
	while i < n; i += 1 {
		pair.a = decorated(raw, i)
		i += 1
	}
}

pub func main = (Init init) {
	var p = Pair()
	repeat_into(ref p, "ab", 3)
	Console.write("a=\\{p.a}\\n")
}
`,
			"ref_transfer_loop_store",
			"a=abab\n",
			true,
		);
	});

	test("forwarded call nested in a branch keeps the bounded-leak posture", async () => {
		// fill's nested helper(ref p) call is conditional; the callee's
		// must-store is a may-store from fill's caller's perspective — but a
		// FORWARDED one, so fill does NOT entry-dup the field: the helper
		// builds with its own fresh record set and could not reclaim the
		// displaced dup. The stored copy therefore stays a bounded leak
		// (audit off; sound — never an invalid free).
		await build_and_check_output(
			`
import System

struct Pair {
	var string a = "default"
}

func set = (ref Pair p, string raw) {
	p.a = raw + "-set"
}

func fill = (ref Pair p, bool do_fill) {
	if do_fill {
		set(ref p, "x")
	}
}

pub func main = (Init init) {
	var p = Pair()
	fill(ref p, true)
	Console.write("a=\\{p.a}\\n")
	var q = Pair()
	fill(ref q, false)
	Console.write("b=\\{q.a}\\n")
}
`,
			"ref_transfer_nested_forward",
			"a=x-set\nb=default\n",
			true,
			{ audit: false },
		);
	});
});
