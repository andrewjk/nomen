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
    ignorePatterns: [],
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
    exclude: ["**/node_modules/**", "**/dist/**", "./temp/**", "./tests/**"],
  },
});
