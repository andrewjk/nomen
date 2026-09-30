import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A value struct whose member is a heap-owning container (`List<string>`)
// pushed into a `List<that-struct>`: every read prints correctly, then
// scope exit aborts at teardown (exit 134; C reports "free of object 0x4 —
// pointer being freed was not allocated"). Found porting allmark's
// sanitizer (its attribute-rule types stayed classes because of this).

describe("struct with heap-owning members in a List", () => {
	test("push, read back, scope exit", async () => {
		const input = `
struct Rule {
	var name = ""
	var string? pattern = null
	var protocols = List<string>()
	var has_protocols = false
}

var rules = List<Rule>()
var href = Rule()
href.name = "href"
href.protocols.push("http")
href.protocols.push("https")
href.has_protocols = true
rules.push(move href)
Console.write("pushed len=\\{rules.length}\\n")
var loaded = rules.at_or_panic(0)
Console.write("loaded name=\\{loaded.name} hp=\\{loaded.has_protocols} plen=\\{loaded.protocols.length}\\n")
var loaded2 = rules.at_or_panic(0)
var p0 = loaded2.protocols.at_or_panic(0)
Console.write("loaded2 name=\\{loaded2.name} p0=\\{p0}\\n")
var pattern_rule = Rule()
pattern_rule.name = "class"
pattern_rule.pattern = "^language-."
rules.push(move pattern_rule)
var loaded3 = rules.at_or_panic(1)
var pn = loaded3.pattern == null
Console.write("loaded3 name=\\{loaded3.name} pattern-null=\\{pn}\\n")
`;
		await build_and_check_output(
			input,
			"list_struct_heap_members",
			"pushed len=1\nloaded name=href hp=true plen=2\nloaded2 name=href p0=http\nloaded3 name=class pattern-null=false\n",
		);
	});

	test("copy() is deep — the copy's List member is independent", async () => {
		const input = `
struct Rule {
	var name = ""
	var string? pattern = null
	var protocols = List<string>()
	var has_protocols = false
}

var a = Rule()
a.name = "href"
a.protocols.push("http")
a.has_protocols = true
var b = a.copy()
b.name = "class"
b.protocols.push("ftp")
Console.write("a=\\{a.name}/\\{a.protocols.length} b=\\{b.name}/\\{b.protocols.length}\\n")
`;
		await build_and_check_output(input, "list_struct_heap_members_copy", "a=href/1 b=class/2\n");
	});
});
