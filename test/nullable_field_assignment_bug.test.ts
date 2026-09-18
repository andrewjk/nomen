import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// BUG: assigning to a nullable struct field does not update the field's
// null-state, so subsequent `field == null` checks still report null even
// though the value was stored (interpolating the field shows the value).
//
// Additionally, assigning a nullable field through a `ref` parameter does not
// take effect at all — reading the field back inside the same function still
// sees the old value.
//
// The net effect is that nullable struct fields can be written but their
// nullness can never be cleared, which breaks the "set once" / optional-target
// pattern used throughout the codebase (e.g. optional goals, cached values).

describe("nullable field assignment bug", () => {
	test("== null after assigning a value reports not-null", async () => {
		const input = `
struct Money {
	var int cents
}
struct S {
	var Money? g = null
}
var S s = S()
s.g = Money(5)
if s.g == null {
	Console.write("STILL NULL")
} else {
	Console.write("SET OK")
}
`;
		await build_and_check_output(input, "nullable_field_null_check_bug", "SET OK");
	});

	test("nullable field set through ref parameter is visible after the call", async () => {
		const input = `
struct Money {
	var int cents
	func to_string = (self, out string) {
		return "\\{self.cents}"
	}
}
struct Budget {
	var Money? goal = null
}
func set_goal = (ref Budget budget, Money target) {
	budget.goal = target
}
func has_goal = (Budget budget, out int) {
	if budget.goal == null {
		return 0
	}
	return 1
}
var Budget budget = Budget()
set_goal(ref budget, Money(200000))
Console.write("\\{has_goal(budget)}")
`;
		await build_and_check_output(input, "nullable_field_ref_assign_bug", "1");
	});
});
