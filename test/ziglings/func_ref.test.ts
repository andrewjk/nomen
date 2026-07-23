import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
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
	await build_and_check_output(input, "ziglings_func_ref1", "hello world\n", true);
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
	await build_and_check_output(input, "ziglings_func_ref2", "inferred!\n", true);
});
