/**
 * Proxy an incoming Pages Function request to your CMS Worker.
 *
 * Why:
 * - Keeps UI on Pages (fast, simple)
 * - Keeps GitHub App private key + token minting ONLY on the Worker
 * - Pages Functions become a thin, readable routing layer
 *
 * Requires (Pages env var):
 * - CMS_WORKER_ORIGIN e.g. "https://sa-portfolio-cms.<your-subdomain>.workers.dev"
 */
export async function proxyToCmsWorker(request, env) {
	const origin = (env.CMS_WORKER_ORIGIN || "").trim();
	if (!origin) {
		return json({ error: "Missing env var CMS_WORKER_ORIGIN" }, 500);
	}

	// Build the upstream URL: same path + querystring, different origin
	const inUrl = new URL(request.url);
	const upstreamUrl = new URL(origin);
	upstreamUrl.pathname = inUrl.pathname;
	upstreamUrl.search = inUrl.search;

	// Clone headers carefully.
	// Some headers should not be forwarded (Host especially).
	const headers = new Headers(request.headers);
	headers.delete("host");

	// Optional: make it explicit that we want JSON back
	headers.set("accept", "application/json");

	// Proxy body for non-GET/HEAD
	const method = request.method.toUpperCase();
	const hasBody = !(method === "GET" || method === "HEAD");

	const upstreamRes = await fetch(upstreamUrl.toString(), {
		method,
		headers,
		body: hasBody ? request.body : undefined,
		redirect: "manual",
	});

	// Pass through status + body as-is (keep debugging simple)
	return new Response(upstreamRes.body, {
		status: upstreamRes.status,
		headers: upstreamRes.headers,
	});
}

function json(obj, status = 200) {
	return new Response(JSON.stringify(obj, null, 2), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}
