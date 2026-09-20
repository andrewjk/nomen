import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A custom `#init` starts from a fresh `malloc` — the instance's fields hold
// garbage until first written. The first `self.<field> = ...` in an init
// body must NOT run the displaced-value destroy/free (it would reclaim
// uninitialized memory: instant UB on construction). Later writes in the
// same init DO displace a real value and reclaim normally, and a field with
// a declared default holds a real value before the body — its first write
// reclaims the default.

describe("custom #init field assignment ownership (runtime, both backends)", () => {
	test("first write to a move class field skips the displaced reclaim", async () => {
		await build_and_check_output(
			`
import System

pub class Inner {
	pub var int v = 0
}

pub class Outer {
	pub move Inner inner
	pub var string name

	pub func #init = (self) {
		self.inner = Inner()
		self.name = "x"
	}
}

pub func main = (Init init) {
	var Outer o = Outer()
	Console.write("\\{o.inner.v} \\{o.name}")
}
`,
			"init_first_write_move_field",
			"0 x",
			true,
		);
	});

	test("second write to a field reclaims the displaced value", async () => {
		await build_and_check_output(
			`
import System

pub class Twice {
	pub var string name = "start"

	pub func #init = (self) {
		self.name = "a"
		self.name = "b"
	}
}

pub func main = (Init init) {
	var Twice t = Twice()
	Console.write(t.name)
}
`,
			"init_second_write_reclaims",
			"b",
			true,
			{ audit: true },
		);
	});
});
