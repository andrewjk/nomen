import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

// BUILD
describe("switch build", () => {
	test("switch single case", async () => {
		const input = `
var x = 10
switch {
	case x > 5 {
		Console.write("big")
	}
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("switch_single", result, "big");
	});

	test("switch single case not matched", async () => {
		const input = `
var x = 10
var int result = 0
switch {
	case x > 20 {
		result = 1
	}
}
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("switch_not_matched", result, "0");
	});

	test("switch multiple cases first matches", async () => {
		const input = `
var x = 10
switch {
	case x > 9 {
		Console.write("big")
	}
	case x > 5 {
		Console.write("medium")
	}
	case x > 0 {
		Console.write("small")
	}
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("switch_first_matches", result, "big");
	});

	test("switch multiple cases second matches", async () => {
		const input = `
var x = 7
switch {
	case x > 9 {
		Console.write("big")
	}
	case x > 5 {
		Console.write("medium")
	}
	case x > 0 {
		Console.write("small")
	}
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("switch_second_matches", result, "medium");
	});

	test("switch multiple cases third matches", async () => {
		const input = `
var x = 3
switch {
	case x > 9 {
		Console.write("big")
	}
	case x > 5 {
		Console.write("medium")
	}
	case x > 0 {
		Console.write("small")
	}
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("switch_third_matches", result, "small");
	});

	test("switch with else branch", async () => {
		const input = `
const x = 10
switch {
	case x > 20 {
		Console.write("big")
	}
	else {
		Console.write("small")
	}
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("switch_else", result, "small");
	});

	test("switch expression", async () => {
		const input = `
var x = 10
const y = switch {
	case x > 9 -> "big"
	case x > 5 -> "medium"
	case x > 0 -> "small"
	else -> "nothing"
}
Console.write(y)
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("switch_expression", result, "big");
	});

	test("switch expression else branch", async () => {
		const input = `
var x = -1
const y = switch {
	case x > 9 -> "big"
	case x > 5 -> "medium"
	case x > 0 -> "small"
	else -> "nothing"
}
Console.write(y)
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("switch_expression_else", result, "nothing");
	});

	test("switch with variable assignment", async () => {
		const input = `
var int x = 10
var int result = 0
switch {
	case x > 15 {
		result = 3
	}
	case x > 5 {
		result = 2
	}
	case x > 0 {
		result = 1
	}
}
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("switch_var_assign", result, "2");
	});

	test("switch with comparison operators", async () => {
		const input = `
var int result = 0
const x = 3
switch {
	case x >= 3 {
		result = result + 1
	}
	case x <= 3 {
		result = result + 10
	}
}
switch {
	case x != 3 {
		result = result + 10
	}
	case x == 3 {
		result = result + 1
	}
}
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("switch_comparisons", result, "2");
	});

	test("switch with logical operators", async () => {
		const input = `
var int result = 0
const x = 5
switch {
	case x > 3 && x < 7 {
		result = 1
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
		await check_output("switch_logical", result, "1");
	});

	test("nested switch", async () => {
		const input = `
var int x = 5
var int y = 3
var int result = 0
switch {
	case x > 3 {
		switch {
			case y > 5 {
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
		await check_output("switch_nested", result, "2");
	});

	test("switch expression with int result", async () => {
		const input = `
const x = 7
const y = switch {
	case x > 9 -> 1
	case x > 5 -> 2
	else -> 3
}
Console.write("\\{y}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("switch_int_expression", result, "2");
	});

	test("switch inside for loop", async () => {
		const input = `
var int result = 0
for i of 0..5 {
	switch {
		case i == 2 {
			result = result + 10
		}
		case i == 3 {
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
		await check_output("switch_in_for", result, "33");
	});

	test("switch with negation", async () => {
		const input = `
const x = 5
var int result = 0
switch {
	case !true {
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
		await check_output("switch_negation", result, "2");
	});
});

// ERRORS
describe("switch errors", () => {
	test("string condition", () => {
		const input = `
switch {
	case "hi" {
	}
}
`;
		const expected = [test_error(input, "Switch case condition must be a bool, not string", 3, 7)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("int condition", () => {
		const input = `
switch {
	case 42 {
	}
}
`;
		const expected = [test_error(input, "Switch case condition must be a bool, not int", 3, 7)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
