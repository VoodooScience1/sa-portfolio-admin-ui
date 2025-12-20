/**
 * Pages Function: /api/*
 * Proxies requests to the CMS Worker (workers.dev) server-side.
 *
 * Why:
 * - avoids Cloudflare Worker "Route" + Zone requirement (no DNS transfer needed)
 * - keeps secrets off the browser (CMS_API_KEY never shipped to client)
 * - makes UI calls same-origin: fetch("/api/repo/tree")
 */

export async function onRequest(context) {
	const { request, env, params } = context;

	// REQUIRED (set in Cloudflare Pages project settings -> Variables)
	// Example: https://sa-portfolio-cms.<your-subdomain>.workers.dev
	const WORKER_ORIGIN = (env.CMS_WORKER_ORIGIN || "").replace(/\/+$/, "");
	if (!WORKER_ORIGIN) {
		return new Response(
			JSON.stringify(
				{ error: "Missing CMS_WORKER_ORIGIN Pages env var" },
				null,
				2,
			),
			{ status: 500, headers: { "content-type": "application/json" } },
		);
	}

	// OPTIONAL (only needed if your Worker still requires x-cms-key for POST /api/pr)
	const CMS_API_KEY = (env.CMS_API_KEY || "").trim();

	// Build upstream URL:
	// Incoming: /api/repo/tree?x=y
	// Forward:  <WORKER_ORIGIN>/api/repo/tree?x=y
	const url = new URL(request.url);
	const path = Array.isArray(params.path)
		? params.path.join("/")
		: params.path || "";
	const upstream = new URL(`${WORKER_ORIGIN}/api/${path}`);
	upstream.search = url.search;

	// Copy headers (but don't forward Host)
	const headers = new Headers(request.headers);
	headers.delete("host");

	// Add the key ONLY server-side (never from client JS)
	// Only attach it on PR endpoint to reduce blast radius.
	if (upstream.pathname === "/api/pr" && CMS_API_KEY) {
		headers.set("x-cms-key", CMS_API_KEY);
	}

	const init = {
		method: request.method,
		headers,
		// Only forward body for non-GET/HEAD
		body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
		redirect: "manual",
	};

	return fetch(upstream.toString(), init);
}
