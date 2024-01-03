import { suite } from "uvu";
import assert from "uvu/assert";
import build from "../../src/build";
import parse from "../../src/parse";

const test = suite("Pub build");

// NOTE: the pub keyword has no effect on the build

test.run();
