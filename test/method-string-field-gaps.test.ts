import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A free function assigning a string parameter to a class field through a
// `ref` param gets the ownership-normalized lowering (`_nomen_strfield`:
// strdup the incoming value, free the displaced one). The same assignment
// written as a STRUCT METHOD on `self` does not — the C backend emits a bare
// `self->current = name;`, so the owning field ends up holding a borrow: a
// rodata literal at the call site, or a caller-owned heap string. The
// auto-generated #destroy then frees it — an invalid free (SIGABRT) for the
// literal, a double free (SIGTRAP) for the heap string.
//
// This is the bug behind every `nomen test --arch c` run reporting
// "test binary exited abnormally (signal SIGABRT)" AFTER all tests pass:
// Tester.begin_test does `self.current = name` (core/System/Test.nm), the
// generated harness main destroys the Tester at exit, and Tester_destroy
// frees the borrowed test name. The aarch64 backend lowers the same method
// correctly (exit 0), so these tests fail on the c arch only.

describe("struct-method string-field assignment: remaining gaps", () => {
	// #1 — a literal argument: the field holds a pointer into rodata, and
	// Holder_destroy's free() aborts at scope exit.
	test("method assigning a string parameter to a self field must not free the borrow on destroy", async () => {
		const input = `import System

pub class Holder {
	var string current = ""

	pub func set_it = (ref self, string name) {
		self.current = name
	}
}

pub func main = () {
	var Holder h = Holder()
	h.set_it("hello")
	Console.write_line(h.current)
}
`;
		await build_and_check_output(input, "gap_method_string_field_literal", "hello\n", true);
	});

	// #2 — a heap-string argument (a function-call result the caller also
	// frees): destroy's free() collides with the call-site cleanup.
	test("method assigning a heap string parameter to a self field must not double-free", async () => {
		const input = `import System

pub class Holder {
	var string current = ""

	pub func set_it = (ref self, string name) {
		self.current = name
	}
}

pub func main = () {
	var Holder h = Holder()
	h.set_it(42.to_string())
	Console.write_line(h.current)
}
`;
		await build_and_check_output(input, "gap_method_string_field_heap", "42\n", true);
	});

	// #3 — the end-to-end Tester shape: exactly what the `nomen test`
	// harness generates (begin_test with a literal name, expect, end_test,
	// destroy at main exit). Expected output is the record prefix up to the
	// nondeterministic ns field of the done record.
	test("the Tester harness (begin_test/expect/end_test + destroy) exits cleanly", async () => {
		const input = `import System
import System/Test

pub func main = () {
	var Tester t = Tester()
	t.begin_test("demo")
	t.expect(1 == 1, "ok")
	t.end_test()
	Console.write_line("done")
}
`;
		await build_and_check_output(
			input,
			"gap_tester_begin_test_destroy",
			"\\nomen|start|demo\n\\nomen|done|demo|1|0|",
			true,
		);
	});
});
