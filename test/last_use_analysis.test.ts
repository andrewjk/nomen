import path from "node:path";

import { expect, test } from "vite-plus/test";

import check from "../src/check";
import { scan_last_use_string_moves, type LastUseSite } from "../src/check/utils/last_use";
import { get_library } from "../src/lib";
import parse from "../src/parse";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

function scan(src: string): LastUseSite[] {
	const parsed = parse(src, system, undefined, { allow_user_raw: true });
	expect(parsed.errors).toEqual([]);
	return scan_last_use_string_moves(parsed.root);
}

/** Scan the POST-CHECK tree: the checker hoists interpolation args into
 *  `node.allocations` declares (`const _param_N = t.to_string()`) and
 *  rewrites the call's argument to the bare `_param_N` — the read of `t`
 *  moves into a sub-statement the walk must visit explicitly. */
function scan_checked(src: string): LastUseSite[] {
	const parsed = parse(src, system, undefined, { allow_user_raw: true });
	expect(parsed.errors).toEqual([]);
	const checked = check(parsed.root);
	expect(checked.errors).toEqual([]);
	return scan_last_use_string_moves(parsed.root);
}

/**
 * Move-on-last-use inference is RETIRED by D3: a bare `s = t` from another
 * string binding is now a compile error, so `scan_last_use_string_moves` can
 * only ever observe explicitly-spelled transfers (`move`) or copies
 * (`.copy()`), and it reports NEITHER (an explicit move already carries
 * `is_moved`; a copy is a fresh value). These pins encode that new reality:
 * explicit transfers are not re-inferred as last-use sites, and no D3-valid
 * shape makes the scanner invent a transfer. The old "detects the pattern"
 * assertions are gone with the inference they measured.
 */

test("an explicit string move is not re-inferred as a last-use site", () => {
	const sites = scan(`
import System
pub func main = () {
	var t = "a".to_string()
	var s = "b".to_string()
	s = move t
}
`);
	expect(sites).toHaveLength(0);
});

test("an explicit declare move is not re-inferred (loop accumulator shape)", () => {
	const sites = scan(`
import System
func render = (string[] lines, out string) {
	var acc = "".to_string()
	var i = 0
	while i < lines.length; i += 1 {
		var next = acc + lines.at(i)
		acc = move next
		i += 1
	}
	return acc
}
pub func main = () {
	var lines = ["a".to_string(), "b".to_string()]
	Console.write_line(render(lines))
}
`);
	expect(sites).toHaveLength(0);
});

test("an explicit move inside a switch case is not re-inferred", () => {
	const sites = scan(`
import System
pub func main = () {
	var t = "a".to_string()
	var s = "b".to_string()
	switch {
		case true {
			s = move t
		}
	}
}
`);
	expect(sites).toHaveLength(0);
});

test("a copy source is never inferred (switch-expression read)", () => {
	const sites = scan(`
import System
pub func main = () {
	var t = "a".to_string()
	var s = "b".to_string()
	s = t.copy()
	var label = switch {
		case true -> t
		else -> "z"
	}
	Console.write_line(label)
}
`);
	expect(sites).toHaveLength(0);
});

test("a copy source is never inferred (read after the assignment)", () => {
	const sites = scan(`
import System
pub func main = () {
	var t = "a".to_string()
	var s = "b".to_string()
	s = t.copy()
	Console.write_line(t)
}
`);
	expect(sites).toHaveLength(0);
});

test("a copy source is never inferred (back-edge re-read of an outer-loop binding)", () => {
	const sites = scan(`
import System
pub func main = () {
	var t = "a".to_string()
	var s = "b".to_string()
	var i = 0
	while i < 3; i += 1 {
		s = t.copy()
		Console.write_line(t)
	}
}
`);
	expect(sites).toHaveLength(0);
});

test("a copy source is never inferred (const source and a sibling branch)", () => {
	const const_source = scan(`
import System
pub func main = () {
	const t = "a".to_string()
	var s = "b".to_string()
	s = t.copy()
}
`);
	expect(const_source).toHaveLength(0);

	const sibling_branch = scan(`
import System
pub func main = (bool c) {
	var t = "a".to_string()
	var s = "b".to_string()
	if c {
		s = t.copy()
	} else {
		Console.write(t)
	}
}
`);
	expect(sibling_branch).toHaveLength(0);
});

test("an explicit move followed by a source write is not re-inferred", () => {
	// The retired scan refused this because the source is written after the
	// declare; under D3 the write simply re-binds the (already moved) local
	// and the transfer is spelled, so the scan has nothing to report.
	const sites = scan(`
import System
pub func main = () {
	var t = "a".to_string()
	move u = t
	t = "b".to_string()
	Console.write(u)
}
`);
	expect(sites).toHaveLength(0);
});

test("a function containing a raw body contributes no sites", () => {
	const sites = scan(`
import System
func probe = (string s, out int) {
	\`\`\`
	#arch: c
	return 0;
	\`\`\`
}
pub func main = () {
	var t = "a".to_string()
	var u = t.copy()
	Console.write(u)
	var n = probe(t)
	Console.write(n.to_string())
}
`);
	expect(sites).toHaveLength(0);
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

test("a checker-hoisted interpolation read of a copy source is not inferred", () => {
	// Post-check, `"\{t}"` becomes `const _param_N = t.to_string()` attached
	// as the Console.write statement's `allocations`. The source here is an
	// explicit `.copy()` of `t`, so no transfer is available to infer.
	const sites = scan_checked(`
import System
pub func main = () {
	var t = "a".to_string()
	var s = "b".to_string()
	s = t.copy()
	Console.write_line("v=\\{t}")
}
`);
	expect(sites).toHaveLength(0);
});

test("an explicit move declare against a hoisted interpolation read reports nothing", () => {
	const sites = scan_checked(`
import System
pub func main = () {
	var t = "a".to_string()
	var u = t.copy()
	Console.write_line("v=\\{t}")
	Console.write_line(u)
}
`);
	expect(sites).toHaveLength(0);
});

test("a hoisted interpolation reading another variable still reports no inference", () => {
	// The retired analysis detected the last use here because the only later
	// reference was to `s`, not `t`. Under D3 the transfer is explicit, so
	// the scanner reports nothing regardless of what the interpolation reads.
	const sites = scan_checked(`
import System
pub func main = () {
	var t = "a".to_string()
	var s = "b".to_string()
	s = move t
	Console.write_line("v=\\{s}")
}
`);
	expect(sites).toHaveLength(0);
});
