import { describe } from "vite-plus/test";

import { doc_fence_suite } from "../docs_fences.ts";

// The SPEC's fenced examples ARE the test inputs: every block that is not an
// error example must compile against the repo compiler. Error examples stay
// hand-written in the feature suites, where their diagnostics are asserted.
describe("spec: fenced examples", () => {
	doc_fence_suite("SPEC.md", "");
});
