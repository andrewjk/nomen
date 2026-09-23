import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Regression tests for the FOLLOWUP.md Map/Set `remove` item: backward-shift
// deletion moved entries with store (which strdups owning elements and
// leaves the source slot intact), leaking every displaced allocation.

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
	await build_and_check_output(input, "map_remove_no_leak", "30 -1");
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
	await build_and_check_output(input, "set_remove_no_leak", "30 false");
});
