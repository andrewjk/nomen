import { expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

test("char_code_at constrained: constant in-bounds, proven dynamic", async () => {
	const input = `
import System

pub func main = () {
    var string s = "abc"
    Console.write("\\{s.char_code_at(0)} \\{s.char_code_at(2)}")
    var int i = 0
    while i < s.length {
        Console.write(" \\{s.char_code_at(i)}")
        i += 1
    }
}
`;
	await build_and_check_output(input, "char_code_at_constrained", "97 99 97 98 99", true);
});

test("char_code_at constraint rejects bad indexes at compile time", () => {
	const base = `
import System

pub func main = () {
    var string s = "abc"
`;
	// constant out-of-bounds
	let parsed = parse_raw(`${base}
    Console.write(s.char_code_at(3))
}
`);
	expect(
		parsed.errors.some((e) => e.message.includes("Parameter constraint not satisfied")),
		JSON.stringify(parsed.errors),
	).toBe(true);

	// negative constant
	parsed = parse_raw(`${base}
    Console.write(s.char_code_at(-1))
}
`);
	expect(
		parsed.errors.some((e) => e.message.includes("Parameter constraint not satisfied")),
		JSON.stringify(parsed.errors),
	).toBe(true);

	// dynamic but unproven
	parsed = parse_raw(`${base}
    var int i = caller_supplied()
    Console.write(s.char_code_at(i))
}

func caller_supplied = (out int) {
    return 0
}
`);
	expect(
		parsed.errors.some((e) => e.message.includes("Parameter constraint cannot be verified")),
		JSON.stringify(parsed.errors),
	).toBe(true);
});
