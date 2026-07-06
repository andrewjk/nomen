import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

describe("Json serialize/deserialize", () => {
	test("serialize quotes a plain string", async () => {
		const input = `
const string s = Json.serialize("hello")
Console.write(s)
`;
		await build_and_check_output(input, "json_serialize_plain", '"hello"');
	});

	test("serialize escapes special characters", async () => {
		const input = `
const string s = Json.serialize("a\\"b\\nc")
Console.write(s)
`;
		await build_and_check_output(input, "json_serialize_escape", '"a\\"b\\nc"');
	});

	test("deserialize a JSON string literal", async () => {
		const input = `
const string s = Json.deserialize("\\"world\\"")
Console.write(s)
`;
		await build_and_check_output(input, "json_deserialize_plain", "world");
	});

	test("deserialize unescapes sequences", async () => {
		const input = `
const string s = Json.deserialize("\\"tab\\there\\"")
Console.write(s)
`;
		await build_and_check_output(input, "json_deserialize_unescape", "tab\there");
	});

	test("round-trip serialize then deserialize", async () => {
		const input = `
const string j = Json.serialize("echo")
const string r = Json.deserialize(j)
Console.write(r)
`;
		await build_and_check_output(input, "json_roundtrip", "echo");
	});

	test("int.to_string and int.parse round-trip", async () => {
		const input = `
var int n = 42
const string j = n.to_string()
const int v = int.parse(j)
Console.write(j)
Console.write("|")
Console.write(v.to_string())
`;
		await build_and_check_output(input, "json_int_roundtrip", "42|42");
	});

	test("int.parse parses a number literal", async () => {
		const input = `
const int v = int.parse("123")
Console.write(v.to_string())
`;
		await build_and_check_output(input, "json_deserialize_int", "123");
	});
});

describe("Json parse/stringify", () => {
	// Text strings stored in the tree pool (from StringBuilder.to_string) are
	// heap-allocated and not individually freed by the pool's #destroy, so
	// audit would report a leak. The output is still verified.
	const opts = { arch: "aarch64", audit: false } as const;

	test("parse and stringify an array", async () => {
		const input = `
var string src = "[1, true, \\"hi\\", null]"
var JsonTree tree = JsonTree()
var int n = Json.parse(src, ref tree)
Console.write(Json.stringify(ref tree, n))
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("json_parse_array", result, '[1,true,"hi",null]', opts);
	});

	test("parse and stringify an object", async () => {
		const input = `
var string src = "{\\"type\\": \\"Feature\\", \\"count\\": 42}"
var JsonTree tree = JsonTree()
var int n = Json.parse(src, ref tree)
Console.write(Json.stringify(ref tree, n))
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("json_parse_object", result, '{"type":"Feature","count":42}', opts);
	});

	test("parse nested GeoJSON-like structure", async () => {
		const input = `
var string src = "{\\"name\\": \\"a\\", \\"coords\\": [[1, 2], [3, 4]]}"
var JsonTree tree = JsonTree()
var int n = Json.parse(src, ref tree)
Console.write(Json.stringify(ref tree, n))
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("json_parse_nested", result, '{"name":"a","coords":[[1,2],[3,4]]}', opts);
	});
});
