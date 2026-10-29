import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const define = { __RELAY_PACKAGE_VERSION__: JSON.stringify(version) };

export default defineConfig({
	entry: { index: "src/index.ts" },
	format: ["esm"],
	target: "node24",
	platform: "neutral",
	removeNodeProtocol: false,
	external: ["node:net"],
	dts: true,
	clean: false,
	sourcemap: true,
	minify: false,
	define,
	outDir: "dist",
});
