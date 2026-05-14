import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

// TODO: do matches need to be exhaustive??

// BUILD
describe("match build", () => {
	test("match single case", async () => {
		const input = `
var x = 5
match x {
	case 5 {
		Console.write("five")
	}
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("match_single", result, "five");
	});

	test("match single case not matched", async () => {
		const input = `
var x = 3
var int result = 0
match x {
	case 5 {
		result = 1
	}
}
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("match_not_matched", result, "0");
	});

	test("match multiple cases first matches", async () => {
		const input = `
var x = 5
match x {
	case 5 {
		Console.write("five")
	}
	case 10 {
		Console.write("ten")
	}
	case 15 {
		Console.write("fifteen")
	}
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("match_first", result, "five");
	});

	test("match multiple cases second matches", async () => {
		const input = `
var x = 10
match x {
	case 5 {
		Console.write("five")
	}
	case 10 {
		Console.write("ten")
	}
	case 15 {
		Console.write("fifteen")
	}
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("match_second", result, "ten");
	});

	test("match multiple cases third matches", async () => {
		const input = `
var x = 15
match x {
	case 5 {
		Console.write("five")
	}
	case 10 {
		Console.write("ten")
	}
	case 15 {
		Console.write("fifteen")
	}
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("match_third", result, "fifteen");
	});

	test("match with else branch", async () => {
		const input = `
var x = 99
match x {
	case 5 {
		Console.write("five")
	}
	else {
		Console.write("other")
	}
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("match_else", result, "other");
	});

	test("match expression", async () => {
		const input = `
var x = 2
const y = match x {
	case 1 -> "one"
	case 2 -> "two"
	case 3 -> "three"
	else -> "other"
}
Console.write(y)
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("match_expression", result, "two");
	});

	test("match expression else branch", async () => {
		const input = `
var x = 99
const y = match x {
	case 1 -> "one"
	case 2 -> "two"
	else -> "other"
}
Console.write(y)
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("match_expression_else", result, "other");
	});

	test("match with variable assignment", async () => {
		const input = `
var int x = 10
var int result = 0
match x {
	case 5 {
		result = 1
	}
	case 10 {
		result = 2
	}
	case 15 {
		result = 3
	}
}
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("match_var_assign", result, "2");
	});

	test("match nested", async () => {
		const input = `
var int x = 3
var int y = 7
var int result = 0
match x {
	case 3 {
		match y {
			case 7 {
				result = 1
			}
			else {
				result = 2
			}
		}
	}
	else {
		result = 0
	}
}
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("match_nested", result, "1");
	});

	test("match inside for loop", async () => {
		const input = `
var int result = 0
for i of 0..5 {
	match i {
		case 2 {
			result = result + 10
		}
		case 3 {
			result = result + 20
		}
		else {
			result = result + 1
		}
	}
}
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("match_in_for", result, "33");
	});

	test("match expression with int result", async () => {
		const input = `
const x = 3
const y = match x {
	case 1 -> 10
	case 2 -> 20
	case 3 -> 30
	else -> 0
}
Console.write("\\{y}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("match_int_expression", result, "30");
	});

	test("match with 0 and 1 values", async () => {
		const input = `
var int x = 1
var int result = 0
match x {
	case 1 {
		result = 1
	}
	case 0 {
		result = 2
	}
}
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("match_01", result, "1");
	});

	test("match with negative values", async () => {
		const input = `
var int x = -1
var int result = 0
match x {
	case -1 {
		result = 1
	}
	case 0 {
		result = 2
	}
	else {
		result = 3
	}
}
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("match_negative", result, "1");
	});

	test("match with expression case values", async () => {
		const input = `
var int x = 5
var int result = 0
match x {
	case 2 + 3 {
		result = 1
	}
	else {
		result = 2
	}
}
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("match_expr_case", result, "1");
	});
});

// ERRORS
describe("match errors", () => {
	test("type mismatch case vs value", () => {
		const input = `
func test = (out int) {
	const x = 5
	match x {
		case "hello" {
		}
	}
	return 0
}
`;
		const expected = [
			test_error(input, "Match case type string does not match value type int", 5, 8),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
