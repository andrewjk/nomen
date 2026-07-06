import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

describe("bitset build", () => {
	test("single bitset value", async () => {
		const input = `
bitset Options {
  case low
  case medium
  case high
}

var options = Options.high
Console.write("\\{options}")
`;
		await build_and_check_output(input, "bitset_single", "4");
	});

	test("combine bitset options with or", async () => {
		const input = `
bitset Flags {
  case read
  case write
  case execute
}

var flags = Flags.read | Flags.write
Console.write("\\{flags}")
`;
		await build_and_check_output(input, "bitset_combine_or", "3");
	});

	test("combine all bitset options", async () => {
		const input = `
bitset Perm {
  case read
  case write
  case exec
}

var p = Perm.read | Perm.write | Perm.exec
Console.write("\\{p}")
`;
		await build_and_check_output(input, "bitset_combine_all", "7");
	});

	test("add option to existing bitset", async () => {
		const input = `
bitset Flags {
  case read
  case write
}

var flags = Flags.read
flags = flags | Flags.write
Console.write("\\{flags}")
`;
		await build_and_check_output(input, "bitset_add_option", "3");
	});

	test("check if bitset has option set", async () => {
		const input = `
bitset Flags {
  case read
  case write
}

var flags = Flags.read | Flags.write
const has_write = (flags & Flags.write) == Flags.write
Console.write("\\{has_write}")
`;
		await build_and_check_output(input, "bitset_check_option", "true");
	});

	test("check if bitset option not set", async () => {
		const input = `
bitset Flags {
  case read
  case write
  case exec
}

var flags = Flags.read | Flags.write
const has_exec = (flags & Flags.exec) == Flags.exec
Console.write("\\{has_exec}")
`;
		await build_and_check_output(input, "bitset_option_not_set", "false");
	});

	test("bitset with if condition", async () => {
		const input = `
bitset Flags {
  case read
  case write
}

var flags = Flags.read | Flags.write
if (flags & Flags.write) == Flags.write {
  Console.write("writable")
} else {
  Console.write("readonly")
}
`;
		await build_and_check_output(input, "bitset_if_condition", "writable");
	});

	test("bitset toggle with xor", async () => {
		const input = `
bitset Flags {
  case read
  case write
}

var flags = Flags.read | Flags.write
flags = flags ^ Flags.write
Console.write("\\{flags}")
`;
		await build_and_check_output(input, "bitset_toggle_xor", "1");
	});

	test("reassign bitset variable", async () => {
		const input = `
bitset Options {
  case low
  case medium
  case high
}

var opts = Options.low
opts = Options.high
Console.write("\\{opts}")
`;
		await build_and_check_output(input, "bitset_reassign", "4");
	});

	test("pub bitset", async () => {
		const input = `
pub bitset Mode {
  case fast
  case safe
}

var m = Mode.fast | Mode.safe
Console.write("\\{m}")
`;
		await build_and_check_output(input, "bitset_pub", "3");
	});

	test("bitset and to narrow options", async () => {
		const input = `
bitset Flags {
  case read
  case write
  case exec
}

var flags = Flags.read | Flags.write | Flags.exec
var masked = flags & Flags.read
Console.write("\\{masked}")
`;
		await build_and_check_output(input, "bitset_and_mask", "1");
	});

	test("bitset shorthand in var declaration", async () => {
		const input = `
bitset Flags {
  case read
  case write
  case exec
}

var Flags f = .read
Console.write("\\{f}")
`;
		await build_and_check_output(input, "bitset_shorthand_decl", "1");
	});

	test("bitset shorthand in assignment", async () => {
		const input = `
bitset Flags {
  case read
  case write
}

var flags = Flags.read
flags = .write
Console.write("\\{flags}")
`;
		await build_and_check_output(input, "bitset_shorthand_assign", "2");
	});

	test("bitset shorthand in comparison", async () => {
		const input = `
bitset Flags {
  case read
  case write
}

var flags = Flags.read | Flags.write
if (flags & .write) == .write {
  Console.write("writable")
} else {
  Console.write("readonly")
}
`;
		await build_and_check_output(input, "bitset_shorthand_compare", "writable");
	});

	test("bitset shorthand C output", () => {
		const input = `
bitset Flags {
  case read
  case write
}

func main = () {
  var Flags f = .read
  if f == .write {
    Console.write("write")
  }
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "c" });
		expect(parsed.errors).toEqual([]);
		expect(result.code).toContain("Flags_read");
		expect(result.code).toContain("Flags_write");
	});
});

describe("bitset errors", () => {
	test("bitset without braces", () => {
		const input = `
bitset Options
`;
		const expected = [test_error(input, "Expected token", 3, 0)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("unknown bitset case", () => {
		const input = `
bitset Flags {
  case read
  case write
}

func main = () {
  var f = Flags.execute
}
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Unknown bitset case");
	});
});
