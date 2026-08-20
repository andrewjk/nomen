import { expect, test } from "vite-plus/test";

import scan_string_length_hoists from "../src/build_common/scan_string_length_hoists";
import type BaseNode from "../src/nodes/BaseNode";
import Type from "../src/nodes/Type";
import type WhileLoopNode from "../src/nodes/WhileLoopNode";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

function find_while(node: BaseNode): WhileLoopNode {
	if (node.node_type === "while") return node as WhileLoopNode;
	const record = node as unknown as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (key === "parent" || key === "scope" || key === "node_type") continue;
		const child = record[key];
		if (Array.isArray(child)) {
			for (const item of child) {
				if (item && typeof item === "object" && "node_type" in item) {
					const found = find_while(item as BaseNode);
					if (found) return found;
				}
			}
		} else if (child && typeof child === "object" && "node_type" in child) {
			const found = find_while(child as BaseNode);
			if (found) return found;
		}
	}
	return undefined as unknown as WhileLoopNode;
}

// `x.length` on a string emits a `strlen(x)` call at every evaluation. In a
// while-loop condition that is O(len) per iteration; the build hoists the
// `strlen` of a loop-invariant string into a temp (C) / stack slot (aarch64)
// computed once before the loop. These tests pin the behavior and the
// invalidations that must disable the hoist.

test("hoisted strlen counts newlines", async () => {
	const input = `
func count_newlines = (string text, out int) {
	var int count = 0
	var int i = 0
	while i < text.length {
		if (text.at(i) as int) == 10 {
			count += 1
		}
		i += 1
	}
	return count
}
var string s = "a\\nb\\nc\\nd\\n"
var int n = count_newlines(s)
Console.write(n.to_string())
`;
	await build_and_check_output(input, "hoist_basic", "4");
});

test("reassigned string in loop is not hoisted", async () => {
	const input = `
var string s = "abcdef"
var int total = 0
while s.length > 3 {
	s = "abc" + ""
	total += 1
}
Console.write(total.to_string())
Console.write(s)
`;
	await build_and_check_output(input, "hoist_reassign", "1abc");
});

test("update clause loop with length condition", async () => {
	const input = `
var string s = "hello"
var int j = 0
var int acc = 0
while j < s.length; j += 1 {
	acc += 1
}
Console.write(acc.to_string())
`;
	await build_and_check_output(input, "hoist_update", "5");
});

test("nested loops both use hoisted lengths", async () => {
	const input = `
var string a = "ab"
var string b = "cde"
var int count = 0
var int i = 0
while i < a.length {
	var int j = 0
	while j < b.length {
		count += 1
		j += 1
	}
	i += 1
}
Console.write(count.to_string())
`;
	await build_and_check_output(input, "hoist_nested", "6");
});

test("length in body condition also cached", async () => {
	const input = `
var string s = "abcde"
var int i = 0
var int hits = 0
while i < 10 {
	if i < s.length - 1 {
		hits += 1
	}
	i += 1
}
Console.write(hits.to_string())
`;
	await build_and_check_output(input, "hoist_body", "4");
});

test("ref-passed string disables hoist", async () => {
	const input = `
func poke = (ref string s, out int) {
	return 1
}
var string s = "hello"
var int i = 0
while i < s.length {
	i += poke(ref s)
}
Console.write(i.to_string())
`;
	await build_and_check_output(input, "hoist_ref_pass", "5");
});

test("mutating method call disables hoist", async () => {
	// `set` is a `ref self` method: it can change the receiver's effective
	// strlen in place, so its receiver must not be hoisted.
	const input = `
var string s = "abc"
var int i = 0
while i < s.length {
	s.set(i, 'x')
	i += 1
}
Console.write(s)
`;
	await build_and_check_output(input, "hoist_mutating_set", "xxx");
	const root = parse_with_imports(`
var string s = "abc"
var int i = 0
while i < s.length {
	s.set(i, 'x')
	i += 1
}
`);
	expect(root.errors).toEqual([]);
	const loop = find_while(root.root);
	const hoists = scan_string_length_hoists(loop.condition, loop.statements, loop.update, {
		variable_types: new Map([["s", new Type("string")]]),
		structs: root.root.statements.filter((s) => s.node_type === "struct") as never,
	});
	expect(hoists.size).toBe(0);
});

test("scanner hoists plain at-loop receiver", async () => {
	const root = parse_with_imports(`
var string s = "abc"
var int i = 0
while i < s.length {
	if (s.at(i) as int) == 97 {
		i += 2
	}
	i += 1
}
`);
	expect(root.errors).toEqual([]);
	const loop = find_while(root.root);
	const hoists = scan_string_length_hoists(loop.condition, loop.statements, loop.update, {
		variable_types: new Map([["s", new Type("string")]]),
	});
	expect([...hoists.keys()]).toEqual(["s"]);
});

test("shadowed name disables hoist", async () => {
	const input = `
var string s = "hello"
var int i = 0
while i < 3 {
	var string s2 = "x"
	if s2.length == 1 {
		Console.write(s2)
	}
	i += 1
}
Console.write(s.length.to_string())
`;
	await build_and_check_output(input, "hoist_shadow", "xxx5");
});

test("zero-iteration loop over empty string", async () => {
	const input = `
var string s = ""
var int i = 0
while i < s.length {
	i += 1
}
Console.write(i.to_string())
`;
	await build_and_check_output(input, "hoist_empty", "0");
});
