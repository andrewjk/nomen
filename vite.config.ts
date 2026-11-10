import { defineConfig } from "vite-plus";

export default defineConfig({
	staged: {
		"*": "vp check --fix",
	},
	lint: {
		options: {
			typeAware: true,
			typeCheck: true,
		},
		// Generated backend artifacts (the JS backend's `main.mjs` output
		// lives here too) are test data, not source. The site embeds the
		// System library as a generated data module.
		ignorePatterns: ["test/out/**", "site/src/lib/core-library.generated.ts"],
	},
	fmt: {
		printWidth: 100,
		sortImports: true,
		useTabs: true,
		ignorePatterns: ["test/out/**", "site/src/lib/core-library.generated.ts"],
		overrides: [
			{
				files: ["*.json", "*.jsonc"],
				options: {
					trailingComma: "none",
				},
			},
		],
	},
	test: {
		exclude: ["**/node_modules/**", "**/dist/**", "./temp/**", "./tests/**", "./test/out/**"],
		// Build the single precompiled system.o once before all tests; every
		// C-backend test links it instead of recompiling System per test.
		globalSetup: ["./test/system_lib_setup.ts"],
	},
});
