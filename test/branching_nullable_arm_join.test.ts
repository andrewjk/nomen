import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Assignment-position branching RHS with a NULLABLE-TYPED arm set
// (`n = match c { case .a -> maybe1 case .b -> maybe2 }` where every arm is
// `T?`): each arm writes the value into a join temp AND its own null-ness
// into the slot's `_has` flag (a `null` arm drops the flag only). Uniformly
// non-null arm sets keep the flag-as-1 join.

describe("nullable-typed arm sets joined into a nullable slot", () => {
	test("nullable locals with a null arm", async () => {
		const input = `
func main_test = (out int) {
	var int? a = 5
	var int? b = 7
	var int? n = null
	n = match 1 {
		case 0 -> a
		case 1 -> b
	} else -> null
	return n ?? -1
}

Console.write_line("\\{main_test()}")
`;
		await build_and_check_output(input, "branch_nullable_arms_null", "7\n");
	});

	test("the null arm lands null", async () => {
		const input = `
func main_test = (out int) {
	var int? a = 5
	var int? n = 9
	n = match 1 {
		case 0 -> a
		case 1 -> null
	} else -> a
	return n ?? -1
}

Console.write_line("\\{main_test()}")
`;
		await build_and_check_output(input, "branch_nullable_arms_pick_null", "-1\n");
	});

	test("a nullable struct slot joins per-arm flags", async () => {
		const input = `
struct Point {
	var int x
	var int y
}

func main_test = (out int) {
	var Point? p = Point(1, 1)
	var Point? q = Point(3, 4)
	p = match 1 {
		case 0 -> q
		case 1 -> null
	} else -> Point(9, 9)
	if p == null {
		return -1
	}
	return p.y
}

Console.write_line("\\{main_test()}")
`;
		await build_and_check_output(input, "branch_nullable_arms_struct", "-1\n");
	});

	test("a nullable struct field joins per-arm flags", async () => {
		const input = `
struct Point {
	var int x
	var int y
}

mv struct Holder {
	var Point? pt
}

func main_test = (out int) {
	var h = Holder(Point(1, 1))
	var Point? q = Point(3, 4)
	h.pt = match 1 {
		case 0 -> q
		case 1 -> q
	} else -> null
	if h.pt == null {
		return -1
	}
	return h.pt.y
}

Console.write_line("\\{main_test()}")
`;
		await build_and_check_output(input, "branch_nullable_arms_field", "4\n");
	});

	test("a scalar nullable field joins per-arm flags", async () => {
		const input = `
mv struct Cell {
	var int? ink
}

func main_test = (out int) {
	var c = Cell(1)
	var int? v = 8
	c.ink = match 1 {
		case 0 -> v
		case 1 -> null
	} else -> v
	return c.ink ?? -1
}

Console.write_line("\\{main_test()}")
`;
		await build_and_check_output(input, "branch_nullable_arms_scalar_field", "-1\n");
	});
});
