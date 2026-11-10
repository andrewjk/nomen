// Declares `.torp` files (plus asset imports) as ES modules for TypeScript,
// so that `import Component from "./App.torp"` gets the right type.
/// <reference types="vite/client" />

declare module "*.torp" {
	import { Component as ComponentType } from "@torpor/view";
	const Component: ComponentType;
	export default Component;
}

declare module "*.svg" {
	const content: string;
	export default content;
}
