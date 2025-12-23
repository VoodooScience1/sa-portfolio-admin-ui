// sa-portfolio-admin-ui/functions/api/content.js
export async function onRequestGet(context) {
	const { request } = context;
	const url = new URL(request.url);

	// Only allow relative paths, e.g. /about/working-style.html
	const path = url.searchParams.get("path") || "/";
	if (!path.startsWith("/") || path.includes("..")) {
		return new Response("Bad path", { status: 400 });
	}

	const upstream = `https://portfolio.tacsa.co.uk${path}`;

	const res = await fetch(upstream, {
		headers: {
			// Optional: encourage upstream to return the raw HTML
			Accept: "text/html,*/*",
		},
	});

	if (!res.ok) {
		return new Response(`Upstream error ${res.status}`, { status: 502 });
	}

	const body = await res.text();

	return new Response(body, {
		status: 200,
		headers: {
			"Content-Type":
				res.headers.get("Content-Type") || "text/html; charset=utf-8",
			// Same-origin call, so CORS isn't needed, but harmless if present:
			"Access-Control-Allow-Origin": url.origin,
			"Cache-Control": "no-store",
		},
	});
}
