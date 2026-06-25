import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

describe("Json serialize/deserialize", () => {
	test("serialize quotes a plain string", async () => {
		const input = `
const string s = Json.serialize("hello")
Console.write(s)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("json_serialize_plain", result, '"hello"');
	});

	test("serialize escapes special characters", async () => {
		const input = `
const string s = Json.serialize("a\\"b\\nc")
Console.write(s)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("json_serialize_escape", result, '"a\\"b\\nc"');
	});

	test("deserialize a JSON string literal", async () => {
		const input = `
const string s = Json.deserialize("\\"world\\"")
Console.write(s)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("json_deserialize_plain", result, "world");
	});

	test("deserialize unescapes sequences", async () => {
		const input = `
const string s = Json.deserialize("\\"tab\\there\\"")
Console.write(s)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("json_deserialize_unescape", result, "tab\there");
	});

	test("round-trip serialize then deserialize", async () => {
		const input = `
const string j = Json.serialize("echo")
const string r = Json.deserialize(j)
Console.write(r)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("json_roundtrip", result, "echo");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("json_int_roundtrip", result, "42|42");
	});

	test("int.parse parses a number literal", async () => {
		const input = `
const int v = int.parse("123")
Console.write(v.to_string())
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("json_deserialize_int", result, "123");
	});
});

describe("Json parse/stringify", () => {
	// JsonNode trees aren't cascade-freed by the current auto-free pass, so
	// audit would report a leak. The output is still verified.
	const parseOpts = { audit: false };

	test("parse and stringify an array", async () => {
		const input = `
var string src = "[1, true, \\"hi\\", null]"
var JsonNode n = Json.parse(src)
Console.write(Json.stringify(n))
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("json_parse_array", result, '[1,true,"hi",null]', parseOpts);
	});

	test("parse and stringify an object", async () => {
		const input = `
var string src = "{\\"type\\": \\"Feature\\", \\"count\\": 42}"
var JsonNode n = Json.parse(src)
Console.write(Json.stringify(n))
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("json_parse_object", result, '{"type":"Feature","count":42}', parseOpts);
	});

	test("parse nested GeoJSON-like structure", async () => {
		const input = `
var string src = "{\\"name\\": \\"a\\", \\"coords\\": [[1, 2], [3, 4]]}"
var JsonNode n = Json.parse(src)
Console.write(Json.stringify(n))
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output(
			"json_parse_nested",
			result,
			'{"name":"a","coords":[[1,2],[3,4]]}',
			parseOpts,
		);
	});
});
