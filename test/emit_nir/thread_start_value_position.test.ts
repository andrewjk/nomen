// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { expect, test } from "vite-plus/test";

import { lower_function } from "../../src/nir/from_ast";
import parse_with_imports from "../parse_with_imports";
import { expect_byte_identical } from "./_helpers.ts";

test("value-position Thread().start() lowers to the method_call expr and stays NIR-eligible", () => {
	const source = `
func work = (uint64 arg) {
    Console.write_line("worked")
}
pub func main = () {
    var t = Thread(work(3)).start()
    t.wait()
}
`;
	const parsed = parse_with_imports(source);
	const walk = (n: any): any[] => {
		if (!n || typeof n !== "object") return [];
		if (Array.isArray(n)) return n.flatMap(walk);
		const found = n.node_type === "func" ? [n] : [];
		return found.concat(
			Object.keys(n).flatMap((k) => (k === "parent" || k === "scope" ? [] : walk(n[k]))),
		);
	};
	// NOTE: parse_with_imports wraps the source with a synthetic main stub —
	// pick the USER main (the one holding the declare).
	const fn = walk(parsed.root).find(
		(f) => f.name === "main" && f.statements.some((s: any) => s.node_type === "declare"),
	);
	expect(fn).toBeTruthy();
	const nir = lower_function(fn);
	expect([...nir.unknown_kinds]).toEqual([]);
	const decl = nir.body.find((s) => s.kind === "declare");
	// The Thread-form spawn lowers as the standard method_call expr (the
	// spawn trampoline is emitted from the access annotations at build time).
	expect(decl && decl.kind === "declare" && decl.decl.init?.kind === "method_call").toBe(true);
	expect_byte_identical(source);
});
