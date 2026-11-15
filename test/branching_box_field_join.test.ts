import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Assignment-position branching RHS into a `Box<T>`-wrapper FIELD
// (`holder.node = match …`): the arms join into a temp, the displaced
// instance is destroyed + freed (the class-field reclamation), then the
// joined handle stores. A C switch statement cannot ride in expression
// position, and on aarch64 the match epilogue clobbers the store's registers.

describe("Box wrapper field reassignment from a match", () => {
	test("stores the joined handle and reclaims the displaced instance", async () => {
		const input = `
mv struct Node {
	var int value
}

mv struct Holder {
	var Box<Node> node
}

func main_test = (out int) {
	var h = Holder(Box<Node>(mv Node(1)))
	h.node = match 1 {
		case 0 -> Box<Node>(mv Node(10))
		case 1 -> Box<Node>(mv Node(20))
	} else -> Box<Node>(mv Node(0))
	return h.node.value
}

Console.write_line("\\{main_test()}")
`;
		await build_and_check_output(input, "branch_box_field", "20\n");
	});

	test("a loop store reclaims each displaced instance", async () => {
		const input = `
mv struct Node {
	var int value
}

mv struct Holder {
	var Box<Node> node
}

func main_test = (out int) {
	var h = Holder(Box<Node>(mv Node(0)))
	var int i = 0
	while i < 50 {
		h.node = match i % 2 {
			case 0 -> Box<Node>(mv Node(i))
			case 1 -> Box<Node>(mv Node(i + 1))
		} else -> Box<Node>(mv Node(0))
		i += 1
	}
	return h.node.value
}

Console.write_line("\\{main_test()}")
`;
		await build_and_check_output(input, "branch_box_field_loop", "50\n");
	});

	test("a call-shaped scrutinee survives the match epilogue", async () => {
		const input = `
mv struct Node {
	var int value
}

mv struct Holder {
	var Box<Node> node
}

func pick = (int n, out int) {
	return n
}

func main_test = (out int) {
	var h = Holder(Box<Node>(mv Node(1)))
	h.node = match pick(1) {
		case 0 -> Box<Node>(mv Node(10))
		case 1 -> Box<Node>(mv Node(20))
	} else -> Box<Node>(mv Node(0))
	return h.node.value
}

Console.write_line("\\{main_test()}")
`;
		await build_and_check_output(input, "branch_box_field_call_scrutinee", "20\n");
	});
});
