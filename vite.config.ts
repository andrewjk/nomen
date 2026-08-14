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
	},
	fmt: {
		printWidth: 100,
		sortImports: true,
		useTabs: true,
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
