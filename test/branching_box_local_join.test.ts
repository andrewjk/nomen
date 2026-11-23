import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Assignment-position branching RHS into a `Box<T>`-wrapper local. The local
// is the stamped `is_class` heap-handle storage: the word join stores the
// handle, and the class reassignment protocol must consume the anchor and
// reclaim the displaced instance (a plain word store leaked it on aarch64).

describe("Box wrapper local reassignment from a match", () => {
	test("the displaced instance is reclaimed (audit-clean)", async () => {
		const input = `
mv struct Node {
	var int value
}

func main_test = (out int) {
	var b = Box<Node>(mv Node(1))
	b = match 1 {
		case 0 -> Box<Node>(mv Node(10))
		case 1 -> Box<Node>(mv Node(20))
		case _ -> Box<Node>(mv Node(0))
	}
	return b.value
}

Console.write_line("\\{main_test()}")
`;
		await build_and_check_output(input, "branch_box_local", "20\n");
	});

	test("a loop reassignment reclaims each displaced instance", async () => {
		const input = `
mv struct Node {
	var int value
}

func main_test = (out int) {
	var b = Box<Node>(mv Node(0))
	var int i = 0
	while i < 50 {
		b = match i % 2 {
			case 0 -> Box<Node>(mv Node(i))
			case 1 -> Box<Node>(mv Node(i + 1))
			case _ -> Box<Node>(mv Node(0))
		}
		i += 1
	}
	return b.value
}

Console.write_line("\\{main_test()}")
`;
		await build_and_check_output(input, "branch_box_local_loop", "50\n");
	});
});
