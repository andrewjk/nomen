import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A string RETURNED through a func-typed VALUE (`f()`, `s.render()`) is only
// ever produced by an indirect call, whose callee classification the call site
// cannot see. Both producers normalize their string returns to OWNED heap —
// closures dup borrow returns at their return boundary (build_return_node) and
// named-function thunks dup a borrow return (materialize_func_value_a64) — so
// the call site may free every func-value string result (FOLLOWUP
// "Heap return temp of an indirect call leaks when consumed by an operation").
// Before the fix, a class func field holding a heap-string-returning lambda
// leaked its result on aarch64.

describe("func-value string returns are owned", () => {
	test("a heap-string-returning lambda in a class func field is freed", async () => {
		await build_and_check_output(
			`
import System

class Rule {
	var func (string, out string) render
}

pub func main = () {
	var string prefix = "L> "
	var Rule r = Rule((s, out string) => prefix + s)
	Console.write_line(r.render("body"))
}
`,
			"funcval_string_heap_field",
			"L> body\n",
			true,
		);
	});

	test("a borrowed capture returned from a field lambda is dup'd", async () => {
		await build_and_check_output(
			`
import System

class Rule {
	var func (string, out string) render
}

pub func main = () {
	var string prefix = "L> "
	var Rule r = Rule((s, out string) => prefix)
	Console.write_line("\\{r.render("x")}")
}
`,
			"funcval_string_borrow_field",
			"L> \n",
			true,
		);
	});

	test("a borrowed capture consumed by an op inside the callee is dup'd", async () => {
		await build_and_check_output(
			`
import System

struct Shout {
	func exclaim = (self, func (out string) f, out string) { return f() + "!" }
}

pub func main = () {
	var string prefix = "L> "
	var Shout s = Shout()
	Console.write_line("\\{s.exclaim((out string) => prefix)}")
}
`,
			"funcval_string_borrow_param_op",
			"L> !\n",
			true,
		);
	});

	test("a trait-dispatched borrow returned from a lambda is dup'd", async () => {
		await build_and_check_output(
			`
import System

trait Show {
	func show = (self, out string)
}

class Dog : Show {
	var string name
	func show = (self, out string) => self.name
}

pub func main = () {
	var Show s = Dog("Rex")
	var func (out string) get = (out string) => s.show()
	Console.write_line("\\{get() + "!"}")
}
`,
			"funcval_string_trait_borrow",
			"Rex!\n",
			true,
		);
	});

	test("a named function value returning a param borrow is dup'd by its thunk", async () => {
		await build_and_check_output(
			`
import System

func greet = (string whom, out string) { return whom }

struct Shout {
	func exclaim = (self, func (string, out string) f, out string) { return f("x") + "!" }
}

pub func main = () {
	var Shout s = Shout()
	Console.write_line("\\{s.exclaim(greet)}")
}
`,
			"funcval_string_named_thunk",
			"x!\n",
			true,
		);
	});
});
