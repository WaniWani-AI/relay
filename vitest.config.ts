import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

export default defineConfig({
	define: { __RELAY_PACKAGE_VERSION__: JSON.stringify(version) },
	test: { include: ["test/**/*.test.ts"], testTimeout: 20_000 },
});
