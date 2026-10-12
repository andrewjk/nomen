import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("List element Box fields", () => {
	// FOLLOWUP repro (2026-10-12): a List<Ship> whose element holds a
	// Box<Engine> field — load_T's deep-copy covered List/Buffer fields only,
	// so the element's Box came back shallow; the copy's scope-exit destroy
	// freed the slot's shared wrapper and the next use crashed (SIGTRAP, both
	// backends).
	test("at_or_panic loads an independent Box field", async () => {
		const input = `
mv struct Engine {
  var int rpm
}

mv struct Ship {
  var Box<Engine> engine
  var string name
}

var List<Ship> ships = List<Ship>()
ships.push(Ship(Box<Engine>(Engine(42)), "Ada"))
var Ship s = ships.at_or_panic(0)
Console.write("\\{s.engine.rpm} \\{s.name}")
var Ship again = ships.at_or_panic(0)
Console.write("\\{again.engine.rpm} \\{again.name}")
`;
		await build_and_check_output(input, "list_box_field_load", "42 Ada42 Ada");
	});

	test("storing a loaded element keeps both wrappers alive", async () => {
		const input = `
mv struct Engine {
  var int rpm
}

mv struct Ship {
  var Box<Engine> engine
  var string name
}

var List<Ship> ships = List<Ship>()
ships.push(Ship(Box<Engine>(Engine(7)), "Bee"))
var Ship s = ships.at_or_panic(0)
s.engine.rpm = 99
var int i = 0
if i >= 0 && i < ships.length {
  ships.set(i, mv s)
}
var Ship check = ships.at_or_panic(0)
Console.write("\\{check.engine.rpm} \\{check.name}")
`;
		await build_and_check_output(input, "list_box_field_roundtrip", "99 Bee");
	});

	// A `Box<string>` pointee: the wrapper owns its string bytes (the ctor
	// strdup'd them; the destroy frees them), so the clone must strdup too.
	test("Box<string> element field", async () => {
		const input = `
mv struct Config {
  var Box<string> label
  var int weight
}

var List<Config> configs = List<Config>()
configs.push(Config(Box<string>("alpha"), 1))
var Config c = configs.at_or_panic(0)
Console.write("\\{c.label} \\{c.weight}")
var Config again = configs.at_or_panic(0)
Console.write("\\{again.label} \\{again.weight}")
`;
		await build_and_check_output(input, "list_box_string_pointee", "alpha 1alpha 1");
	});

	// A nested box (the pointee itself holds a `Box<T>` field): the clone
	// recurses through its own helper.
	test("nested Box pointee field", async () => {
		const input = `
mv struct Inner {
  var int depth
}

mv struct Middle {
  var Box<Inner> inner
}

mv struct Outer {
  var Box<Middle> middle
  var string tag
}

var List<Outer> outers = List<Outer>()
outers.push(Outer(Box<Middle>(Middle(Box<Inner>(Inner(3)))), "root"))
var Outer o = outers.at_or_panic(0)
Console.write("\\{o.middle.inner.depth} \\{o.tag}")
var Outer again = outers.at_or_panic(0)
Console.write("\\{again.middle.inner.depth} \\{again.tag}")
`;
		await build_and_check_output(input, "list_box_nested_pointee", "3 root3 root");
	});
});
