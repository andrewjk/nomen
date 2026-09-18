// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { expect, test } from "vite-plus/test";

import { lower_function } from "../../src/nir/from_ast";
import parse_with_imports from "../parse_with_imports";
import { expect_byte_identical } from "./_helpers.ts";

test("nested struct statements lower to opaque and stay NIR-eligible", () => {
	const source = `
func nested_type = (out int) {
    struct P {
        var int x
    }
    var int v = 3
    if v > 0 {
        return v
    }
    return 0
}
Console.write("\\{nested_type()}")
`;
	// White-box: the nested struct declaration lowers to `opaque` WITHOUT
	// recording (type declarations are skipped by the block loop — their IR
	// entries are never dispatched), so the function stays NIR-eligible.
	const parsed = parse_with_imports(source);
	const walk = (n: any): any[] => {
		if (!n || typeof n !== "object") return [];
		if (Array.isArray(n)) return n.flatMap(walk);
		const found = n.node_type === "func" ? [n] : [];
		return found.concat(
			Object.keys(n).flatMap((k) => (k === "parent" || k === "scope" ? [] : walk(n[k]))),
		);
	};
	const fn = walk(parsed.root).find((f) => f.name === "nested_type");
	expect(fn).toBeTruthy();
	const nir = lower_function(fn);
	expect([...nir.unknown_kinds]).toEqual([]);
	expect(nir.body.some((s) => s.kind === "opaque")).toBe(true);
	expect_byte_identical(source);
});
