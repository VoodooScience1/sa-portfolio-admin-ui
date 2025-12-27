/* cms-portal.js
 * MVP (read-only-ish):
 * - Runs on /admin.html
 * - Loads a target page:
 *     GET /api/content?path=about/working-style.html
 * - Extracts regions:
 *     <!-- CMS:START hero --> ... <!-- CMS:END hero -->
 *     <!-- CMS:START main --> ... <!-- CMS:END main -->
 * - Parses main into top-level "blocks"
 * - Renders hero + blocks
 *
 * Current extra:
 * - "Add your first block" makes page DIRTY
 * - Discard restores last-loaded blocks
 *
 * NOTE:
 * - "Commit PR" still placeholder here (disabled until you wire backend write)
 */

(() => {
	console.log("[cms-portal] loaded");

	// -------------------------
	// CONFIG
	// -------------------------
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
		const start = `<!-- CMS:START ${name} -->`;
		const end = `<!-- CMS:END ${name} -->`;
		const i = html.indexOf(start);
		const j = html.indexOf(end);
		if (i === -1 || j === -1 || j <= i) return { found: false, inner: "" };
		return { found: true, inner: html.slice(i + start.length, j).trim() };
	}

	function headingText(node) {
		const h = node.querySelector("h1,h2,h3");
		return h?.textContent?.trim() || "";
	}

	function detectBlock(node) {
		const cls = node.classList;

		if (cls.contains("section")) {
			const t = (node.getAttribute("data-type") || "").trim();
			const pos = node.getAttribute("data-img-pos") || "left";
			if (t === "twoCol")
				return { type: "two-col", summary: headingText(node) || "Two column" };
			if (t === "split50")
				return {
					type: "50-50-split",
					summary: `${headingText(node) || "Split"} (img ${pos})`,
				};
			if (t === "imgText")
				return {
					type: "small-img-lrg-txt",
					summary: `${headingText(node) || "ImgText"} (img ${pos})`,
				};
			return {
				type: `section:${t || "unknown"}`,
				summary: headingText(node) || "Section",
			};
		}

		if (node.querySelector?.(".doc-card")) {
			const a = node.querySelector(".doc-card__link");
			return { type: "doc-card", summary: a?.getAttribute("href") || "Doc" };
		}

		if (cls.contains("grid-wrapper") && cls.contains("grid-wrapper--row")) {
			if (node.querySelector(".content.box.box-img")) {
				return {
					type: "hover-card-row",
					summary: `Hover cards (${node.querySelectorAll(".content.box.box-img").length})`,
				};
			}
			if (node.querySelector(".box > img")) {
				return {
					type: "square-grid-row",
					summary: `Square grid (${node.querySelectorAll(".box > img").length})`,
				};
			}
			return { type: "grid-wrapper-row", summary: "Grid row" };
		}

		if (cls.contains("grid-wrapper")) {
			return {
				type: "grid-wrapper",
				summary: `Grid (${node.querySelectorAll("img").length} imgs)`,
			};
		}

		if (cls.contains("div-wrapper")) {
			const h = node.querySelector("h1,h2,h3");
			return {
				type: "std-container",
				summary: h?.textContent?.trim() || "Container",
			};
		}

		return {
			type: node.tagName.toLowerCase(),
			summary: (node.textContent || "").trim().slice(0, 60) || "Block",
		};
	}

	function parseBlocks(mainHtml) {
		const doc = new DOMParser().parseFromString(
			`<div id="__wrap__">${mainHtml}</div>`,
			"text/html",
		);
		const wrap = doc.querySelector("#__wrap__");
		const nodes = Array.from(wrap?.children || []);
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

	// If/when you need it (roundtrip checks / writes later)
	function serializeMainFromBlocks(blocks) {
		return (blocks || [])
			.map((b) => (b.html || "").trim())
			.filter(Boolean)
			.join("\n\n");
	}

	// -------------------------
	// State
	// -------------------------
	const state = {
		path: MANAGED_PAGES[0].path,
		originalHtml: "",
		heroInner: "",
		mainInner: "",

		blocks: [],
		lastLoadedBlocks: [], // used for Discard

		uiState: "loading", // loading | clean | dirty | error
		uiStateLabel: "LOADING / INITIALISING",
	};

	// -------------------------
	// UI Shell
	// -------------------------
	function mountShell() {
		const root = qs("#cms-portal");
		if (!root) return;

		// Controls strip MUST exist in admin.html for best reliability:
		// <div id="cms-status-strip"></div>
		// <div id="cms-banner"></div>
		// <div id="cms-portal"></div>
		const stripHost = qs("#cms-status-strip") || root;

		const pageSelect = el(
			"select",
			{ id: "cms-page", class: "cms-select" },
			MANAGED_PAGES.map((p) => el("option", { value: p.path }, [p.label])),
		);

		const loadBtn = el(
			"button",
			{ class: "cms-btn", id: "cms-load", type: "button" },
			["Load"],
		);
		const commitBtn = el(
			"button",
			{ class: "cms-btn", id: "cms-commit", type: "button", disabled: "true" },
			["Commit PR"],
		);
		const discardBtn = el(
			"button",
			{ class: "cms-btn", id: "cms-discard", type: "button", disabled: "true" },
			["Discard"],
		);

		const statusPill = el(
			"span",
			{ id: "cms-status", class: "cms-pill warn" },
			["LOADING"],
		);
		const sub = el("div", { id: "cms-sub" }, ["LOADING / INITIALISING"]);

		stripHost.innerHTML = "";
		stripHost.appendChild(
			el("div", { class: "cms-strip" }, [
				el("div", { class: "cms-strip-left" }, ["Development Portal"]),
				el("div", { class: "cms-strip-mid" }, [statusPill, sub]),
				el("div", { class: "cms-strip-right cms-controls" }, [
					pageSelect,
					loadBtn,
					commitBtn,
					discardBtn,
				]),
			]),
		);

		// Clear surface; renderPageSurface fills it
		root.innerHTML = "";
	}

	function renderBanner() {
		const host = qs("#cms-banner");
		if (!host) return;

		const map = {
			loading: "/admin-assets/img/dev-portal-load.png",
			clean: "/admin-assets/img/dev-portal-clean.png",
			dirty: "/admin-assets/img/dev-portal-dirty.png",
			error: "/admin-assets/img/dev-portal-error.png",
		};

		const src = map[state.uiState] || map.loading;
		host.innerHTML = "";
		host.appendChild(el("img", { src, alt: "Dev portal status banner" }));
	}

	function updateControls() {
		const commit = qs("#cms-commit");
		const discard = qs("#cms-discard");

		// Commit stays disabled until you wire backend write.
		if (commit) commit.disabled = true;

		// Discard enabled only when dirty
		if (discard) discard.disabled = state.uiState !== "dirty";
	}

	function updateStatusStrip() {
		const sub = qs("#cms-sub");
		if (sub) sub.textContent = state.uiStateLabel || "—";

		const pill = qs("#cms-status");
		if (pill) {
			pill.classList.remove("ok", "warn", "err");
			if (state.uiState === "clean") pill.classList.add("ok");
			else if (state.uiState === "loading") pill.classList.add("warn");
			else if (state.uiState === "dirty") pill.classList.add("warn");
			else pill.classList.add("err");
			pill.textContent = state.uiState.toUpperCase();
		}

		updateControls();
	}

	function renderPageSurface() {
		const root = qs("#cms-portal");
		if (!root) return;

		root.innerHTML = "";

		// Hero
		const hero = new DOMParser().parseFromString(
			state.heroInner || "",
			"text/html",
		).body;
		Array.from(hero.children).forEach((n) => root.appendChild(n));

		// Main
		const mainWrap = el("div", { id: "cms-main" }, []);

		if (state.uiState === "loading") {
			mainWrap.appendChild(
				el("div", { class: "cms-empty" }, [
					el("div", { class: "cms-empty-title" }, ["Loading page…"]),
				]),
			);
		} else if (!state.blocks.length) {
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
			state.blocks.forEach((b) => {
				const frag = new DOMParser().parseFromString(b.html, "text/html").body;
				Array.from(frag.children).forEach((n) => mainWrap.appendChild(n));
			});
		}

		root.appendChild(mainWrap);

		// Re-run the same behaviours your portfolio pages rely on
		window.initLightbox?.();
		window.runSections?.();
		window.initLightbox?.();
	}

	// -------------------------
	// Actions
	// -------------------------
	async function loadSelectedPage() {
		const path = qs("#cms-page")?.value || state.path;
		state.path = path;

		state.uiState = "loading";
		state.uiStateLabel = "LOADING / INITIALISING";
		updateStatusStrip();
		renderBanner();
		renderPageSurface();

		const url = `/api/content?path=${encodeURIComponent(path)}`;
		const res = await fetch(url, { headers: { Accept: "text/html" } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);

		state.originalHtml = await res.text();

		const hero = extractRegion(state.originalHtml, "hero");
		const main = extractRegion(state.originalHtml, "main");

		const missing = [];
		if (!hero.found) missing.push("hero markers");
		if (!main.found) missing.push("main markers");

		if (missing.length) {
			state.uiState = "error";
			state.uiStateLabel = `Missing ${missing.join(" + ")}`;
			state.heroInner = "";
			state.mainInner = "";
			state.blocks = [];
			state.lastLoadedBlocks = [];
		} else {
			state.heroInner = hero.inner;
			state.mainInner = main.inner;

			state.blocks = parseBlocks(state.mainInner);
			state.lastLoadedBlocks = JSON.parse(JSON.stringify(state.blocks)); // snapshot for Discard

			state.uiState = "clean";
			state.uiStateLabel = "CONNECTED - CLEAN";
		}

		updateStatusStrip();
		renderBanner();
		renderPageSurface();

		// Optional debug: check "roundtrip"
		// console.log("[cms-portal] roundtrip main equal?", serializeMainFromBlocks(state.blocks) === (state.mainInner || "").trim());
	}

	function markDirty(reason = "") {
		state.uiState = "dirty";
		state.uiStateLabel = reason
			? `CONNECTED - DIRTY (${reason})`
			: "CONNECTED - DIRTY";
		updateStatusStrip();
		renderBanner();
	}

	function discardChanges() {
		state.blocks = JSON.parse(JSON.stringify(state.lastLoadedBlocks || []));
		state.uiState = "clean";
		state.uiStateLabel = "CONNECTED - CLEAN";
		updateStatusStrip();
		renderBanner();
		renderPageSurface();
	}

	// -------------------------
	// Bind UI (event delegation so re-renders don't matter)
	// -------------------------
	function bindUI() {
		document.addEventListener("click", async (e) => {
			const t = e.target;

			if (t?.id === "cms-load") {
				try {
					await loadSelectedPage();
				} catch (err) {
					console.error(err);
					state.uiState = "error";
					state.uiStateLabel = "DISCONNECTED / ERROR";
					updateStatusStrip();
					renderBanner();
					renderPageSurface();
				}
			}

			if (t?.id === "cms-add-first") {
				state.blocks = [
					{
						idx: 0,
						type: "std-container",
						summary: "Divider",
						html: `<div class="div-wrapper">\n\t<div class="default-div-wrapper">\n\t\t<hr class="divider" />\n\t</div>\n</div>`,
					},
				];
				markDirty("local edits exist, nothing committed yet");
				renderPageSurface();
			}

			if (t?.id === "cms-discard") {
				if (state.uiState === "dirty") discardChanges();
			}
		});
	}

	// -------------------------
	// Boot
	// -------------------------
	function boot() {
		const root = qs("#cms-portal");
		if (!root) return;

		mountShell();
		bindUI();

		// Start in loading state (prevents the ERROR flash)
		state.uiState = "loading";
		state.uiStateLabel = "LOADING / INITIALISING";
		updateStatusStrip();
		renderBanner();
		renderPageSurface();

		// Auto-load first page
		qs("#cms-load")?.click();
	}

	if (document.readyState === "loading")
		document.addEventListener("DOMContentLoaded", boot);
	else boot();
})();
