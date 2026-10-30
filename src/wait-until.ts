type WaitUntil = (promise: Promise<unknown>) => void;
type RequestContextStore = {
	get?: () => { waitUntil?: WaitUntil } | undefined;
};

const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

export function vercelRequestContext(): { waitUntil?: WaitUntil } | undefined {
	const store: RequestContextStore | undefined = Reflect.get(
		globalThis,
		REQUEST_CONTEXT,
	);
	return store?.get?.();
}

/** The `waitUntil` that the Vercel runtime puts in the request context, the same one `@vercel/functions` reads. */
export function vercelWaitUntil(): WaitUntil | undefined {
	const context = vercelRequestContext();
	return context?.waitUntil
		? (promise) => context.waitUntil?.(promise)
		: undefined;
}
