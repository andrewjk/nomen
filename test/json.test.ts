import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Companion-C allocations aren't tracked by the audit wrappers (which only
// wrap assembly-side malloc/free), so audit would report a counter imbalance.
const opts = { audit: false };

describe("Json serialize/deserialize", () => {
	test("serialize quotes a plain string", async () => {
		const input = `
const string s = Json.serialize("hello")
Console.write(s)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("json_serialize_plain", result, '"hello"', opts);
	});

	test("serialize escapes special characters", async () => {
		const input = `
const string s = Json.serialize("a\\"b\\nc")
Console.write(s)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("json_serialize_escape", result, '"a\\"b\\nc"', opts);
	});

	test("deserialize a JSON string literal", async () => {
		const input = `
const string s = Json.deserialize("\\"world\\"")
Console.write(s)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("json_deserialize_plain", result, "world", opts);
	});

	test("deserialize unescapes sequences", async () => {
		const input = `
const string s = Json.deserialize("\\"tab\\there\\"")
Console.write(s)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("json_deserialize_unescape", result, "tab\there", opts);
	});

	test("round-trip serialize then deserialize", async () => {
		const input = `
const string j = Json.serialize("echo")
const string r = Json.deserialize(j)
Console.write(r)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("json_roundtrip", result, "echo", opts);
	});

	test("serialize_int and deserialize_int round-trip", async () => {
		const input = `
const string j = Json.serialize_int(42)
const int v = Json.deserialize_int(j)
Console.write(j)
Console.write("|")
Console.write(v.to_string())
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("json_int_roundtrip", result, "42|42", opts);
	});

	test("deserialize_int parses a number literal", async () => {
		const input = `
const int v = Json.deserialize_int("123")
Console.write(v.to_string())
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("json_deserialize_int", result, "123", opts);
	});
});
