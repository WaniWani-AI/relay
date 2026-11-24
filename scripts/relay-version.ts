import { readFileSync } from "node:fs";

const { version } = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
Reflect.set(globalThis, "__RELAY_PACKAGE_VERSION__", version);
