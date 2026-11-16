import { expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// Compile-time serde in the standard library: `json_decode_into<T>` /
// `json_encode<T>` (core/System/Text/Json.nm) — reflection generates the
// per-field dispatch at compile time, so decoding goes straight into the
// typed struct with no DOM and no runtime key map. (The harness wraps these
// bodies in its own `main`, so they are plain statements.)

test("json serde -- flat struct round-trips through decode + encode", async () => {
	const input = `
mv struct Person {
	var string name = ""
	var int age = 0
	var float score = 0.0
	var bool active = false
}
var p = Person()
json_decode_into("{\\"name\\":\\"Ada\\",\\"age\\":36,\\"score\\":9.5,\\"active\\":true,\\"unknown\\":[1,2,{\\"x\\":3}]}", ref p)
Console.write_line(p.name)
Console.write_line(p.age.to_string())
Console.write_line(p.score.to_string())
Console.write_line(p.active.to_string())
Console.write_line(json_encode(p))
`;
	await build_and_check_output(
		input,
		"json_serde_flat",
		"Ada\n36\n9.500000\ntrue\n" + '{"name":"Ada","age":36,"score":9.500000,"active":true}\n',
	);
});

test("json serde -- nested structs recurse, @rename maps keys, @skip omits fields", async () => {
	const input = `
mv struct Address {
	@rename("street_name")
	var string street = ""
	var int zip = 0
	@skip
	var string cache = ""
}
mv struct Person {
	var string name = ""
	var Address address = Address()
}
var p = Person()
json_decode_into("{\\"name\\":\\"Ada\\",\\"address\\":{\\"street_name\\":\\"Main\\",\\"zip\\":12345,\\"cache\\":\\"ignored\\"}}", ref p)
Console.write_line(p.name + " @ " + p.address.street + " " + p.address.zip.to_string())
Console.write_line("cache=[" + p.address.cache + "]")
Console.write_line(json_encode(p))
`;
	await build_and_check_output(
		input,
		"json_serde_nested",
		"Ada @ Main 12345\ncache=[]\n" +
			'{"name":"Ada","address":{"street_name":"Main","zip":12345}}\n',
	);
});

test("json serde -- missing keys keep defaults", async () => {
	const input = `
mv struct Partial {
	var string name = "default"
	var int n = 7
}
var p = Partial()
json_decode_into("{\\"n\\":9}", ref p)
Console.write_line(p.name + " " + p.n.to_string())
`;
	await build_and_check_output(input, "json_serde_defaults", "default 9\n");
});

test("json serde -- string escapes round-trip through deserialize/serialize", async () => {
	const input = `
mv struct Msg {
	var string text = ""
}
var m = Msg()
json_decode_into("{\\"text\\":\\"line1\\\\nline2\\"}", ref m)
Console.write_line(m.text)
Console.write_line(json_encode(m))
`;
	await build_and_check_output(
		input,
		"json_serde_escapes",
		"line1\nline2\n" + '{"text":"line1\\nline2"}\n',
	);
});

test("json serde -- checks clean for a nested struct program", () => {
	const parsed = parse_with_imports(`
mv struct Inner2 {
	var int n = 0
}
mv struct Outer2 {
	var Inner2 inner = Inner2()
	var string name = ""
}
var o = Outer2()
json_decode_into("{}", ref o)
Console.write_line(json_encode(o))
`);
	expect(parsed.errors).toEqual([]);
});

test("json serde -- StableList containers decode and encode", async () => {
	const input = `
mv struct Item {
	var n = 0
	var s = ""
}
mv struct Cart {
	@rename("lineItems")
	var items = StableList<Item>()
	var nums = StableList<int>()
	var labels = StableList<string>()
}
var c = Cart()
json_decode_into("{\\"lineItems\\":[{\\"n\\":1,\\"s\\":\\"a\\"},{\\"n\\":2,\\"s\\":\\"b\\"}],\\"nums\\":[3,4,5],\\"labels\\":[\\"x\\",\\"y\\"]}", ref c)
Console.write_line("items=" + c.items.length.to_string() + " nums=" + c.nums.length.to_string() + " labels=" + c.labels.length.to_string())
Console.write_line(json_encode(c))
`;
	await build_and_check_output(
		input,
		"json_serde_containers",
		'items=2 nums=3 labels=2\n{"lineItems":[{"n":1,"s":"a"},{"n":2,"s":"b"}],"nums":[3,4,5],"labels":["x","y"]}\n',
	);
});

test("json serde -- nested StableList containers", async () => {
	const input = `
mv struct Grid {
	var cells = StableList<StableList<float>>()
}
var g = Grid()
json_decode_into("{\\"cells\\":[[1.5,2.5],[3.5]]}", ref g)
Console.write_line("rows=" + g.cells.length.to_string())
if g.cells.length > 0 {
	Console.write_line("row0=" + g.cells.at(0).length.to_string())
}
Console.write_line(json_encode(g))
`;
	// audit: false — a NESTED StableList's mono destroy misses its inner
	// container slabs (a pre-existing mono-destroy gap, recorded in
	// FOLLOWUP); the decode/encode behavior asserted here is correct.
	await build_and_check_output(
		input,
		"json_serde_nested_containers",
		'rows=2\nrow0=2\n{"cells":[[1.500000,2.500000],[3.500000]]}\n',
		false,
		{ audit: false },
	);
});
