import { expect } from "vite-plus/test";

import build from "../../src/build";
import { set_access_staging_enabled } from "../../src/build_aarch64/access_staging";
import { set_cset_lowering_enabled } from "../../src/build_aarch64/cset_lower";
import { set_nir_emission_enabled } from "../../src/build_aarch64/emit_nir";
import { set_flag_form_enabled } from "../../src/build_aarch64/flag_form";
import { set_forwarding_enabled } from "../../src/build_aarch64/forward";
import { set_neon_vectorization_enabled } from "../../src/build_aarch64/neon_emit";
import { set_slp_pair_enabled } from "../../src/build_aarch64/slp_pair";
import { set_region_pool_enabled } from "../../src/build_aarch64/utils/nir_regalloc";
import { set_nir_site_promotion_enabled } from "../../src/build_aarch64/utils/nir_regalloc";
import { set_value_numbering_enabled } from "../../src/build_aarch64/value_number";
import parse_with_imports, { parse_raw } from "../parse_with_imports";

/**
 * Phase 4 canonical-IR stage 2 (ASM_PLAN): NIR-driven emission must be a
 * byte-identical re-encoding of the AST walk. Every test that uses
 * `expect_byte_identical` compiles the same source twice — per-statement
 * delegation off/on (the emission toggle makes emit_stmt_from_nir delegate
 * every statement to build_node, the exact statement-level walk the retired
 * whole-function fallback performed) — and requires the generated aarch64
 * assembly to match exactly.
 *
 * The NEON vectorizer rides the same NIR cursor but INTENTIONALLY changes
 * output, so it is held off in both arms: these tests prove the seam
 * mechanics, not the vectorizer (see test/neon_vector.test.ts).
 */

export function compile_aarch64(source: string, raw = false, raw_statements = false): string {
	const parsed = raw
		? parse_raw(source)
		: raw_statements
			? parse_with_imports(source, { allow_user_raw: true })
			: parse_with_imports(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	return result.code;
}

export function expect_byte_identical(source: string, raw = false, raw_statements = false): void {
	set_nir_emission_enabled(false);
	set_neon_vectorization_enabled(false);
	// Decl-site register binding (tranche G stage 3) is cursor-dependent by
	// design: the site hook fires only when emit_stmt_from_nir owns the
	// statement, so the delegated baseline arm could never reproduce it.
	// Hold it off in both arms — the same treatment the NEON vectorizer
	// gets — so the harness keeps proving the SEAM mechanics. The cset
	// fuse (ASM_PLAN_3 tranche B) is cursor-dependent the same way, and so
	// is the stage-4 forwarding pass (its one-statement AST swap rides the
	// cursor's use-site plan).
	set_nir_site_promotion_enabled(false);
	set_cset_lowering_enabled(false);
	set_forwarding_enabled(false);
	// The carry-fold fuse (ASM_PLAN_3 tranche J) consumes up to four
	// statements through the cursor — same treatment as the cset fuse.
	set_flag_form_enabled(false);
	// Access staging (ASM_PLAN_3 tranche L) is window-state-dependent: a
	// pin filled by an earlier statement can never reproduce in a
	// delegated single-statement rebuild — same treatment as the fuses.
	set_access_staging_enabled(false);
	// Loop value numbering (ASM_PLAN_3 tranche M) rewrites the NIR spine
	// AND the statement lists the delegated walk builds from — the two arms
	// could never agree — same treatment as the fuses.
	set_value_numbering_enabled(false);
	// Field-pair SLP (ASM_PLAN_4) consumes adjacent statement pairs and
	// plans lane pairs in the allocators — cursor-dependent, same
	// treatment as the fuses.
	set_slp_pair_enabled(false);
	// Region-scoped pool claims (ASM_PLAN_5) bracket loops at the while
	// dispatch (spills/derivations/pre-seeded pins) — cursor-dependent,
	// same treatment as the fuses.
	set_region_pool_enabled(false);
	const baseline = compile_aarch64(source, raw, raw_statements);
	set_nir_emission_enabled(true);
	try {
		const with_nir = compile_aarch64(source, raw, raw_statements);
		expect(with_nir.length).toBeGreaterThan(0);
		expect(with_nir).toEqual(baseline);
	} finally {
		set_nir_emission_enabled(true);
		set_neon_vectorization_enabled(true);
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
