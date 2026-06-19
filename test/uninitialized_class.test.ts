import { describe, test, expect } from "vite-plus/test";

import parse from "../src/parse";
import parse_with_imports from "./parse_with_imports";

describe("uninitialized class variable errors", () => {
	test("access field on uninitialized var", () => {
		const input = `
class Foo {
    var int x
}

var Foo f
Console.write("\\{f.x}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not initialized"))).toBe(true);
	});

	test("use uninitialized var in expression", () => {
		const input = `
class Foo {
    var int x
}

var Foo f
const int y = f.x + 1
Console.write("\\{y}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not initialized"))).toBe(true);
	});

	test("access field on uninitialized var after partial if", () => {
		const input = `
class Foo {
    var int x
}

var Foo f
if true {
    f = Foo(10)
}
Console.write("\\{f.x}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not initialized"))).toBe(true);
	});

	test("access field on var initialized in all if branches", () => {
		const input = `
class Foo {
    var int x
}

var Foo f
if true {
    f = Foo(10)
} else {
    f = Foo(20)
}
Console.write("\\{f.x}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("access field on var initialized only in one if branch", () => {
		const input = `
class Foo {
    var int x
}

var Foo f
if true {
    f = Foo(10)
} else {
    f = Foo(20)
}
Console.write("\\{f.x}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("access field on var initialized in all match branches", () => {
		const input = `
class Foo {
    var int x
}

enum Color {
    case Red
    case Blue
}

var Foo f
var Color c = Color.Red
match c {
    case .Red {
        f = Foo(10)
    }
    case .Blue {
        f = Foo(20)
    }
}
Console.write("\\{f.x}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("access field on var initialized only in some match branches", () => {
		const input = `
class Foo {
    var int x
}

enum Color {
    case Red
    case Blue
}

var Foo f
var Color c = Color.Red
match c {
    case .Red {
        f = Foo(10)
    }
    else {
        Console.write("other")
    }
}
Console.write("\\{f.x}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not initialized"))).toBe(true);
	});

	test("access field on var initialized in all switch branches", () => {
		const input = `
class Foo {
    var int x
}

var Foo f
var bool b = true
switch {
    case b == true {
        f = Foo(10)
    }
    case b == false {
        f = Foo(20)
    }
}
Console.write("\\{f.x}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("var initialized after while loop still marked as possibly uninitialized", () => {
		const input = `
class Foo {
    var int x
}

var Foo f
var bool b = true
while b {
    f = Foo(10)
    b = false
}
Console.write("\\{f.x}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not initialized"))).toBe(true);
	});
});

describe("uninitialized class variable valid usage", () => {
	test("var initialized before use is fine", () => {
		const input = `
class Foo {
    var int x
}

var Foo f
f = Foo(10)
Console.write("\\{f.x}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("var initialized in all if branches is fine", () => {
		const input = `
class Foo {
    var int x
}

var Foo f
if true {
    f = Foo(10)
} else {
    f = Foo(20)
}
Console.write("\\{f.x}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("var initialized with value at declaration is fine", () => {
		const input = `
class Foo {
    var int x
}

var Foo f = Foo(10)
Console.write("\\{f.x}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});
});

describe("uninitialized primitive var errors", () => {
	test("use uninitialized var int in expression", () => {
		const input = `
var int y
if true {
    y = 22
}
var int z = 2 + y
Console.write("\\{z}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not initialized"))).toBe(true);
	});

	test("use uninitialized var int directly", () => {
		const input = `
var int y
Console.write("\\{y}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not initialized"))).toBe(true);
	});
});

describe("uninitialized primitive var valid usage", () => {
	test("var int assigned before use is fine", () => {
		const input = `
var int y
y = 22
Console.write("\\{y}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("var int assigned in all if branches is fine", () => {
		const input = `
var int y
if true {
    y = 10
} else {
    y = 20
}
Console.write("\\{y}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("var int initialized at declaration is fine", () => {
		const input = `
var int y = 42
Console.write("\\{y}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});
});
