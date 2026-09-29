import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// `List<T>` params were reported corrupted (empty) on the C backend. Every
// shape exercised here — positional params, class/struct/value element types,
// use after an internal call, and a temporary `out List<T>` argument — passes
// on both backends with the audit allocator on.

describe("List<T> parameter integrity", () => {
	test("List params in every position with surrounding scalars", async () => {
		const input = `
func after_str = (string tag, List<int> xs, out int) {
	return xs.length + tag.length
}

func between = (int a, List<int> xs, string b, out int) {
	return xs.length + a + b.length
}

func temp_arg = (List<int> xs, out int) {
	return xs.length
}

func caller_len = (out List<int>) {
	var l = List<int>()
	l.push(1)
	l.push(2)
	l.push(3)
	l.push(4)
	return l
}

var l = List<int>()
l.push(1)
l.push(2)
l.push(3)
Console.write("after_str=\\{after_str("hi", l)}\\n")
Console.write("between=\\{between(5, l, "xyz")}\\n")
Console.write("temp=\\{temp_arg(caller_len())}\\n")
`;
		await build_and_check_output(
			input,
			"list_param_positions",
			"after_str=5\nbetween=11\ntemp=4\n",
		);
	});

	test("value-struct, class and string element lists", async () => {
		const input = `
struct Pt {
	var int x
	var int y
}

class Rule {
	pub var string name = "r"
}

func sum_pts = (List<Pt> pts, out int) {
	var t = 0
	for p of pts {
		t = t + p.x + p.y
	}
	return t
}

func count_rules = (List<Rule> rules, out int) {
	var n = 0
	for r of rules {
		n = n + 1
	}
	return n
}

func join_names = (List<string> names, out string) {
	var acc = ""
	for n of names {
		acc = acc + n
	}
	return acc
}

func dec = (int x, out int) {
	return x - 1
}

func use_after_call = (List<int> xs, out int) {
	var a = dec(xs.length)
	return xs.length + a
}

var pts = List<Pt>()
pts.push(Pt(1, 2))
pts.push(Pt(3, 4))
Console.write("sum=\\{sum_pts(pts)}\\n")

var rules = List<Rule>()
rules.push(Rule())
rules.push(Rule())
Console.write("rules=\\{count_rules(rules)}\\n")

var names = List<string>()
names.push("al")
names.push("ice")
Console.write("names=\\{join_names(names)}\\n")

var xs = List<int>()
xs.push(1)
xs.push(2)
Console.write("uac=\\{use_after_call(xs)}\\n")
`;
		await build_and_check_output(
			input,
			"list_param_elements",
			"sum=10\nrules=2\nnames=alice\nuac=3\n",
		);
	});
});
