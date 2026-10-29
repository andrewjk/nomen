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
const string j = Json.serialize("nomen")
const string r = Json.deserialize(j)
Console.write(r)
`;
		await build_and_check_output(input, "json_roundtrip", "nomen");
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
	// The tree pool owns its node texts end to end (StableList<JsonNode>:
	// set_text's interior write frees the displaced text, the list's destroy
	// reclaims every node), so audit mode's leak check passes.
	const opts = { arch: "aarch64", audit: true } as const;

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

	test("re-parsing the same tree with a new document replaces its content", async () => {
		const input = `
var string first = "{\\"a\\": 1}"
var string second = "[9, \\"eight\\"]"
var JsonTree tree = JsonTree()
var int r1 = Json.parse(first, ref tree)
var string s1 = Json.stringify(ref tree, r1)
var int r2 = Json.parse(second, ref tree)
var string s2 = Json.stringify(ref tree, r2)
Console.write("\\{s1}|\\{s2}")
`;
		// Json.parse resets the pool per document: the displaced StableList's
		// destroy frees every node (texts included), and the fresh pool parses
		// the next document clean. Audit mode verifies nothing leaks across
		// the reset.
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("json_tree_reset_reparse", result, '{"a":1}|[9,"eight"]', opts);
	});
});

describe("JsonTree ownership paths", () => {
	// take_text installs the builder's heap buffer (the take-shaped zero-copy
	// store the parse hot path uses), and get_text_view reads a node's text
	// as a (ptr, len) borrow — the zero-copy read the serializer's
	// append_string_view sites use. The pool owns its node texts end to end,
	// so audit mode verifies both shapes stay inside the pool's ownership
	// rules (the taken buffer is freed exactly once, by the list's destroy).
	const opts = { arch: "aarch64", audit: true } as const;

	test("take_text stores the builder's buffer; the builder resets after", async () => {
		const input = `
var JsonTree tree = JsonTree()
var int n = tree.alloc_node()
tree.set_kind(n, 3)
var sb = StringBuilder()
sb.append_string("hello")
tree.take_text(n, ref sb)
Console.write(tree.get_text(n))
Console.write("|")
sb.append_string("more")
Console.write(sb.to_string())
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("json_take_text", result, "hello|more", opts);
	});

	test("get_text_view reads the node's text without an owning copy", async () => {
		const input = `
var JsonTree tree = JsonTree()
var int n = tree.alloc_node()
tree.set_kind(n, 3)
var sb = StringBuilder()
sb.append_string("payload")
tree.take_text(n, ref sb)
view v = tree.get_text_view(n)
var sb2 = StringBuilder()
sb2.append_string_view(v)
Console.write(sb2.to_string())
Console.write("|")
Console.write(v.length.to_string())
Console.write("|")
Console.write(tree.get_text(n))
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("json_get_text_view", result, "payload|7|payload", opts);
	});
});
