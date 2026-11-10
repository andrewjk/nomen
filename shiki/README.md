# nomen-shiki

Shiki highlighting for Nomen, using the VS Code extension's TextMate grammar
(`extension/syntaxes/nomen.tmLanguage.json`) as the single source of truth.

```ts
import { codeToHtml } from "nomen-shiki";

const html = await codeToHtml('Console.write_line("hi")', {
	lang: "nomen",
	theme: "dark-plus",
});
```

It uses Shiki's JavaScript regex engine (no Oniguruma WASM), so it runs in a
browser or a Cloudflare Worker, and lazily loads the grammar, the two bundled
themes (`dark-plus` / `light-plus`), and the C grammar the Nomen grammar embeds
for ` ``` ` raw blocks.
