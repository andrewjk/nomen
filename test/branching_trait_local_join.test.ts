import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Assignment-position branching RHS into a TRAIT-typed local
// (`var Speaker s = match … { case .a -> Dog() }` and `s = match …`). The
// arms are uniformly fresh temporaries of one concrete conformer, so the
// backend joins them into a concrete-struct temp and boxes the winner at the
// join point (the return path's concrete-branch boxing, lifted), reclaiming
// the displaced handle through the trait's destroy shim. Uniformly
// trait-typed handle arms join the handle word instead.

describe("trait-typed local declaration from a match", () => {
	test("concrete conformer arms box the winner", async () => {
		const input = `
trait Speaker { func speak = (self, out string) }

mv struct Dog : Speaker {
	mv string name
	func speak = (self, out string) { return self.name.copy() }
}

func main_test = (out int) {
	var Speaker s = match 1 {
		case 0 -> Dog("A")
		case 1 -> Dog("B")
		case _ -> Dog("C")
	}
	Console.write_line(s.speak())
	return 0
}

Console.write_line("\\{main_test()}")
`;
		await build_and_check_output(input, "branch_trait_decl_concrete", "B\n0\n");
	});

	test("trait-handle arms join the handle word", async () => {
		const input = `
trait Speaker { func speak = (self, out string) }

mv struct Dog : Speaker {
	mv string name
	func speak = (self, out string) { return self.name.copy() }
}

func mk = (string n, out Speaker) {
	return Dog(mv n)
}

func main_test = (out int) {
	var Speaker s = match 1 {
		case 0 -> mk("A")
		case 1 -> mk("B")
		case _ -> mk("C")
	}
	Console.write_line(s.speak())
	return 0
}

Console.write_line("\\{main_test()}")
`;
		await build_and_check_output(input, "branch_trait_decl_handles", "B\n0\n");
	});
});

describe("trait-typed local reassignment from a match", () => {
	test("concrete conformer arms box the winner and reclaim the displaced handle", async () => {
		const input = `
trait Speaker { func speak = (self, out string) }

mv struct Dog : Speaker {
	mv string name
	func speak = (self, out string) { return self.name.copy() }
}

func main_test = (out int) {
	var Speaker s = Dog("init")
	s = match 1 {
		case 0 -> Dog("A")
		case 1 -> Dog("B")
		case _ -> Dog("C")
	}
	Console.write_line(s.speak())
	return 0
}

Console.write_line("\\{main_test()}")
`;
		await build_and_check_output(input, "branch_trait_reassign_concrete", "B\n0\n");
	});

	test("trait-handle arms join the handle word and reclaim the displaced handle", async () => {
		const input = `
trait Speaker { func speak = (self, out string) }

mv struct Dog : Speaker {
	mv string name
	func speak = (self, out string) { return self.name.copy() }
}

func mk = (string n, out Speaker) {
	return Dog(mv n)
}

func main_test = (out int) {
	var Speaker s = mk("init")
	s = match 1 {
		case 0 -> mk("A")
		case 1 -> mk("B")
		case _ -> mk("C")
	}
	Console.write_line(s.speak())
	return 0
}

Console.write_line("\\{main_test()}")
`;
		await build_and_check_output(input, "branch_trait_reassign_handles", "B\n0\n");
	});

	test("a loop reassignment reclaims each displaced handle", async () => {
		const input = `
trait Speaker { func speak = (self, out string) }

mv struct Dog : Speaker {
	mv string name
	func speak = (self, out string) { return self.name.copy() }
}

func main_test = (out int) {
	var Speaker s = Dog("start")
	var int i = 0
	while i < 20 {
		s = match i % 2 {
			case 0 -> Dog("even")
			case 1 -> Dog("odd")
			case _ -> Dog("?")
		}
		i += 1
	}
	Console.write_line(s.speak())
	return 0
}

Console.write_line("\\{main_test()}")
`;
		await build_and_check_output(input, "branch_trait_reassign_loop", "odd\n0\n");
	});
});
