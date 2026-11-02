import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports, { parse_program } from "./parse_with_imports";

describe("mv string transfer (the D3 argument convention)", () => {
	// `f(mv s)` into a `mv string` parameter hands the buffer to the callee:
	// the callee owns and frees the pair at its exit, a consuming
	// `field = mv p` store takes it raw (no strdup), and the donor is
	// invalidated. The set_text shape below is the motivating consumer: the
	// pool takes the caller's buffer with no copy anywhere. Audit on, both
	// backends — every shape must stay exactly-once balanced.
	test("set_text installs the transferred buffer; the pool frees it once", async () => {
		const input = `
var JsonTree tree = JsonTree()
var int n = tree.alloc_node()
tree.set_kind(n, 3)
var string s = "transferred"
tree.set_text(n, mv s)
Console.write(tree.get_text(n))
Console.write("|")
Console.write(Json.stringify(ref tree, n))
Console.write("\\n")
`;
		await build_and_check_output(input, "mv_string_set_text", 'transferred|"transferred"\n');
	});

	test("a literal argument is materialized — the callee frees its copy, not rodata", async () => {
		const input = `
var JsonTree tree = JsonTree()
var int n = tree.alloc_node()
tree.set_kind(n, 3)
tree.set_text(n, "fresh literal")
Console.write(tree.get_text(n))
Console.write("|")
tree.set_text(n, "second")
Console.write(tree.get_text(n))
Console.write("\\n")
`;
		await build_and_check_output(input, "mv_string_literal_arg", "fresh literal|second\n");
	});

	test("an unconsumed mv string param is freed at the callee's exit", async () => {
		const input = `
import System

func consume_len = (mv string s, out int) {
	return s.length
}
pub func main = (Init init) {
	var string s = "fleeting"
	var int n = consume_len(mv s)
	Console.write(n.to_string())
	Console.write("|")
	var int m = consume_len(mv "again")
	Console.write(m.to_string())
	Console.write("\\n")
}
`;
		await build_and_check_output(input, "mv_string_unconsumed", "8|5\n", true);
	});

	test("a conditional transfer keeps the not-taken path's free (the owns-flag)", async () => {
		const input = `
import System

pub func main = (Init init) {
	var JsonTree tree = JsonTree()
	var int a = tree.alloc_node()
	tree.set_kind(a, 3)
	var int b = tree.alloc_node()
	tree.set_kind(b, 3)
	var string s = "maybe"
	if init.argc > 99 {
		tree.set_text(a, mv s)
	}
	tree.set_text(b, "fallback")
	Console.write(tree.get_text(a))
	Console.write("|")
	Console.write(tree.get_text(b))
	Console.write("\\n")
}
`;
		await build_and_check_output(input, "mv_string_conditional", "|fallback\n", true);
	});

	test("forwarding a mv string param through another mv string param", async () => {
		const input = `
import System

func inner = (mv string s, out int) {
	return s.length
}
func outer = (mv string s, out int) {
	return inner(mv s)
}
pub func main = (Init init) {
	var string s = "forwarded"
	Console.write(outer(mv s).to_string())
	Console.write("\\n")
}
`;
		await build_and_check_output(input, "mv_string_forwarded", "9\n", true);
	});

	test("plain reads of a mv string param keep the copy semantics", async () => {
		const input = `
import System

func store_twice = (ref JsonTree t, mv string s, out int) {
	var int a = t.alloc_node()
	t.set_kind(a, 3)
	t.set_text(a, s.copy())
	var int b = t.alloc_node()
	t.set_kind(b, 3)
	t.set_text(b, s.copy())
	return a + b
}
pub func main = (Init init) {
	var JsonTree tree = JsonTree()
	var string s = "twice"
	var int total = store_twice(ref tree, mv s)
	Console.write(tree.get_text(0))
	Console.write("|")
	Console.write(tree.get_text(1))
	Console.write("|")
	Console.write(total.to_string())
	Console.write("\\n")
}
`;
		await build_and_check_output(input, "mv_string_plain_reads", "twice|twice|1\n", true);
	});

	test("the keep-the-original spelling still works: set_text(n, s.copy())", async () => {
		const input = `
var JsonTree tree = JsonTree()
var int n = tree.alloc_node()
tree.set_kind(n, 3)
var string s = "kept"
tree.set_text(n, s.copy())
Console.write(tree.get_text(n))
Console.write("|")
Console.write(s)
Console.write("\\n")
`;
		await build_and_check_output(input, "mv_string_keep_copy", "kept|kept\n");
	});

	test("the donor is invalidated: reading after mv is a check error", async () => {
		const parsed = parse_with_imports(`
func consume = (mv string s, out int) {
	return s.length
}
pub func main = (Init init) {
	var string s = "gone"
	var int n = consume(mv s)
	Console.write(s)
	Console.write(n.to_string())
}
`);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("used after mv");
	});

	test("a second mv of the same donor is a check error", async () => {
		const parsed = parse_with_imports(`
func consume = (mv string s, out int) {
	return s.length
}
pub func main = (Init init) {
	var string s = "gone"
	var int a = consume(mv s)
	var int b = consume(mv s)
	Console.write(a + b)
}
`);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("used after mv");
	});

	test("a bare string parameter cannot be transferred out (it is a borrow)", async () => {
		const parsed = parse_with_imports(`
func inner = (mv string s, out int) {
	return s.length
}
func outer = (string s, out int) {
	return inner(mv s)
}
pub func main = (Init init) {
	var string s = "borrowed"
	Console.write(outer(s).to_string())
}
`);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("bare string parameter is a borrow");
	});

	test("a bare owned-string argument to a mv string param demands the keyword", async () => {
		const parsed = parse_with_imports(`
func consume = (mv string s, out int) {
	return s.length
}
pub func main = (Init init) {
	var string s = "silent"
	var int n = consume(s)
	Console.write(n.to_string())
}
`);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Missing 'mv' keyword");
	});

	test("the transferred store takes the buffer raw: no dup in JsonTree_set_text", async () => {
		// The emission receipt: the set_text body stores the parameter's
		// pair directly — no nomen_str_dup / no strdup, no copy call.
		for (const arch of ["c", "aarch64"] as const) {
			const parsed = parse_program(`
import System
pub func main = (Init init) {
	var JsonTree tree = JsonTree()
	var int n = tree.alloc_node()
	var string s = "x"
	tree.set_text(n, mv s)
}
`);
			expect(parsed.errors).toEqual([]);
			const result = build(parsed.root, { arch, audit: false });
			const code: string = (result as any).code ?? "";
			const idx = code.indexOf("JsonTree_set_text");
			expect(idx).toBeGreaterThan(0);
			const body = code.slice(idx, idx + 700);
			expect(body).not.toContain("nomen_str_dup");
			expect(body).not.toContain("_strdup");
		}
	});

	test("the transferred and taken stores compose", async () => {
		const input = `
var JsonTree tree = JsonTree()
var int n = tree.alloc_node()
tree.set_kind(n, 3)
var sb = StringBuilder()
sb.append_string("builder")
var string s = "variable"
tree.set_text(n, mv s)
Console.write(tree.get_text(n))
Console.write("|")
tree.take_text(n, ref sb)
Console.write(tree.get_text(n))
Console.write("\\n")
`;
		await build_and_check_output(input, "mv_string_take_both", "variable|builder\n");
	});
});
