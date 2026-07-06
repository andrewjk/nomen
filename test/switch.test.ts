import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
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
		await build_and_check_output(input, "switch_single", "big");
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
		await build_and_check_output(input, "switch_not_matched", "0");
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
		await build_and_check_output(input, "switch_first_matches", "big");
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
		await build_and_check_output(input, "switch_second_matches", "medium");
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
		await build_and_check_output(input, "switch_third_matches", "small");
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
		await build_and_check_output(input, "switch_else", "small");
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
		await build_and_check_output(input, "switch_expression", "big");
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
		await build_and_check_output(input, "switch_expression_else", "nothing");
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
		await build_and_check_output(input, "switch_var_assign", "2");
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
		await build_and_check_output(input, "switch_comparisons", "2");
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
		await build_and_check_output(input, "switch_logical", "1");
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
		await build_and_check_output(input, "switch_nested", "2");
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
		await build_and_check_output(input, "switch_int_expression", "2");
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
		await build_and_check_output(input, "switch_in_for", "33");
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
		await build_and_check_output(input, "switch_negation", "2");
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
		const expected = Array(
			test_error(input, "Switch case condition must be a bool, not string", 3, 7),
		);
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
		const expected = Array(
			test_error(input, "Switch case condition must be a bool, not int", 3, 7),
		);
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
