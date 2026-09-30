import { describe, expect, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

// Nullable SCALAR values (`bool?`, `int?`, …) carry a companion `_has` flag
// (mirroring nullable structs) so `false`/`0` are distinguishable from
// `null`. Before this, scalars used an in-band `null == 0` representation:
// storing `false` in a `bool?` field read back as null.

describe("nullable scalar values", () => {
	test("bool?/int? fields distinguish false/0 from null", async () => {
		const input = `
class Config {
	pub var bool? flag = null
	pub var int? count = null
}

struct Pair {
	var bool? on
	var int? n
}

var c = Config()
if c.flag != null { Console.write("FLAG BUG\\n") }
c.flag = false
if c.flag == null { Console.write("FLAG NULL BUG\\n") } else { Console.write("flag false\\n") }
c.count = 0
if c.count == null { Console.write("COUNT NULL BUG\\n") } else { Console.write("count zero\\n") }
c.count = null
if c.count == null { Console.write("count cleared\\n") } else { Console.write("COUNT CLEAR BUG\\n") }

var p = Pair(true, 7)
Console.write("p=\\{p.on} \\{p.n}\\n")

var bool? local = false
if local == null { Console.write("LOCAL BUG\\n") } else { Console.write("local false\\n") }
local = null
if local == null { Console.write("local cleared\\n") }
`;
		await build_and_check_output(
			input,
			"nullable_scalar_fields",
			"flag false\ncount zero\ncount cleared\np=true 7\nlocal false\nlocal cleared\n",
		);
	});

	test("nullable scalar params and returns round-trip null", async () => {
		const input = `
func pass = (int? x, out int?) {
	return x
}

func is_set = (int? x, out bool) {
	return x != null
}

func find = (out int?) {
	return null
}

func or_default = (int? x, out int) {
	return x ?? 42
}

var a = pass(5)
if a == null { Console.write("A BUG\\n") } else { Console.write("a=5\\n") }
var b = pass(null)
if b == null { Console.write("b null\\n") } else { Console.write("B BUG\\n") }
Console.write("is_set(5)=\\{is_set(5)} is_set(null)=\\{is_set(null)}\\n")
var n = find()
if n == null { Console.write("find null\\n") } else { Console.write("N BUG\\n") }
Console.write("or_default(null)=\\{or_default(null)}\\n")
`;
		await build_and_check_output(
			input,
			"nullable_scalar_params",
			"a=5\nb null\nis_set(5)=true is_set(null)=false\nfind null\nor_default(null)=42\n",
		);
	});

	test("nullable scalar method params and returns", async () => {
		const input = `
class Store {
	pub var int? cached = null

	pub func set = (ref self, int? v) {
		self.cached = v
	}

	pub func get = (ref self, out int?) {
		return self.cached
	}
}

var s = Store()
s.set(9)
var got = s.get()
if got == null { Console.write("GET BUG\\n") } else { Console.write("got=9\\n") }
s.set(null)
var cleared = s.get()
if cleared == null { Console.write("cleared\\n") } else { Console.write("CLEAR BUG\\n") }
`;
		await build_and_check_output(input, "nullable_scalar_methods", "got=9\ncleared\n");
	});
});

// A file-scope (top-level) nullable scalar applies its literal initializer:
// the value lands in the static data image (C: on the value slot's `= value`
// declaration; aarch64: in the data section) and the companion `_has` flag is
// statically 1 — `= null` / no initializer stays null (zero-filled).
describe("nullable scalar file-scope globals", () => {
	test("non-null literal initializers read back non-null", async () => {
		const input = `
var int? g = 5
var bool? b = true
var int8? s8 = -3
var int? n = null

if g == null { Console.write("G NULL BUG\\n") } else { Console.write("g set\\n") }
if g == 5 { Console.write("g=5\\n") } else { Console.write("G VAL BUG\\n") }
if b == null { Console.write("B NULL BUG\\n") } else { Console.write("b set\\n") }
if b == true { Console.write("b true\\n") } else { Console.write("B VAL BUG\\n") }
if s8 == -3 { Console.write("s8=-3\\n") } else { Console.write("S8 BUG\\n") }
if n == null { Console.write("n null\\n") } else { Console.write("N BUG\\n") }

g = 7
if g == 7 { Console.write("g=7\\n") } else { Console.write("G7 BUG\\n") }
g = null
if g == null { Console.write("g cleared\\n") } else { Console.write("GC BUG\\n") }
b = false
if b == null { Console.write("BF NULL BUG\\n") } else { Console.write("b false\\n") }
`;
		await build_and_check_output(
			input,
			"nullable_scalar_globals",
			"g set\ng=5\nb set\nb true\ns8=-3\nn null\ng=7\ng cleared\nb false\n",
		);
	});

	test("no-initializer and null globals stay null", async () => {
		const input = `
var int? a
var int? z = null

if a == null { Console.write("a null\\n") } else { Console.write("A BUG\\n") }
if z == null { Console.write("z null\\n") } else { Console.write("Z BUG\\n") }
a = 1
if a == 1 { Console.write("a=1\\n") } else { Console.write("A1 BUG\\n") }
`;
		await build_and_check_output(input, "nullable_scalar_globals_null", "a null\nz null\na=1\n");
	});
});

// A nullable SIMPLE enum / bitset carries the same `<slot>_has` flag as a
// scalar: its in-band zero (the first case's tag 0 / an empty bitset) is a
// real value, so `null` must not conflate with it. `?` on an enum WITH
// associated data is a checker error (see the rejections below).
describe("nullable enums and bitsets", () => {
	test("simple enum null/non-null round-trip", async () => {
		const input = `
enum Color {
	case red
	case green
	case blue
}

struct Cell {
	var Color? ink
}

func pick = (out Color?) {
	return null
}

func first = (out Color?) {
	return .red
}

func paint = (Color? c, out bool) {
	return c != null
}

var c = first()
if c == null { Console.write("C NULL BUG\\n") } else { Console.write("c red\\n") }
if c == .red { Console.write("c is red\\n") } else { Console.write("C VAL BUG\\n") }
c = null
if c == null { Console.write("c cleared\\n") } else { Console.write("C CLEAR BUG\\n") }

var p = pick()
if p == null { Console.write("p null\\n") } else { Console.write("P BUG\\n") }

var cell = Cell(null)
if cell.ink == null { Console.write("ink null\\n") } else { Console.write("INK BUG\\n") }
cell.ink = .green
if cell.ink == null { Console.write("INK2 BUG\\n") } else { Console.write("ink green\\n") }
var borrowed = cell.ink
if borrowed == .green { Console.write("borrowed green\\n") } else { Console.write("BORROW BUG\\n") }

Console.write("paint(.blue)=\\{paint(.blue)} paint(null)=\\{paint(null)}\\n")

var fallback = p ?? .blue
if fallback == .blue { Console.write("fallback blue\\n") } else { Console.write("FB BUG\\n") }
`;
		await build_and_check_output(
			input,
			"nullable_enum",
			"c red\nc is red\nc cleared\np null\nink null\nink green\nborrowed green\npaint(.blue)=true paint(null)=false\nfallback blue\n",
		);
	});

	test("bitset null/non-null round-trip", async () => {
		const input = `
bitset Perms {
	case read
	case write
}

func grant = (out Perms?) {
	return Perms.write
}

var g = grant()
if g == null { Console.write("G BUG\\n") } else { Console.write("g write\\n") }
if g == Perms.write { Console.write("g is write\\n") } else { Console.write("G VAL BUG\\n") }
g = null
if g == null { Console.write("g cleared\\n") } else { Console.write("G CLEAR BUG\\n") }

var Perms? checked = null
if checked == null { Console.write("checked null\\n") } else { Console.write("CK BUG\\n") }
checked = Perms.read
if checked == null { Console.write("CK2 BUG\\n") } else { Console.write("checked read\\n") }
`;
		await build_and_check_output(
			input,
			"nullable_bitset",
			"g write\ng is write\ng cleared\nchecked null\nchecked read\n",
		);
	});
});

// Corners where a nullable flag slot does not exist are REJECTED instead of
// silently using the old in-band `null == 0` representation: raw container /
// array element slots, and enums with associated data (the tag word conflates
// null with the first case).
describe("nullable corner rejections", () => {
	test("nullable scalar container element", () => {
		const input = `
var List<int?> l
`;
		// parse_with_imports wraps the source (`\nimport System\npub func main
		// = () {\n...`), so error positions are relative to the wrapped text.
		const wrapped = `\nimport System\npub func main = () {\n${input}\n}\n`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([
			test_error(
				wrapped,
				"Nullable element type 'int?' is not supported in 'List<...>': container element storage has no per-element null flag",
				5,
				5,
			),
		]);
	});

	test("nullable scalar heap array element", () => {
		const input = `
var Array<int?> a
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"Nullable element type 'int?' is not supported in an array: element storage has no per-element null flag",
				2,
				5,
			),
		]);
	});

	test("nullable scalar stack array element", () => {
		const input = `
var int?[4] slots
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"Nullable element type 'int?' is not supported in an array: element storage has no per-element null flag",
				2,
				5,
			),
		]);
	});

	test("nullable enum with associated data", () => {
		const input = `
enum Shape {
	case circle(int radius)
	case dot
}

var Shape? s = null
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"Nullable type 'Shape?' is not supported: enums with associated data have no separate null flag",
				7,
				5,
			),
		]);
	});

	test("nullable anon enum with payload", () => {
		const input = `
var [.ok(int), .err]? r = null
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"Nullable type '[.ok(int), .err]?' is not supported: enums with associated data have no separate null flag",
				2,
				5,
			),
		]);
	});
});
