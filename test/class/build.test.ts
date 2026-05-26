import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import parse_with_imports from "../ziglings/parse_with_imports";

const execPromise = util.promisify(exec);

function postprocess_macos(code: string): string {
	code = code.replace(/\bbl printf\b/g, "bl _printf");
	code = code.replace(/\bbl snprintf\b/g, "bl _snprintf");
	code = code.replace(/\bbl malloc\b/g, "bl _malloc");
	code = code.replace(/\bbl free\b/g, "bl _free");
	code = code.replace(/\bmain:\n/g, ".globl _main\n_main:\n");
	return code;
}

async function compile_and_run(name: string, source: string): Promise<string> {
	const folder = path.join(".", "test", "class", "out", name);
	if (!fs.existsSync(folder)) {
		fs.mkdirSync(folder, { recursive: true });
	}

	const parsed = parse_with_imports(source);
	expect(parsed.errors).toEqual([]);

	const built = build(parsed.root, { arch: "aarch64" });
	const code = postprocess_macos(built.code);

	const codefile = path.join(folder, "main.s");
	const outfile = path.join(folder, "main.out");
	const outputfile = path.join(folder, "output.txt");

	if (fs.existsSync(codefile)) {
		const previous_code = fs.readFileSync(codefile, "utf-8");
		if (previous_code === code && fs.existsSync(outputfile)) {
			return fs.readFileSync(outputfile, "utf-8");
		}
	}

	fs.writeFileSync(codefile, code);
	const result = await execPromise(`clang -x assembler ${codefile} -o ${outfile} && ${outfile}`);
	fs.writeFileSync(outputfile, result.stdout);
	if (result.stderr && result.stderr.includes("error:")) {
		throw new Error(result.stderr);
	}
	return result.stdout;
}

test("class basic construction and field access", async () => {
	const source = `
import System

class Point {
    var int x
    var int y
}

pub func main = () {
    var p = Point(1, 2)
    Console.write("\\{p.x},\\{p.y}\\n")
}
`;
	const output = await compile_and_run("basic", source);
	expect(output).toBe("1,2\n");
});

test("class method call", async () => {
	const source = `
import System

class Counter {
    var int count

    func increment = (var self) {
        self.count = self.count + 1
    }
}

pub func main = () {
    var c = Counter(0)
    c.increment()
    c.increment()
    c.increment()
    Console.write("\\{c.count}\\n")
}
`;
	const output = await compile_and_run("method", source);
	expect(output).toBe("3\n");
});

test("class assignment shares reference", async () => {
	const source = `
import System

class Point {
    var int x
    var int y
}

pub func main = () {
    var p = Point(10, 20)
    var q = p
    q.x = 99
    Console.write("\\{p.x}\\n")
}
`;
	const output = await compile_and_run("shared", source);
	expect(output).toBe("99\n");
});

test("class as function parameter", async () => {
	const source = `
import System

class Point {
    var int x
    var int y
}

func getX = (Point p) {
    return p.x
}

pub func main = () {
    var p = Point(42, 7)
    var result = getX(p)
    Console.write("\\{result}\\n")
}
`;
	const output = await compile_and_run("param", source);
	expect(output).toBe("42\n");
});

test("class with destroy", async () => {
	const source = `
import System

class Resource {
    var int value

    destroy = {
        self.value = 999
    }
}

func getValue = (Resource r) {
    return r.value
}

pub func main = () {
    var r = Resource(42)
    var v = getValue(r)
    Console.write("\\{v}\\n")
}
`;
	const output = await compile_and_run("destroy", source);
	expect(output).toBe("42\n");
});

test("class field assignment", async () => {
	const source = `
import System

class Point {
    var int x
    var int y
}

pub func main = () {
    var p = Point(1, 2)
    p.x = 10
    p.y = 20
    Console.write("\\{p.x},\\{p.y}\\n")
}
`;
	const output = await compile_and_run("field_assign", source);
	expect(output).toBe("10,20\n");
});
