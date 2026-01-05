// sa-portfolio-admin-ui/functions/api/[[path]].js
export async function onRequest(context) {
	const { request, env, params } = context;

	const ORIGIN = String(env.CMS_WORKER_ORIGIN || "")
		.trim()
		.replace(/\/+$/, "");
	if (!ORIGIN) {
		return new Response(
			JSON.stringify({ error: "Missing CMS_WORKER_ORIGIN" }, null, 2),
			{
				status: 500,
				headers: { "content-type": "application/json; charset=utf-8" },
			},
		);
	}

	const CMS_API_KEY = String(env.CMS_API_KEY || "").trim();
	const CMS_READ_KEY = String(env.CMS_READ_KEY || "").trim();

	const incoming = new URL(request.url);
	const path = Array.isArray(params.path)
		? params.path.join("/")
		: params.path || "";
	const upstream = new URL(`${ORIGIN}/api/${path}`);
	upstream.search = incoming.search;

	const headers = new Headers(request.headers);
	headers.delete("host");
	headers.set("accept", "application/json");

	// Tell the CMS Worker which repo branch to read/write against
	// (dev Pages project sets GITHUB_DEFAULT_BRANCH=dev, prod sets =main)
	const branch = String(env.GITHUB_DEFAULT_BRANCH || "").trim();
	if (branch) headers.set("x-cms-branch", branch);

	const isReadEndpoint = upstream.pathname.startsWith("/api/repo/");
	if (isReadEndpoint) {
		if (!CMS_READ_KEY) {
			return new Response(
				JSON.stringify({ error: "Missing CMS_READ_KEY (Pages env)" }, null, 2),
				{
					status: 500,
					headers: { "content-type": "application/json; charset=utf-8" },
				},
			);
		}
		headers.set("x-cms-read-key", CMS_READ_KEY);
	} else if (CMS_READ_KEY) {
		headers.set("x-cms-read-key", CMS_READ_KEY);
	}

	// Only attach the key server-side for PR writes
	if (upstream.pathname === "/api/pr") {
		if (!CMS_API_KEY) {
			return new Response(
				JSON.stringify({ error: "Missing CMS_API_KEY (Pages env)" }, null, 2),
				{
					status: 500,
					headers: { "content-type": "application/json; charset=utf-8" },
				},
			);
		}
		headers.set("x-cms-key", CMS_API_KEY);
	}

	return fetch(upstream.toString(), {
		method: request.method,
		headers,
		body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
		redirect: "manual",
	});
}
