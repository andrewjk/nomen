import { describe } from "vite-plus/test";

import { doc_fence_suite } from "../docs_fences.ts";

// The README's fenced `nomen` examples ARE the test inputs: every block that
// is not an error example must compile against the repo compiler. Error
// examples stay hand-written in the feature suites.
describe("readme: fenced examples", () => {
	doc_fence_suite("README.md", "nomen");
});
