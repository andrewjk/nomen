// TODO: The original zig 044 exercise builds a circular linked list of Elephant
// structs with self-referential `ref Elephant tail` fields. To fully convert it
// we still need:
// - Ref field assignment: `a.tail = b` (store address of b into tail field of a)
// - Ref field dereference when reading: `e.tail` (load pointer, use as struct address)
// - Ref param reassignment from ref field: `e = e.tail` (reassign ref param through dereferenced pointer)
// - Self-referential struct init (auto-init includes `ref Elephant tail` param)
// - Arithmetic on ref params: `x = x + 1` (read through pointer, compute, write back)

import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
import parse_with_imports from "./parse_with_imports";

test("ziglings 044 quiz5 -- ref param reassignment", async () => {
	const input = `
import System

func setTo = (ref int x, int val) {
    x = val
}

pub func main = () {
    var int a = 10
    setTo(ref a, 42)
    Console.write("\\{a}")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "ziglings_044", "42", true);
});
