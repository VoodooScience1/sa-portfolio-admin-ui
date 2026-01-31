// sa-portfolio-admin-ui/functions/assets/[[path]].js
// IMPORTANT:
// This function intentionally proxies /assets/* from voodooscience1.github.io
// Do NOT:
//  - move admin assets here
//  - add admin-assets to this allowlist
//  - add nosniff headers
// See ADR-010.
export async function onRequest({ request, env, params }) {
	const origin = String(env.PORTFOLIO_ORIGIN || "")
		.trim()
		.replace(/\/+$/, "");
	if (!origin) return new Response("Missing PORTFOLIO_ORIGIN", { status: 500 });

	const path = Array.isArray(params.path)
		? params.path.join("/")
		: params.path || "";

	const allowed = [
		"css/",
		"font/",
		"img/",
		"partials/",
		"script/",
		"docs/",
		"icon-packs/",
	];
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
	headers.set("Cache-Control", "no-store"); // dev-friendly

	// IMPORTANT: do NOT force nosniff here, it turns upstream HTML (404) into “script/css blocked”
	// headers.set("X-Content-Type-Options", "nosniff");

	return new Response(res.body, { status: res.status, headers });
}
