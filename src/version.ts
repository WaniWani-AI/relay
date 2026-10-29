declare const __RELAY_PACKAGE_VERSION__: string | undefined;

export const RELAY_VERSION: string =
	typeof __RELAY_PACKAGE_VERSION__ === "string"
		? __RELAY_PACKAGE_VERSION__
		: "0.0.0-dev";
