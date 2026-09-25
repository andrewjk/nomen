import { expect, describe, test } from "vite-plus/test";

import parse_with_imports from "./parse_with_imports";

// Arg-passing ownership gate: an OWNING value struct (string fields)
// passed as a bare alias (plain variable / field access, no `ref`/`move`)
// is rejected ONLY when the callee actually WRITES the param's string
// fields — that write strands its strdup'd assignment copy in the dead
// callee scope (the cross-scope leak). Read-only callees alias soundly
// (the owner keeps ownership) and stay legal.
describe("by-value struct arg gate", () => {
	test("gate: read-only callee stays legal", () => {
		const parsed = parse_with_imports(`
struct Info { var markup = "" }
func use = (Info p) {
	Console.write_line(p.markup)
}
var Info a = Info()
use(a)
`);
		expect(parsed.errors).toEqual([]);
	});

	test("gate: writing the param's string field errors", () => {
		const parsed = parse_with_imports(`
struct Info { var markup = "" }
func fill = (Info p) {
	p.markup = "written"
}
var Info a = Info()
fill(a)
`);
		expect(parsed.errors.some((e) => e.message.includes("cannot pass 'Info' by value"))).toBe(true);
	});
});
