import { expect, test } from "vite-plus/test";

import RawNode from "../../src/nodes/RawNode.ts";
import parse from "../../src/parse";
import trim_test_parse from "../trim_test_parse";

//const test = suite("Raw parse");

test("raw", () => {
	const input = `
\`\`\`
printf("do some stuff");
\`\`\`
`;
	const parsed = parse(input);
	const expected = new RawNode(1, 'printf("do some stuff");');
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});
