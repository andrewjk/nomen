// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { expect, test } from "vite-plus/test";

import { lower_function } from "../../src/nir/from_ast";
import parse_with_imports from "../parse_with_imports";
import { expect_byte_identical } from "./_helpers.ts";

test("function-typed declarations (`var func`) stay NIR-eligible byte-identically", () => {
	// A declared function variable's value IS a FunctionNode — it lowers to a
	// nameless leaf, and the seam routes build_node to it (which builds the
	// function and emits its label exactly as the AST walk did).
	const source = `
pub func main = () {
    var func (int) handler {
        Console.write_line("handled")
    }
    handler(1)
}
`;
	const parsed = parse_with_imports(source);
	expect(parsed.errors).toEqual([]);
	const walk = (n: any): any[] => {
		if (!n || typeof n !== "object") return [];
		if (Array.isArray(n)) return n.flatMap(walk);
		const found = n.node_type === "func" ? [n] : [];
		return found.concat(
			Object.keys(n).flatMap((k) => (k === "parent" || k === "scope" ? [] : walk(n[k]))),
		);
	};
	const fn = walk(parsed.root).find(
		(f) => f.name === "main" && f.statements.some((s: any) => s.node_type === "declare"),
	);
	expect(fn).toBeTruthy();
	const nir = lower_function(fn);
	expect([...nir.unknown_kinds]).toEqual([]);
	const decl = nir.body.find((s) => s.kind === "declare");
	expect(
		decl &&
			decl.kind === "declare" &&
			decl.decl.init?.kind === "leaf" &&
			decl.decl.init.node.node_type === "func",
	).toBe(true);
	expect_byte_identical(source);
});
