import fs from "node:fs";
import path from "node:path";

import { expect, test } from "vitest";

import build from "../src/build";
import { set_auto_method_inline_enabled } from "../src/build_aarch64/utils/scan_inline_candidates";
import join from "../src/join";
import { get_library } from "../src/lib";
import parse from "../src/parse";

const program = [
	"import System",
	"pub func main = () {",
	'var string src = "[1, true, \\"hi\\", null]"',
	"var JsonTree tree = JsonTree()",
	"var int n = Json.parse(src, ref tree)",
	'Console.write("n=\\{n}\\n")',
	"var int i = 0",
	"while i <= n; i += 1 {",
	'\tConsole.write("i=\\{i} k=\\{tree.probe_kind(i)} c=\\{tree.probe_child(i)} nx=\\{tree.probe_next(i)} v=\\{tree.probe_val(i)}\\n")',
	"\ti = i + 1",
	"}",
	"}",
].join("\n");

test("item1 probe", async () => {
	const dir = fs.mkdtempSync("/tmp/item1-");
	fs.writeFileSync(path.join(dir, "probe.nm"), program);
	fs.writeFileSync(path.join(dir, "package.jsonc"), fs.readFileSync("bench/nomen/package.jsonc"));
	const source = join(path.join(dir, "probe.nm"), path.resolve("core"));
	const library = get_library(path.resolve("core"));
	const parsed = parse(source, library);
	if (parsed.errors.length) {
		const ls = source.split("\n");
		for (const e of parsed.errors.slice(0, 4)) {
			console.log(
				"ERR",
				e.message,
				"line",
				e.line,
				":",
				JSON.stringify(ls.slice(e.line - 4, e.line + 2)),
			);
		}
	}
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64", audit: false });
	expect(result.errors ?? []).toEqual([]);
	fs.writeFileSync("test/out/aarch64/json_dbg3/main.s", result.code);
	set_auto_method_inline_enabled(true);
});
