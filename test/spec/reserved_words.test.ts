import { describe, expect, test } from "vite-plus/test";

import parse from "../../src/parse.ts";
import test_error from "../test_error.ts";
import { compile_main, core } from "./_helpers.ts";

describe("spec: reserved words", () => {
	test("reserved word as variable name is an error", () => {
		const input = `import System

pub func main = () {
	var out = StringBuilder()
}
`;
		expect(parse(input, core).errors).toEqual([
			test_error(input, "'out' is a reserved word and cannot be used as a name", 4, 6),
		]);
	});

	test("keyword method names are callable", () => {
		const input = `
const m = Regex.match("[0-9]+", "abc123")
Console.write("\\{m}")
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("class is retired with a dedicated error", () => {
		const input = `
class Box { var int value }
`;
		const parsed = parse(input, core);
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"'class' has retired — declare `mv struct` (single-owner, move-only) and spell sharing where it happens (`ref`, `Box<T>`, `Mutex<T>`, `WeakHandle<T>`)",
				2,
				1,
			),
		]);
	});

	test("try and catch are reserved (the error-side handler)", () => {
		const input = `import System

pub func main = () {
	var try = 1
	var catch = 2
}
`;
		expect(parse(input, core).errors).toEqual([
			test_error(input, "'try' is a reserved word and cannot be used as a name", 4, 6),
			test_error(input, "'catch' is a reserved word and cannot be used as a name", 5, 6),
		]);
	});

	test("keyword type names are declarable and callable", () => {
		const input = `
struct view {
    var int id
}

pub func main = () {
    var v = view(7)
    Console.write("\\{v.id}")
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("a keyword trait name conforms and binds trait-typed", () => {
		const input = `
trait view {
    func draw = (self)
}

struct Window: view {
    pub func draw = (self) {
        Console.write("drawing")
    }
}

pub func main = () {
    const view w = Window()
    w.draw()
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("bindings named with a reserved word still error", () => {
		const input = `import System

pub func main = () {
	var string view = "x"
}
`;
		expect(parse(input, core).errors).toEqual([
			test_error(input, "'view' is a reserved word and cannot be used as a name", 4, 13),
		]);
	});

	test("keyword case names are declarable and dot-accessed", () => {
		const input = `
enum Status {
    case todo
    case done
    case unsafe
}

bitset Perm {
    case read
    case import
}

func label = (Status s, out string) {
    return match s {
        case .todo -> "todo"
        case .done -> "done"
        case .unsafe -> "unsafe"
    }
}

pub func main = () {
    var s = Status.todo
    Console.write(label(s))
    s = .done
    Console.write(label(s))
    Console.write("\\{s == Status.done}")
    var flags = Perm.read | Perm.import
    Console.write("\\{flags == Perm.import}")
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("case payload parameter names stay reserved", () => {
		const input = `import System

enum Res {
	case ok(int out)
}
`;
		expect(parse(input, core).errors).toEqual([
			test_error(input, "'out' is a reserved word and cannot be used as a name", 4, 14),
		]);
	});
});
