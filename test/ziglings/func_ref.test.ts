import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("bare func ref -- Console.write with explicit type", async () => {
	const input = `
import System

pub func main = () {
    var func (string,) print = Console.write
    print("hello world\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("func_ref1", built, "hello world\n");
});

test("bare func ref -- Console.write inferred type", async () => {
	const input = `
import System

pub func main = () {
    var f = Console.write
    f("inferred!\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("func_ref2", built, "inferred!\n");
});
