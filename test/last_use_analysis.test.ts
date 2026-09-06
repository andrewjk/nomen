import path from "node:path";

import { expect, test } from "vite-plus/test";

import { scan_last_use_string_moves, type LastUseSite } from "../src/check/utils/last_use";
import { get_library } from "../src/lib";
import parse from "../src/parse";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

function scan(src: string): LastUseSite[] {
	const parsed = parse(src, system);
	expect(parsed.errors).toEqual([]);
	return scan_last_use_string_moves(parsed.root);
}

/**
 * Move-on-last-use analysis (STRING_PLAN tranche 4's gate). The tranche
 * itself is gated on this receipt: the analysis must positively identify
 * the real pattern — `s = t` where t is a dead-after `var` string local —
 * including the loop-accumulator shape, and must refuse every unsound
 * variant. These pins are the gate's regression suite.
 */

test("detects the straight-line staged-rebinding pattern", () => {
	const sites = scan(`
import System
pub func main = () {
	var t = "a".to_string()
	var s = "b".to_string()
	s = t
}
`);
	expect(sites).toHaveLength(1);
	expect(sites[0]).toMatchObject({ target: "s", source: "t", desc: "s = t" });
});

test("detects the loop accumulator (loop-local source, back-edge safe)", () => {
	const sites = scan(`
import System
func render = (string[] lines, out string) {
	var acc = "".to_string()
	var i = 0
	while i < lines.length; i += 1 {
		var next = acc + lines.at(i)
		acc = next
		i += 1
	}
	return acc
}
pub func main = () {
	var lines = ["a".to_string(), "b".to_string()]
	Console.write_line(render(lines))
}
`);
	expect(sites).toHaveLength(1);
	expect(sites[0]).toMatchObject({ func: "render", target: "acc", source: "next" });
});

test("refuses a read after the assignment", () => {
	const sites = scan(`
import System
pub func main = () {
	var t = "a".to_string()
	var s = "b".to_string()
	s = t
	Console.write_line(t)
}
`);
	expect(sites).toHaveLength(0);
});

test("refuses a back-edge re-read of an outer-loop binding", () => {
	const sites = scan(`
import System
pub func main = () {
	var t = "a".to_string()
	var s = "b".to_string()
	var i = 0
	while i < 3; i += 1 {
		s = t
		Console.write_line(t)
	}
}
`);
	expect(sites).toHaveLength(0);
});

test("refuses a const source and a read in a sibling branch", () => {
	const const_source = scan(`
import System
pub func main = () {
	const t = "a".to_string()
	var s = "b".to_string()
	s = t
}
`);
	expect(const_source).toHaveLength(0);

	const sibling_branch = scan(`
import System
pub func main = (bool c) {
	var t = "a".to_string()
	var s = "b".to_string()
	if c {
		s = t
	} else {
		Console.write_line(t)
	}
}
`);
	expect(sibling_branch).toHaveLength(0);
});

test("refuses non-string and compound assignments", () => {
	const int_assign = scan(`
import System
pub func main = () {
	var t = 5
	var s = 6
	s = t
}
`);
	expect(int_assign).toHaveLength(0);

	const compound = scan(`
import System
pub func main = () {
	var t = 5
	var s = 6
	s += t
}
`);
	expect(compound).toHaveLength(0);
});
