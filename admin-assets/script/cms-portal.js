/* cms-portal.js
 * MVP (read-only):
 * - Runs on /admin.html
 * - Loads a target page via your Cloudflare Worker:
 *     GET {WORKER_BASE}/api/repo/file?path=about/working-style.html
 * - Extracts:
 *     <!-- CMS:START hero --> ... <!-- CMS:END hero -->
 *     <!-- CMS:START main --> ... <!-- CMS:END main -->
 * - Renders:
 *     Left: block list (detected types + small summary)
 *     Right: preview (hero + main rendered in an iframe via srcdoc)
 *
 * Next iterations:
 * - Add/Edit/Delete/Reorder blocks
 * - Dirty tracking + Commit modal + POST /api/pr
 */

(() => {
	console.log("[cms-portal] loaded");
	// -------------------------
	// CONFIG (edit these)
	// -------------------------
	const API_BASE = "/api";
	const MANAGED_PAGES = [
		{ label: "Working Style", path: "about/working-style.html" },
	];

	// -------------------------
	// Utilities
	// -------------------------
	const qs = (sel, root = document) => root.querySelector(sel);
	const el = (tag, attrs = {}, children = []) => {
		const n = document.createElement(tag);
		Object.entries(attrs || {}).forEach(([k, v]) => {
			if (k === "class") n.className = v;
			else if (k === "html") n.innerHTML = v;
			else if (k.startsWith("on") && typeof v === "function")
				n.addEventListener(k.slice(2), v);
			else n.setAttribute(k, String(v));
		});
		(children || []).forEach((c) =>
			n.appendChild(typeof c === "string" ? document.createTextNode(c) : c),
		);
		return n;
	};

	function extractRegion(html, name) {
		// name: "hero" or "main"
		const start = `<!-- CMS:START ${name} -->`;
		const end = `<!-- CMS:END ${name} -->`;
		const i = html.indexOf(start);
		const j = html.indexOf(end);
		if (i === -1 || j === -1 || j <= i) return { found: false, inner: "" };
		return {
			found: true,
			inner: html.slice(i + start.length, j).trim(),
			startIndex: i,
			endIndex: j + end.length,
		};
	}

	function parseBlocks(mainHtml) {
		// We treat each top-level element in main as a "block".
		// Later we’ll support “managed blocks” inside wrappers too.
		const doc = new DOMParser().parseFromString(
			`<div id="__wrap__">${mainHtml}</div>`,
			"text/html",
		);
		const wrap = doc.querySelector("#__wrap__");
		const nodes = Array.from(wrap.children);

		return nodes.map((node, idx) => {
			const info = detectBlock(node);
			return {
				idx,
				type: info.type,
				summary: info.summary,
				html: node.outerHTML,
			};
		});
	}

	function detectBlock(node) {
		// Recognisers for your “Day-1” blocks, plus a fallback.
		// (You can expand this as you add more templates.)
		const cls = node.classList;

		// inline-polaroid stub
		if (cls.contains("img-stub") && node.getAttribute("data-img")) {
			const cap = node.getAttribute("data-caption") || "";
			return {
				type: "inline-polaroid",
				summary: cap || node.getAttribute("data-img"),
			};
		}

		// section stubs that sections.js expands
		if (cls.contains("section")) {
			const t = (node.getAttribute("data-type") || "").trim();
			if (t === "twoCol")
				return { type: "two-col", summary: headingText(node) || "Two column" };
			if (t === "split50") {
				const pos = node.getAttribute("data-img-pos") || "left";
				return {
					type: "50-50-split",
					summary: `${headingText(node) || "Split"} (img ${pos})`,
				};
			}
			if (t === "imgText") {
				const pos = node.getAttribute("data-img-pos") || "left";
				return {
					type: "small-img-lrg-txt",
					summary: `${headingText(node) || "ImgText"} (img ${pos})`,
				};
			}
			return {
				type: `section:${t || "unknown"}`,
				summary: headingText(node) || "Section",
			};
		}

		// std-container (your wrapper)
		if (cls.contains("div-wrapper")) {
			const h = node.querySelector("h1,h2,h3");
			return {
				type: "std-container",
				summary: h?.textContent?.trim() || "Container",
			};
		}

		// std-image
		if (cls.contains("img-text-div-img")) {
			const img = node.querySelector("img");
			return {
				type: "std-image",
				summary: img?.getAttribute("src") || "Image",
			};
		}

		// hover cards / grid wrapper
		if (cls.contains("grid-wrapper")) {
			return {
				type: "grid-wrapper",
				summary: `Grid (${node.querySelectorAll("img").length} imgs)`,
			};
		}

		return {
			type: node.tagName.toLowerCase(),
			summary: (node.textContent || "").trim().slice(0, 60) || "Block",
		};
	}

	function headingText(node) {
		const h = node.querySelector("h1,h2,h3");
		return h?.textContent?.trim() || "";
	}

	// -------------------------
	// UI Shell
	// -------------------------
	function mountShell(root) {
		// Controls: page selector + Load button (keep IDs)
		const pageSelect = el(
			"select",
			{ id: "cms-page", class: "cms-select" },
			MANAGED_PAGES.map((p) => el("option", { value: p.path }, [p.label])),
		);

		const loadBtn = el("button", { class: "cms-btn", id: "cms-load" }, [
			"Load",
		]);

		// Status bits (keep IDs used elsewhere)
		const statusPill = el(
			"span",
			{ id: "cms-status", class: "cms-pill warn" },
			["LOADING"],
		);

		const sub = el("div", { id: "cms-sub" }, ["LOADING / INITIALISING"]);

		// Commit button placeholder (we'll wire later, but keep it for layout)
		const commitBtn = el(
			"button",
			{ class: "cms-btn", id: "cms-commit", disabled: "true" },
			["Commit PR"],
		);

		// Mount into the dedicated strip container (NOT into #cms-portal)
		const stripHost = qs("#cms-status-strip") || root; // fallback
		stripHost.innerHTML = "";
		stripHost.appendChild(
			el("div", { class: "cms-strip" }, [
				el("div", { class: "cms-strip-left" }, ["Development Portal"]),
				el("div", { class: "cms-strip-mid" }, [statusPill, sub]),
				el("div", { class: "cms-strip-right cms-controls" }, [
					pageSelect,
					loadBtn,
					commitBtn,
				]),
			]),
		);

		// Ensure the CMS surface starts empty; renderPageSurface() will fill it
		root.innerHTML = "";
	}

	// -------------------------
	// App state
	// -------------------------
	const state = {
		path: MANAGED_PAGES[0].path,
		originalHtml: "",
		heroInner: "",
		mainInner: "",
		blocks: [],
		uiState: "loading",
		uiStateLabel: "LOADING / INITIALISING",
	};

	function renderBanner() {
		const host = qs("#cms-banner");
		if (!host) return;

		const map = {
			loading: "/assets/img/dev-portal-load.png",
			clean: "/assets/img/dev-portal-clean.png",
			dirty: "/assets/img/dev-portal-dirty.png",
			error: "/assets/img/dev-portal-error.png",
			pr: "/assets/img/dev-portal-pr.png",
			readonly: "/assets/img/dev-portal-read.png",
		};

		const src = map[state.uiState] || map.loading;
		host.innerHTML = "";
		host.appendChild(el("img", { src, alt: "Dev portal status banner" }));
	}

	function renderPageSurface() {
		const root = qs("#cms-portal");
		root.innerHTML = "";

		// Hero (text only)
		const hero = new DOMParser().parseFromString(
			state.heroInner || "",
			"text/html",
		).body;
		Array.from(hero.children).forEach((n) => root.appendChild(n));

		// Main
		const mainWrap = el("div", { id: "cms-main" }, []);
		if (!state.mainInner.trim()) {
			mainWrap.appendChild(
				el("div", { class: "cms-empty" }, [
					el("div", { class: "cms-empty-title" }, ["No blocks yet"]),
					el(
						"button",
						{ class: "cms-divider-btn", id: "cms-add-first", type: "button" },
						[
							el(
								"span",
								{ class: "cms-divider-line", "aria-hidden": "true" },
								[],
							),
							el("span", { class: "cms-divider-plus", "aria-hidden": "true" }, [
								"＋",
							]),
							el("span", { class: "cms-divider-text" }, [
								"Add your first block",
							]),
							el(
								"span",
								{ class: "cms-divider-line", "aria-hidden": "true" },
								[],
							),
						],
					),
				]),
			);
		} else {
			const main = new DOMParser().parseFromString(
				`<div>${state.mainInner}</div>`,
				"text/html",
			).body;
			Array.from(main.firstChild.children).forEach((n) =>
				mainWrap.appendChild(n),
			);
		}
		root.appendChild(mainWrap);
	}

	async function loadSelectedPage() {
		const path = qs("#cms-page")?.value || state.path;
		state.path = path;

		// 1) Loading state first
		state.uiState = "loading";
		state.uiStateLabel = "LOADING / INITIALISING";
		updateStatusStrip();
		renderBanner();
		renderPageSurface(); // will show blank/empty state while loading (fine)

		// 2) Fetch served HTML via Pages Function
		const url = `/api/content?path=/${encodeURIComponent(path)}`;
		const res = await fetch(url, { headers: { Accept: "text/html" } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		state.originalHtml = await res.text();

		// 3) Extract regions
		const hero = extractRegion(state.originalHtml, "hero");
		const main = extractRegion(state.originalHtml, "main");

		state.heroInner = hero.found ? hero.inner : "";
		state.mainInner = main.found ? main.inner : "";

		// 4) Compute marker health
		const missing = [];
		if (!hero.found) missing.push("hero markers");
		if (!main.found) missing.push("main markers");

		// 5) Final state
		if (missing.length) {
			state.uiState = "error";
			state.uiStateLabel = `Missing ${missing.join(" + ")}`;
		} else {
			state.uiState = "clean";
			state.uiStateLabel = "CONNECTED - CLEAN";
		}

		updateStatusStrip();
		renderBanner();
		renderPageSurface();
	}

	function updateStatusStrip() {
		const sub = qs("#cms-sub");
		if (sub) sub.textContent = state.uiStateLabel || "—";

		const pill = qs("#cms-status");
		if (pill) {
			pill.classList.remove("ok", "warn", "err");
			if (state.uiState === "clean") pill.classList.add("ok");
			else if (state.uiState === "loading") pill.classList.add("warn");
			else pill.classList.add("err");
			pill.textContent = state.uiState.toUpperCase();
		}
	}

	function bindUI() {
		qs("#cms-load").addEventListener("click", async () => {
			try {
				await loadSelectedPage();
			} catch (err) {
				state.uiState = "error";
				state.uiStateLabel = `DISCONNECTED / ERROR`;
				updateStatusStrip();
				renderBanner();
				// optional: show details somewhere
				console.error(err);
			}
		});
	}

	// -------------------------
	// Boot
	// -------------------------
	function boot() {
		const root = qs("#cms-portal");
		if (!root) return;

		mountShell(root);
		updateStatusStrip();
		renderBanner();
		renderPageSurface();
		bindUI();

		// auto-load working style
		qs("#cms-load").click();
	}

	console.log("[cms-portal] boot", {
		hasPortal: !!document.querySelector("#cms-portal"),
		hasStrip: !!document.querySelector("#cms-status-strip"),
		hasBanner: !!document.querySelector("#cms-banner"),
	});

	if (document.readyState === "loading")
		document.addEventListener("DOMContentLoaded", boot);
	else boot();
})();
