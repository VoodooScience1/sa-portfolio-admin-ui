// sa-portfolio-admin-ui/assets/[[path]].js
export async function onRequest({ request, env, params }) {
	const origin = (env.PORTFOLIO_ORIGIN || "").trim().replace(/\/+$/, "");
	if (!origin) return new Response("Missing PORTFOLIO_ORIGIN", { status: 500 });

	const path = Array.isArray(params.path)
		? params.path.join("/")
		: params.path || "";

	const allowedPrefixes = ["css/", "font/", "img/", "partials/", "script/"];
	if (!allowedPrefixes.some((p) => path.startsWith(p))) {
		return new Response("Forbidden asset path", { status: 403 });
	}

	const srcUrl = new URL(request.url);
	const upstreamUrl = new URL(`${origin}/assets/${path}`); // <-- note /assets/
	upstreamUrl.search = srcUrl.search;

	const upstream = await fetch(upstreamUrl.toString(), {
		method: "GET",
		headers: {
			"User-Agent": request.headers.get("user-agent") || "CF-Proxy",
			Accept: request.headers.get("accept") || "*/*",
		},
	});

	const headers = new Headers(upstream.headers);
	headers.set("X-Content-Type-Options", "nosniff");

	// while iterating, don't let a bad response get cached for ages
	headers.set("Cache-Control", "no-store");

	return new Response(upstream.body, { status: upstream.status, headers });
}
