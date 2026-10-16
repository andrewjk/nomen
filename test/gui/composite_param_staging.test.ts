import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import build_and_check_output from "../build_and_check_output";

const system = get_library(path.resolve("core"));

// A user `#init` taking a by-ref struct param (Window) and passing it onward
// into a nested constructor call used to stage the param's spill-slot
// ADDRESS as the struct — the nested init read garbage for the window
// handle and crashed in objc_msgSend. build_custom_init_function now
// registers by-address struct params in function_struct_param_slots so
// emit_var_address derefs the slot (mirroring the regular prologue). This
// is the composite-control shape (NumberInput et al).
describe("custom-init struct param staging", () => {
	test("a by-ref struct param passes through nested ctor staging", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub mv struct Card {
	var TextBox title
	pub func #init = (self, Window window, string label) {
		var TextBox t = TextBox(window)
		self.title = mv t
		self.title.set_text(label)
	}
}

pub func main = (Init init) {
	var win = Window("Card", 200, 100)
	var card = Card(win, "card text")
	Console.write_line(card.title.get_text())
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "composite_param_staging", "card text", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("a ctor call nested straight in a field assignment stages correctly", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub mv struct Direct {
	var TextBox box
	pub func #init = (self, Window window) {
		// The direct form: the ctor call sits in the assignment itself (the
		// composite controls use this). It used to stage the Window param's
		// spill-slot address as the struct.
		self.box = TextBox(window)
	}
}

pub func main = (Init init) {
	var win = Window("Direct", 200, 100)
	var d = Direct(win)
	d.box.set_text("nested")
	Console.write_line(d.box.get_text())
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "composite_nested_ctor_assign", "nested", true, {
			platform: "macos",
			audit: false,
		});
	});

	test("float.to_string() after a sibling call on a composite", { timeout: 120000 }, async () => {
		const input = `
import System
import System::Controls

pub mv struct Leaker {
	var TextBox box
	var Stepper step
	pub func #init = (self, Window window) {
		self.box = TextBox(window)
		self.step = Stepper(window)
	}
	pub func show = (ref self, float v) {
		// A raw-block-backed call first, then the float-to-string: the
		// per-body NAME-to-Type map used to leak across struct bodies, so the
		// param inherited a view-string's type and hit the view-only
		// to_string arm (C emitted a view-copy of a double; aarch64 crashed).
		self.step.set_value(v)
		var text = v.to_string()
		self.box.set_text(text)
	}
}

pub func main = (Init init) {
	var win = Window("Leaker", 200, 120)
	var l = Leaker(win)
	l.show(2.5)
	Console.write_line(l.box.get_text())
}
`;
		const parsed = parse(input, system);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "composite_variable_types_leak", "2.500000", true, {
			platform: "macos",
			audit: false,
		});
	});
});
