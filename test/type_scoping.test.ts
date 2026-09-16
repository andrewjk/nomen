import { expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

/**
 * Same-named type declarations in different scopes (and same-named nested vs
 * top-level types) must not poison the build's flat type table. A nested type
 * that collides with another declared name gets a scope-unique emission label
 * (`<enclosing function>_<name>`) so its symbols and monomorphizations are
 * distinct, while references inside its function body resolve to it and
 * references outside resolve to the top-level type.
 */

test("sibling nested structs with the same name resolve per scope", async () => {
	const src = `
import System

struct Box {
	var int a = 1
	var int b = 2
}

func f = (out int) {
	struct Box {
		var int x = 10
		var int y = 20
	}
	var Box b = Box()
	return b.y
}

func g = (out int) {
	struct Box {
		var int p = 30
		var int q = 40
	}
	var Box b = Box()
	return b.q
}

pub func main = (Init init) {
	var Box top = Box()
	Console.write("\\{f()}\\{g()}\\{top.b}\\n")
}
`;
	expect(parse_raw(src).errors).toEqual([]);
	await build_and_check_output(src, "type_scoping_structs", "20402\n", true);
});

test("nested generic type and List of the top-level struct do not collide", async () => {
	const src = `
import System

struct Box {
	var int n = 7
}

func use = (out int) {
	struct Box<T> {
		var T value
	}
	var Box<int> b = Box<int>(42)
	return b.value
}

pub func main = (Init init) {
	var List<Box> boxes = List<Box>()
	boxes.push(Box())
	Console.write("\\{use()}\\{boxes.length}\\{Box().n}\\n")
}
`;
	expect(parse_raw(src).errors).toEqual([]);
	await build_and_check_output(src, "type_scoping_generic", "4217\n", true);
});

test("sibling nested bitsets with the same name resolve per scope", async () => {
	const src = `
import System

func f = (out bool) {
	bitset Flags {
		case read
		case write
	}
	var Flags x = Flags.write
	return (x & Flags.read) == Flags.read
}

func g = (out bool) {
	bitset Flags {
		case read
		case write
		case exec
	}
	var Flags x = Flags.exec
	return (x & Flags.exec) == Flags.exec
}

pub func main = (Init init) {
	Console.write("\\{f()}-\\{g()}\\n")
}
`;
	expect(parse_raw(src).errors).toEqual([]);
	await build_and_check_output(src, "type_scoping_bitsets", "false-true\n", true);
});

test("sibling nested enums with the same name resolve per scope", async () => {
	const src = `
import System

func f = (out string) {
	enum Color {
		case red
		case green
	}
	var Color c = Color.green
	return match c {
		case .green -> "green"
		case .red -> "red"
	}
}

func g = (out string) {
	enum Color {
		case blue
		case yellow
	}
	var Color c = Color.yellow
	return match c {
		case .yellow -> "yellow"
		case .blue -> "blue"
	}
}

pub func main = (Init init) {
	Console.write("\\{f()}-\\{g()}\\n")
}
`;
	expect(parse_raw(src).errors).toEqual([]);
	await build_and_check_output(src, "type_scoping_enums", "green-yellow\n", true);
});
