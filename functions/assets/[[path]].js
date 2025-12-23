// sa-portfolio-admin-ui/functions/assets/[[path]].js
export async function onRequest({ request, env, params }) {
	const origin = String(env.PORTFOLIO_ORIGIN || "")
		.trim()
		.replace(/\/+$/, "");

	if (!origin) {
		return new Response("Missing PORTFOLIO_ORIGIN", { status: 500 });
	}

	const path = Array.isArray(params.path)
		? params.path.join("/")
		: params.path || "";

	const allowed = ["css/", "font/", "img/", "partials/", "script/"];
	if (!allowed.some((p) => path.startsWith(p))) {
		return new Response("Forbidden asset path", { status: 403 });
	}

	const upstream = new URL(`${origin}/assets/${path}`);
	upstream.search = new URL(request.url).search;

	const res = await fetch(upstream.toString(), {
		headers: {
			"User-Agent": request.headers.get("user-agent") || "CF-Proxy",
			Accept: request.headers.get("accept") || "*/*",
		},
	});

	const headers = new Headers(res.headers);
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Cache-Control", "no-store");

	return new Response(res.body, {
		status: res.status,
		headers,
	});
}
