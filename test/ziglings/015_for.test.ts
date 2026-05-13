import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 015 for -- errors", () => {
	const input = `
import System

pub func main = () {
    const char story = [ 'h', 'h', 's', 'n', 'h' ]

    Console.write("A Dramatic Story: ")

    for ??? {
        if scene == 'h' { Console.write(":-)  ") }
        if scene == 's' { Console.write(":-(  ") }
        if scene == 'n' { Console.write(":-|  ") }
    }

    Console.write("The End.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 015 for -- fixed", () => {
	const input = `
import System

pub func main = () {
    const char story = [ 'h', 'h', 's', 'n', 'h' ]

    Console.write("A Dramatic Story: ")

    for scene of story {
        if scene == 'h' { Console.write(":-)  ") }
        if scene == 's' { Console.write(":-(  ") }
        if scene == 'n' { Console.write(":-|  ") }
    }

    Console.write("The End.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 015 for -- build", async () => {
	const input = `
import System

pub func main = () {
    const char story = [ 'h', 'h', 's', 'n', 'h' ]

    Console.write("A Dramatic Story: ")

    for scene of story {
        if scene == 'h' { Console.write(":-)  ") }
        if scene == 's' { Console.write(":-(  ") }
        if scene == 'n' { Console.write(":-|  ") }
    }

    Console.write("The End.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });

	const expected_output = "A Dramatic Story: :-)  :-)  :-(  :-|  :-)  The End.";
	await check_output_aarch64("015", built, expected_output);
});
