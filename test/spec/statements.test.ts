import { describe, expect, test } from "vite-plus/test";

import { compile_main, compile_module } from "./_helpers.ts";

describe("spec: if/else", () => {
	test("basic if/else with blocks", () => {
		const input = `
var int x = 1
if x > 0 {
    Console.write("positive")
} else {
    Console.write("zero")
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("if expression with else", () => {
		const input = `
var int x = 1
const result = if x > 0 -> "positive"
               else -> "zero"
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("else if chain (nested else blocks)", () => {
		const input = `
var int x = 1
if x > 0 {
    Console.write("positive")
} else {
    if x < 0 {
        Console.write("negative")
    } else {
        Console.write("zero")
    }
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("else if keyword (SPEC gap: `else if` not yet parsed)", () => {
		const input = `
var int x = 1
if x > 0 {
    Console.write("positive")
} else if x < 0 {
    Console.write("negative")
} else {
    Console.write("zero")
}
`;
		const errors = compile_main(input);
		// TODO: enabled once the compiler parses the `else if` form (SPEC gap).
		expect(errors).toEqual([]);
	});
});

describe("spec: if expression", () => {
	test("if -> return syntax", () => {
		const input = `
var bool condition = true
const result = if condition -> "yes"
               else -> "no"
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: match statement", () => {
	test("match with else", () => {
		const input = `
var int x = 1
const result = match x {
    case 1 -> "one"
    case 2 -> "two"
    else -> "other"
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("match enum shorthand", () => {
		const input = `
enum Direction {
    case north
    case south
    case east
    case west
}
var direction = Direction.north
match direction {
    case .north -> Console.write("north")
    case .south -> Console.write("south")
    case .east -> Console.write("east")
    case .west -> Console.write("west")
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("match bool exhaustive", () => {
		const input = `
var bool flag = true
match flag {
    case true -> Console.write("yes")
    case false -> Console.write("no")
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("match enum with associated data (SPEC gap: not yet supported)", () => {
		const input = `
enum Result {
    case ok
    case error(int code)
}
const result = Result.error(10)
const message = match result {
    case .ok -> "it's ok"
    case .error(code) -> "error \\{code} encountered"
}
`;
		const errors = compile_main(input);
		// TODO: enabled once match on enum cases with associated data is supported (SPEC gap).
		expect(errors).toEqual([]);
	});
});

describe("spec: switch statement", () => {
	test("switch as expression", () => {
		const input = `
var int x = 5
const size = switch {
    case x > 100 -> "big"
    case x > 10 -> "medium"
    else -> "small"
}
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: while loop", () => {
	test("basic while", () => {
		const input = `
var int x = 0
while x < 10 {
    Console.write("\\{x}")
    x += 1
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("while with update clause", () => {
		const input = `
var int x = 0
while x < 10; x += 1 {
    Console.write("\\{x}")
}
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: for loop", () => {
	test("for-of array", () => {
		const input = `
const int[] items = [1, 2, 3]
for item of items {
    Console.write("\\{item}")
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("for-of range", () => {
		const input = `
for i of 0..10 {
    Console.write("\\{i}")
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("for-of with update clause", () => {
		const input = `
const int[] items = [1, 2, 3]
var total = 0
for item of items; total += item {
}
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: break and continue", () => {
	test("break and continue inside while", () => {
		const input = `
var bool should_exit = false
var bool should_skip = false
while true {
    if should_exit {
        break
    }
    if should_skip {
        continue
    }
}
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: return", () => {
	test("return value", () => {
		const input = `
func get = (out int) {
    return 5
}
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: let vs -> outside expressions", () => {
	test("let as return in function (SPEC gap: `let` not yet an implicit return)", () => {
		const input = `
func build = (int x, out string) {
    let "value is \\{x}"
}
`;
		const errors = compile_main(input);
		// TODO: enabled once the compiler treats `let` as an implicit return (SPEC gap).
		expect(errors).toEqual([]);
	});
});

describe("spec: let and arrow shorthand", () => {
	test("let and -> interchangeable in expression position", () => {
		const input = `
var int x = 1
const a = if x > 0 -> "yes"
          else -> "no"
const b = if x > 0 let "yes"
          else let "no"
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: panic", () => {
	test("panic with and without parens", () => {
		const input = `
panic "something went wrong"
panic("with parens")
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: todo", () => {
	test("todo with and without parens", () => {
		const input = `
todo "not implemented yet"
todo("with parens")
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: method/function calls as expressions", () => {
	test("match, switch, if as expressions", () => {
		const input = `
var int x = 5
const label = match x {
    case 1 -> "one"
    case 2 -> "two"
    else -> "other"
}
const size = switch {
    case x > 100 -> "big"
    case x > 10 -> "medium"
    else -> "small"
}
const verdict = if x > 0 -> "yes"
                else -> "no"
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: imports", () => {
	test("top-level imports", () => {
		const input = `
import System
import System/Controls
import System/Collections/List
`;
		expect(compile_module(input)).toEqual([]);
	});
});
