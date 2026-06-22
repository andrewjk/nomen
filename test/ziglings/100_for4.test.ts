import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// INCOMPATIBILITIES:
// - Zig uses `for (hex_nums, dec_nums) |hn, dn|` (parallel iteration).
//   Echo doesn't support multi-object for loops.
//   Workaround: for-of over one array with a manual index counter (`; i += 1`).

test("ziglings 100 for4 -- errors", () => {
	const input = `
import System

pub func main = () {
    var hex_nums = Array(11, 42, 119)
    var dec_nums = Array(11, 42, ???)

    var int i = 0
    for hn of hex_nums; i += 1 {
        var int dn = dec_nums.at(i)
        if hn != dn {
            Console.write("Uh oh! Found a mismatch: \\{hn} vs \\{dn}\\n")
            return
        }
    }

    Console.write("Arrays match!\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 100 for4 -- fixed", () => {
	const input = `
import System

pub func main = () {
    var hex_nums = Array(11, 42, 119)
    var dec_nums = Array(11, 42, 119)

    var int i = 0
    for hn of hex_nums; i += 1 {
        var int dn = dec_nums.at(i)
        if hn != dn {
            Console.write("Uh oh! Found a mismatch: \\{hn} vs \\{dn}\\n")
            return
        }
    }

    Console.write("Arrays match!\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 100 for4 -- build", async () => {
	const input = `
import System

pub func main = () {
    var hex_nums = Array(11, 42, 119)
    var dec_nums = Array(11, 42, 119)

    var int i = 0
    for hn of hex_nums; i += 1 {
        var int dn = dec_nums.at(i)
        if hn != dn {
            Console.write("Uh oh! Found a mismatch: \\{hn} vs \\{dn}\\n")
            return
        }
    }

    Console.write("Arrays match!\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("100", built, "Arrays match!\n");
});
