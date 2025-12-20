export async function onRequest({ request, env, params }) {
	const origin = env.PORTFOLIO_ORIGIN;
	if (!origin) {
		return new Response("Missing PORTFOLIO_ORIGIN", { status: 500 });
	}

	// Rebuild requested path
	const path = params.path || "";
	const url = new URL(origin.replace(/\/$/, "") + "/" + path);

	// Allowlist: only proxy real site assets
	const allowedPrefixes = ["css/", "font/", "img/", "partials/", "script/"];

	if (!allowedPrefixes.some((p) => path.startsWith(p))) {
		return new Response("Forbidden asset path", { status: 403 });
	}

	// Forward request
	const upstream = await fetch(url.toString(), {
		method: request.method,
		headers: {
			// pass through user agent etc
			"User-Agent": request.headers.get("user-agent") || "CF-Proxy",
		},
	});

	// Clone headers so we can safely modify
	const headers = new Headers(upstream.headers);

	// Ensure browser accepts CSS/JS/fonts
	headers.set("X-Content-Type-Options", "nosniff");

	// Cache aggressively (assets are immutable unless you change them)
	headers.set("Cache-Control", "public, max-age=31536000, immutable");

	return new Response(upstream.body, {
		status: upstream.status,
		headers,
	});
}
