import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// A class's plain string fields are heap-owned (freed by reassignment's
// `free(self->field.ptr)` and by <Class>_destroy). A LITERAL default stored
// raw into the field is static rodata — freeing it aborts. The init must dup
// the default (both backends).

describe("class string field literal defaults", () => {
	test("default is dup'd; init reassignment does not free rodata", async () => {
		const input = `
import System

class Buffer2 {
	pub var string content = ""
	pub var bool ready = false

	pub func #init = (ref self) {
		self.ready = true
	}

	pub func set = (ref self, string s) {
		self.content = s
	}
}

pub func main = (Init init) {
	var b = Buffer2()
	b.set("hello")
	Console.write("\\{b.content} \\{b.ready}\\n")
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(
			input,
			"class_string_default_reassign",
			"hello true\ndone\n",
			true,
		);
	});

	test("instance that never reassigns the field survives destroy", async () => {
		const input = `
import System

class LitOnly {
	pub var string tag = "static-default"

	pub func #init = (ref self) {
	}
}

pub func main = (Init init) {
	var l = LitOnly()
	Console.write("\\{l.tag}\\n")
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(
			input,
			"class_string_default_destroy",
			"static-default\ndone\n",
			true,
		);
	});
});
