import { expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Regression tests for the FOLLOWUP.md Map/Set `remove` item: backward-shift
// deletion moved entries with store_T (which strdups owning elements and
// leaves the source slot intact), leaking every displaced allocation.

async function build_and_run(input: string, name: string, expected: string) {
	for (const arch of ["aarch64", "c"] as const) {
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch, audit: true });
		await check_output(name, result, expected, { arch, audit: true });
	}
}

test("Map<string, int> remove does not leak shifted keys", async () => {
	const input = `
var Map<string, int> m = Map<string, int>()
var i = 0
while i < 60 {
	m.set(i.to_string(), i)
	i += 1
}
i = 0
while i < 60 {
	if i % 2 == 0 {
		m.remove(i.to_string())
	}
	i += 1
}
var string probe = 8.to_string()
Console.write_line("\\{m.length} \\{m.get_or(probe, -1)}")
`;
	await build_and_run(input, "map_remove_no_leak", "30 -1");
});

test("Set<string> remove does not leak shifted slots", async () => {
	const input = `
var Set<string> s = Set<string>()
var i = 0
while i < 60 {
	s.add(i.to_string())
	i += 1
}
i = 0
while i < 60 {
	if i % 2 == 0 {
		s.remove(i.to_string())
	}
	i += 1
}
var string probe = 8.to_string()
Console.write_line("\\{s.length} \\{s.has(probe)}")
`;
	await build_and_run(input, "set_remove_no_leak", "30 false");
});
