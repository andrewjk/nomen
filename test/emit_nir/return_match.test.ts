// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { expect, test } from "vite-plus/test";

import { lower_function } from "../../src/nir/from_ast";
import parse_with_imports from "../parse_with_imports";
import { expect_byte_identical } from "./_helpers.ts";

test("return match emits NIR-natively through the join-slot path", () => {
	const source = `
func pick = (int x, out int) {
    return match x {
        case 1 -> 10
        else -> 20
    }
}
Console.write("\\{pick(1)} \\{pick(2)}")
`;
	// White-box: a match in return-value position lowers to a `flow` expr
	// (was: `other` → whole-function fallback). The NIR return arm descends
	// the expression seam, whose flow arm routes the ORIGINAL match node
	// through build_node to the same join-slot builders — byte-identical.
	const parsed = parse_with_imports(source);
	const walk = (n: any): any[] => {
		if (!n || typeof n !== "object") return [];
		if (Array.isArray(n)) return n.flatMap(walk);
		const found = n.node_type === "func" ? [n] : [];
		return found.concat(
			Object.keys(n).flatMap((k) => (k === "parent" || k === "scope" ? [] : walk(n[k]))),
		);
	};
	const fn = walk(parsed.root).find((f) => f.name === "pick");
	expect(fn).toBeTruthy();
	const nir = lower_function(fn);
	expect([...nir.unknown_kinds]).toEqual([]);
	const ret = nir.body.find((s) => s.kind === "return");
	expect(ret && ret.kind === "return" && ret.value?.kind === "flow").toBe(true);
	expect_byte_identical(source);
});
