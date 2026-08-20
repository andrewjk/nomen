import { expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Regression tests for the FOLLOWUP.md issues "Reassigning a string to a bare
// literal stores rodata, then scope-exit free aborts" and "`String.set` traps
// on aarch64".

async function build_and_run(input: string, name: string, expected: string, audit = true) {
	for (const arch of ["aarch64", "c"] as const) {
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch, audit });
		await check_output(name, result, expected, { arch, audit });
	}
}

// A `var string` initialized with a literal is heap-owned at declaration, but
// reassigning it to a bare literal stored the raw rodata pointer while the
// scope-exit auto_free still freed it (an invalid free / abort at exit).
test("reassigning a string to a bare literal keeps heap ownership", async () => {
	const input = `
var string s = "abcdef"
var int total = 0
while s.length > 3 {
	s = "abc"
	total += 1
}
Console.write(total.to_string())
Console.write(s)
`;
	await build_and_run(input, "literal_reassign_loop", "1abc");
});

// Same ownership rule at the top level (no loop): the reassigned literal
// must still be freed exactly once at scope exit.
test("reassigning a string to a bare literal at top level", async () => {
	const input = `
var string s = "abcdef"
s = "xy"
Console.write(s)
`;
	await build_and_run(input, "literal_reassign_top", "xy");
});

// Reassigning to a literal AFTER a heap value must not leak the fresh copy
// (each iteration frees the previous one).
test("repeated literal reassignment does not accumulate allocations", async () => {
	const input = `
var string s = "abcdef"
var int i = 0
while i < 5 {
	s = "abc"
	i += 1
}
Console.write(s)
`;
	await build_and_run(input, "literal_reassign_repeated", "abc");
});

// A `ref string` param reassigned to a literal inside the callee writes
// through to the caller's storage. The caller's scope-exit free is only
// valid when the callee stores an owned copy, so the literal is strdup'd.
// The displaced old value conservatively leaks (the callee can't know
// whether the caller's slot was owned — conditional writes make an eager
// free unsound), mirroring drop_self_written_string_field_records; hence
// no leak audit for this shape.
test("callee reassigning a ref string param to a literal", async () => {
	const input = `
func truncate_in_place = (ref string s) {
	s = "xy"
}
var string s = "abcdef"
truncate_in_place(ref s)
Console.write(s)
`;
	await build_and_run(input, "ref_param_literal", "xy", false);
});

// The same shape with a heap-owned caller value (a call result): previously
// aborted at the caller's scope-exit free on both backends.
test("callee reassigning a ref string param over a heap-owned value", async () => {
	const input = `
func truncate_in_place = (ref string s) {
	s = "xy"
}
var string s = 1.to_string() + "abcdef"
truncate_in_place(ref s)
Console.write(s)
`;
	await build_and_run(input, "ref_param_heap_owned", "xy", false);
});

// `String.set` is a `ref self` method: the call site must pass the
// receiver's slot by reference (C: `string_set(&s, ...)`; aarch64: &slot with
// the callee's x19 holding the loaded char*), and an aarch64 literal
// initializer must be heap-forced so the buffer is writable.
test("String.set mutates characters in place", async () => {
	const input = `
var string s = "abc"
var int i = 0
while i < s.length {
	s.set(i, 'x')
	i += 1
}
Console.write(s)
`;
	await build_and_run(input, "string_set_in_place", "xxx");
});

// A heap-initialized receiver (no force-heap analysis needed) must also
// mutate cleanly.
test("String.set on a heap-initialized string", async () => {
	const input = `
var string s = "abc" + "def"
var int i = 0
while i < s.length {
	s.set(i, 'X')
	i += 1
}
Console.write(s)
`;
	await build_and_run(input, "string_set_heap", "XXXXXX");
});
