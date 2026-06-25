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
		ignorePatterns: ["bench/**.json"],
	},
	test: {
		exclude: ["**/node_modules/**", "**/dist/**", "./temp/**", "./tests/**"],
	},
});
