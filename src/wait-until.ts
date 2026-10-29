type WaitUntil = (promise: Promise<unknown>) => void;
type RequestContextStore = {
	get?: () => { waitUntil?: WaitUntil } | undefined;
};

const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

/** The `waitUntil` that the Vercel runtime puts in the request context, the same one `@vercel/functions` reads. */
export function vercelWaitUntil(): WaitUntil | undefined {
	const store: RequestContextStore | undefined = Reflect.get(
		globalThis,
		REQUEST_CONTEXT,
	);
	const context = store?.get?.();
	return context?.waitUntil
		? (promise) => context.waitUntil?.(promise)
		: undefined;
}
