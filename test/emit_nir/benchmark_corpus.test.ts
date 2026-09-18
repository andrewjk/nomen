// Split out of test/emit_nir.test.ts, then one test PER benchmark file:
// the tests are registered dynamically from bench/nomen so a new benchmark is
// covered automatically (no registry to update), while each file gets its own
// test — per-test timeout headroom, a failure name that says which benchmark
// broke, and no early-abort hiding later failures. Shared byte-identity
// harness: ./_helpers.ts.

import fs from "node:fs";

import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import { set_access_staging_enabled } from "../../src/build_aarch64/access_staging";
import { set_cset_lowering_enabled } from "../../src/build_aarch64/cset_lower";
import { set_nir_emission_enabled } from "../../src/build_aarch64/emit_nir";
import { set_flag_form_enabled } from "../../src/build_aarch64/flag_form";
import { set_forwarding_enabled } from "../../src/build_aarch64/forward";
import { set_neon_vectorization_enabled } from "../../src/build_aarch64/neon_emit";
import { set_slp_pair_enabled } from "../../src/build_aarch64/slp_pair";
import { set_loop_unrolling_enabled } from "../../src/build_aarch64/unroll";
import { set_region_pool_enabled } from "../../src/build_aarch64/utils/nir_regalloc";
import { set_nir_site_promotion_enabled } from "../../src/build_aarch64/utils/nir_regalloc";
import { set_value_numbering_enabled } from "../../src/build_aarch64/value_number";
import join from "../../src/join";
import { get_library } from "../../src/lib";
import parse from "../../src/parse";

const BENCH_DIR = "bench/nomen";
const lib = get_library("core");

/**
 * Compile one benchmark twice — per-statement delegation off/on — and require
 * byte-identical aarch64 assembly. The NEON vectorizer and the full unroller
 * intentionally change output, so both are held off in both arms (see the
 * harness comment in _helpers.ts). Decl-site register binding (tranche G
 * stage 3) is cursor-dependent the same way, as is the cset fuse (ASM_PLAN_3
 * tranche B) — it consumes a declare AND its following if through the cursor
 * — the stage-4 forwarding pass (its use-site AST swap rides the cursor),
 * access staging, loop value numbering, field-pair SLP, and region-scoped
 * pool claims.
 */
function expect_bench_byte_identical(file: string): void {
	const source = join(`${BENCH_DIR}/${file}`, "core");
	const compile = (): string => {
		const parsed = parse(source, lib, undefined, { allow_internal: true });
		expect(parsed.errors, file).toEqual([]);
		return build(parsed.root, { arch: "aarch64" }).code;
	};
	set_nir_emission_enabled(false);
	set_neon_vectorization_enabled(false);
	set_loop_unrolling_enabled(false);
	set_nir_site_promotion_enabled(false);
	set_cset_lowering_enabled(false);
	set_forwarding_enabled(false);
	set_flag_form_enabled(false);
	set_access_staging_enabled(false);
	set_value_numbering_enabled(false);
	set_slp_pair_enabled(false);
	set_region_pool_enabled(false);
	const baseline = compile();
	set_nir_emission_enabled(true);
	set_neon_vectorization_enabled(false);
	set_loop_unrolling_enabled(false);
	set_nir_site_promotion_enabled(false);
	set_cset_lowering_enabled(false);
	set_forwarding_enabled(false);
	set_flag_form_enabled(false);
	set_region_pool_enabled(false);
	set_access_staging_enabled(false);
	set_value_numbering_enabled(false);
	set_slp_pair_enabled(false);
	try {
		expect(compile(), file).toEqual(baseline);
	} finally {
		set_nir_emission_enabled(true);
		set_neon_vectorization_enabled(true);
		set_loop_unrolling_enabled(true);
		set_nir_site_promotion_enabled(true);
		set_cset_lowering_enabled(true);
		set_forwarding_enabled(true);
		set_flag_form_enabled(true);
		set_access_staging_enabled(true);
		set_value_numbering_enabled(true);
		set_slp_pair_enabled(true);
		set_region_pool_enabled(true);
	}
}

for (const file of fs.readdirSync(BENCH_DIR)) {
	if (!file.endsWith(".nm")) continue;
	// One test per benchmark: a single compile is seconds, but give it
	// generous headroom under parallel CI load (the whole corpus used to run
	// as one test against the 30s default).
	test(`${file} is byte-identical through NIR emission`, () => {
		expect_bench_byte_identical(file);
	}, 60_000);
}
