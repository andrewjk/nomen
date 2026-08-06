import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A name must be a portable folder name: letters, digits, underscore and
// hyphen only. Anything else (slashes, spaces, dots) would either break the
// filesystem layout or produce an invalid package name.
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

const GITIGNORE = `build/
`;

function package_jsonc(name: string): string {
	return `{
	"name": "${name}",
	"entry": "src/main.nm"
	// The System library is resolved automatically from your nomen-lang
	// install. To pin a local checkout instead, uncomment:
	// "imports": { "System": "../core" }
}
`;
}

const MAIN_NM = `import System

pub func main = (Init init) {
	Console.write("Hello world!\\n")
}
`;

const TEST_NM = `import System
import System/Test

func add = (int a, int b, out int) => a + b

pub func test_smoke = (ref Tester t) {
	t.expect(add(2, 2) == 4, "2 + 2 should equal 4")
}
`;

function readme(name: string): string {
	return `# ${name}

A [Nomen](https://github.com/andrewjk/nomen) project.

## Build

\`\`\`bash
nomen build
\`\`\`

## Run

\`\`\`bash
nomen run
\`\`\`

## Test

\`\`\`bash
nomen test
\`\`\`
`;
}

// Resolve a bundled asset (core/ or NOMEN_AGENTS.md) shipped alongside the
// CLI. In the published package these sit next to dist/; in the dev tree they
// live one level up (the repo root), so check both.
export function find_bundled(filename: string): string | undefined {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const cli_root = path.dirname(here);
	const candidates = [path.join(cli_root, filename), path.join(cli_root, "..", filename)];
	for (const c of candidates) {
		if (fs.existsSync(c)) return path.resolve(c);
	}
	return undefined;
}

/**
 * `nomen init <name>`: scaffold a new project under `./<name>` with a sensible
 * starting layout (package.jsonc, src/main.nm, a starter test, README and an
 * AGENTS.md copied from the bundled NOMEN_AGENTS.md template).
 */
export function run_init(name: string | undefined): void {
	if (!name) {
		console.log("Usage: nomen init <name>");
		process.exit(1);
	}
	if (!NAME_RE.test(name)) {
		console.log(
			`Invalid project name "${name}". Use letters, digits, '-' or '_' (must start with a letter).`,
		);
		process.exit(1);
	}

	const target = path.resolve(process.cwd(), name);
	if (fs.existsSync(target)) {
		console.log(`Already exists: ${target}`);
		process.exit(1);
	}

	const agents_template = find_bundled("NOMEN_AGENTS.md");
	if (!agents_template) {
		console.log("Could not locate NOMEN_AGENTS.md template alongside the CLI.");
		process.exit(1);
	}

	const src = path.join(target, "src");
	const test = path.join(target, "test");
	fs.mkdirSync(src, { recursive: true });
	fs.mkdirSync(test, { recursive: true });

	fs.writeFileSync(path.join(target, ".gitignore"), GITIGNORE);
	fs.writeFileSync(path.join(target, "package.jsonc"), package_jsonc(name));
	fs.writeFileSync(path.join(src, "main.nm"), MAIN_NM);
	fs.writeFileSync(path.join(test, "main.test.nm"), TEST_NM);
	fs.writeFileSync(path.join(target, "README.md"), readme(name));
	fs.writeFileSync(path.join(target, "AGENTS.md"), fs.readFileSync(agents_template));

	console.log(`Created ${name}/`);
	console.log(`  ${name}/.gitignore`);
	console.log(`  ${name}/package.jsonc`);
	console.log(`  ${name}/src/main.nm`);
	console.log(`  ${name}/test/main.test.nm`);
	console.log(`  ${name}/README.md`);
	console.log(`  ${name}/AGENTS.md`);
	console.log(`\nNext: cd ${name} && nomen run`);
}
