/* cms-portal.js
 * MVP:
 * - Runs on /admin.html
 * - Loads rendered HTML via Pages Function: GET /api/repo/file?path=about/working-style.html
 * - Extracts CMS regions using markers:
 *     <!-- CMS:START hero --> ... <!-- CMS:END hero -->
 *     <!-- CMS:START main --> ... <!-- CMS:END main -->
 * - Represents main as an array of blocks (outerHTML per top-level element)
 * - Allows a first “divider” block to be inserted (marks DIRTY)
 *
 * This version adds the “next milestone” mechanism:
 * - replaceRegion() to rebuild a full HTML page from blocks
 * - rebuildPreviewHtml() to prove marker replacement is safe before PR writing
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
	// Tiny utilities
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

	async function loadPartialHtml(partialPath) {
		const res = await fetch(partialPath, { headers: { Accept: "text/html" } });
		if (!res.ok) throw new Error(`Failed to load partial ${partialPath}`);
		const text = await res.text();
		return text.replace(/^\s*<!--[\s\S]*?-->\s*/, "").trim();
	}

	async function buildTestContainerHtml() {
		const raw = await loadPartialHtml(
			"/admin-assets/partials/CloudFlareCMS/std-container.html",
		);

		const doc = new DOMParser().parseFromString(raw, "text/html");
		const h1 = doc.querySelector("h1");
		const p = doc.querySelector("p");
		if (h1) h1.textContent = "CMS Insert Test";
		if (p) p.textContent = "Inserted via the Dev Portal";
		return doc.body.innerHTML.trim();
	}

	// -------------------------
	// Marker helpers
	// -------------------------

	function extractRegion(html, name) {
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

	// Replace ONLY the content between the two marker comments.
	// Keeps the markers themselves intact.
	function replaceRegion(html, name, newInnerHtml) {
		const start = `<!-- CMS:START ${name} -->`;
		const end = `<!-- CMS:END ${name} -->`;

		const i = html.indexOf(start);
		const j = html.indexOf(end);

		if (i === -1 || j === -1 || j <= i) {
			// If markers missing, we refuse to guess (safety)
			throw new Error(`replaceRegion: missing markers for '${name}'`);
		}

		const before = html.slice(0, i + start.length);
		const after = html.slice(j);

		// Keep it readable + stable
		const cleaned = (newInnerHtml || "").trim();

		// Ensure we always have a newline between marker + content + marker
		return `${before}\n${cleaned}\n${after}`;
	}

	function serializeMainFromBlocks(blocks) {
		return (blocks || [])
			.map((b) => (b.html || "").trim())
			.filter(Boolean)
			.join("\n\n");
	}

	// -------------------------
	// Block parsing (top-level children only)
	// -------------------------
	function parseBlocks(mainHtml) {
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

	function headingText(node) {
		const h = node.querySelector("h1,h2,h3");
		return h?.textContent?.trim() || "";
	}

	function detectBlock(node) {
		const cls = node.classList;

		if (cls.contains("img-stub") && node.getAttribute("data-img")) {
			const cap = node.getAttribute("data-caption") || "";
			return {
				type: "inline-polaroid",
				summary: cap || node.getAttribute("data-img"),
			};
		}

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

		if (node.querySelector(".doc-card")) {
			const a = node.querySelector(".doc-card__link");
			return { type: "doc-card", summary: a?.getAttribute("href") || "Doc" };
		}

		if (cls.contains("tab") && node.querySelector("input[type=checkbox]")) {
			const label = node.querySelector(".tab-label");
			return {
				type: "accordion-item",
				summary: label?.textContent?.trim() || "Accordion item",
			};
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

		if (cls.contains("img-text-div-img")) {
			const img = node.querySelector("img");
			return {
				type: "std-image",
				summary: img?.getAttribute("src") || "Image",
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

	// -------------------------
	// State
	// -------------------------
	const state = {
		path: MANAGED_PAGES[0].path,
		originalHtml: "",
		rebuiltHtml: "",
		prUrl: "",
		prNumber: null,

		heroInner: "",
		mainInner: "",
		loadedHeroInner: "",
		loadedMainInner: "",

		blocks: [],

		uiState: "loading",
		uiStateLabel: "LOADING / INITIALISING",
	};

	// -------------------------
	// Render helpers
	// -------------------------
	function setUiState(kind, label) {
		state.uiState = kind;
		state.uiStateLabel = label;
		updateStatusStrip();
		renderBanner();
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

		// Enable/disable buttons based on state
		const discard = qs("#cms-discard");
		if (discard) discard.disabled = state.uiState !== "dirty";

		const commit = qs("#cms-commit");
		if (commit) commit.disabled = state.uiState !== "dirty";

		const prLink = qs("#cms-pr-link");
		if (prLink) {
			if (state.prUrl) {
				prLink.href = state.prUrl;
				prLink.textContent = `PR #${state.prNumber || "?"}`;
				prLink.hidden = false;
			} else {
				prLink.hidden = true;
			}
		}
	}

	function renderBanner() {
		const host = qs("#cms-banner");
		if (!host) return;

		const map = {
			loading: "/admin-assets/img/dev-portal-load.png",
			clean: "/admin-assets/img/dev-portal-clean.png",
			dirty: "/admin-assets/img/dev-portal-dirty.png",
			error: "/admin-assets/img/dev-portal-error.png",
			pr: "/admin-assets/img/dev-portal-pr.png",
			readonly: "/admin-assets/img/dev-portal-read.png",
		};

		host.innerHTML = "";
		host.appendChild(
			el("img", {
				src: map[state.uiState] || map.loading,
				alt: "Dev portal status banner",
			}),
		);
	}

	// Builds state.rebuiltHtml from originalHtml + current blocks.
	// Then re-extracts hero/main from rebuiltHtml (so we render from the same pipeline a PR will use).
	function rebuildPreviewHtml() {
		if (!state.originalHtml) return;

		const rebuiltMain = serializeMainFromBlocks(state.blocks);

		// If you add hero editing later, this becomes hero editor output.
		// For now we just keep hero as-is.
		const rebuiltHero = (state.heroInner || "").trim();

		let html = state.originalHtml;
		html = replaceRegion(html, "hero", rebuiltHero);
		html = replaceRegion(html, "main", rebuiltMain);

		state.rebuiltHtml = html;

		// Re-extract from the rebuilt html for rendering (proof the replacement is correct)
		const hero2 = extractRegion(state.rebuiltHtml, "hero");
		const main2 = extractRegion(state.rebuiltHtml, "main");
		state.heroInner = hero2.found ? hero2.inner : state.heroInner;
		state.mainInner = main2.found ? main2.inner : state.mainInner;
	}

	function renderPageSurface() {
		const root = qs("#cms-portal");
		root.innerHTML = "";

		// Hero
		const heroDoc = new DOMParser().parseFromString(
			state.heroInner || "",
			"text/html",
		).body;
		Array.from(heroDoc.children).forEach((n) => root.appendChild(n));

		// Main
		const mainWrap = el("div", { id: "cms-main" }, []);

		if (state.uiState === "loading") {
			mainWrap.appendChild(
				el("div", { class: "cms-empty" }, [
					el("div", { class: "cms-empty-title" }, ["Loading page…"]),
				]),
			);
			root.appendChild(mainWrap);
			return;
		}

		if (!state.blocks.length) {
			mainWrap.appendChild(
				el("div", { class: "cms-empty" }, [
					el("div", { class: "cms-empty-title" }, ["No blocks yet"]),
					el(
						"button",
						{ class: "cms-divider-btn", id: "cms-add-first", type: "button" },
						[
							el("span", { class: "cms-divider-line", "aria-hidden": "true" }),
							el("span", { class: "cms-divider-plus", "aria-hidden": "true" }, [
								"＋",
							]),
							el("span", { class: "cms-divider-text" }, [
								"Add your first block",
							]),
							el("span", { class: "cms-divider-line", "aria-hidden": "true" }),
						],
					),
				]),
			);

			// This is safe because the button is created fresh each render.
			// (The old DOM is deleted, so old handlers go with it.)
			queueMicrotask(() => {
				qs("#cms-add-first")?.addEventListener("click", () => {
					(async () => {
						try {
							const html = await buildTestContainerHtml();
							state.blocks = [
								{
									idx: 0,
									type: "std-container",
									summary: "Standard container",
									html,
								},
							];

							// prove rebuild works (preview pipeline)
							rebuildPreviewHtml();

							setUiState("dirty", "CONNECTED - DIRTY");
							renderPageSurface();
						} catch (err) {
							console.error(err);
							setUiState("error", "DISCONNECTED / ERROR");
							renderPageSurface();
						}
					})();
				});
			});

			root.appendChild(mainWrap);
			return;
		}

		// Render from state.blocks (raw HTML),
		// then run sections/lightbox for parity (same as your live site).
		state.blocks.forEach((b) => {
			const frag = new DOMParser().parseFromString(b.html, "text/html").body;
			Array.from(frag.children).forEach((n) => mainWrap.appendChild(n));
		});

		root.appendChild(mainWrap);

		// Parity behaviours
		window.runSections?.();
		window.initLightbox?.();
	}

	// -------------------------
	// UI Shell
	// -------------------------
	function mountShell() {
		const pageSelect = el(
			"select",
			{ id: "cms-page", class: "cms-select" },
			MANAGED_PAGES.map((p) => el("option", { value: p.path }, [p.label])),
		);

		const loadBtn = el("button", { class: "cms-btn", id: "cms-load" }, [
			"Load",
		]);

		const statusPill = el(
			"span",
			{ id: "cms-status", class: "cms-pill warn" },
			["LOADING"],
		);
		const sub = el("div", { id: "cms-sub" }, ["LOADING / INITIALISING"]);

		const commitBtn = el(
			"button",
			{ class: "cms-btn", id: "cms-commit", disabled: "true" },
			["Commit PR"],
		);

		const discardBtn = el(
			"button",
			{ class: "cms-btn", id: "cms-discard", disabled: "true" },
			["Discard"],
		);

		const prLink = el(
			"a",
			{
				id: "cms-pr-link",
				class: "cms-pr-link",
				href: "#",
				target: "_blank",
				rel: "noopener noreferrer",
				hidden: "true",
			},
			["PR"],
		);

		const stripHost = qs("#cms-status-strip");
		if (!stripHost) throw new Error("Missing #cms-status-strip in admin.html");
		stripHost.innerHTML = "";
		stripHost.appendChild(
			el("div", { class: "cms-strip" }, [
				el("div", { class: "cms-strip-left" }, ["Development Portal"]),
				el("div", { class: "cms-strip-mid" }, [statusPill, sub, prLink]),
				el("div", { class: "cms-strip-right cms-controls" }, [
					pageSelect,
					loadBtn,
					commitBtn,
					discardBtn,
				]),
			]),
		);
	}

	// -------------------------
	// Data load
	// -------------------------
	async function loadSelectedPage() {
		const path = qs("#cms-page")?.value || state.path;
		state.path = path;

		setUiState("loading", "LOADING / INITIALISING");
		renderPageSurface();

		const url = `/api/repo/file?path=${encodeURIComponent(path)}`;
		const res = await fetch(url, { headers: { Accept: "application/json" } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);

		const data = await res.json();
		state.originalHtml = data.text || "";

		const hero = extractRegion(state.originalHtml, "hero");
		const main = extractRegion(state.originalHtml, "main");

		state.loadedHeroInner = hero.found ? hero.inner : "";
		state.loadedMainInner = main.found ? main.inner : "";

		state.heroInner = state.loadedHeroInner;
		state.mainInner = state.loadedMainInner;
		state.blocks = parseBlocks(state.mainInner);

		// Debug signal: whitespace normalisation can make this false even when correct.
		const rebuiltMain = serializeMainFromBlocks(state.blocks);
		const originalMain = (state.mainInner || "").trim();
		console.log(
			"[cms-portal] roundtrip main equal?",
			rebuiltMain === originalMain,
		);

		const missing = [];
		if (!hero.found) missing.push("hero markers");
		if (!main.found) missing.push("main markers");

		if (missing.length) {
			setUiState("error", `Missing ${missing.join(" + ")}`);
		} else {
			setUiState("clean", "CONNECTED - CLEAN");
		}

		renderPageSurface();
	}

	function bindUI() {
		qs("#cms-load")?.addEventListener("click", async () => {
			try {
				await loadSelectedPage();
			} catch (err) {
				console.error(err);
				setUiState("error", "DISCONNECTED / ERROR");
				renderPageSurface();
			}
		});

		qs("#cms-commit")?.addEventListener("click", async () => {
			if (state.uiState !== "dirty") return;
			try {
				setUiState("loading", "CREATING PR…");
				state.prUrl = "";
				state.prNumber = null;

				rebuildPreviewHtml();
				if (!state.rebuiltHtml)
					throw new Error("No rebuilt HTML available to commit");

				const payload = {
					path: state.path,
					text: state.rebuiltHtml,
					title: `CMS: update ${state.path}`,
					body: `Created by Portfolio CMS\n\n@VoodooScience1 please review + merge.`,
					commitMessage: `CMS: update ${state.path}`,
				};

				const res = await fetch("/api/pr", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
				});

				const data = await res.json().catch(() => ({}));
				if (!res.ok) {
					throw new Error(data?.error || `PR failed (HTTP ${res.status})`);
				}

				state.prUrl = data?.pr?.url || "";
				state.prNumber = data?.pr?.number || null;

				setUiState("pr", "PR OPEN (AWAITING MERGE)");
				renderPageSurface();
			} catch (err) {
				console.error(err);
				setUiState("error", "DISCONNECTED / ERROR");
				renderPageSurface();
			}
		});

		qs("#cms-discard")?.addEventListener("click", () => {
			state.heroInner = state.loadedHeroInner;
			state.mainInner = state.loadedMainInner;
			state.blocks = parseBlocks(state.loadedMainInner);

			rebuildPreviewHtml(); // keeps pipeline consistent (optional but nice)

			setUiState("clean", "CONNECTED - CLEAN");
			renderPageSurface();
		});
	}

	// -------------------------
	// Boot
	// -------------------------
	function boot() {
		if (!qs("#cms-portal")) return;

		mountShell();
		bindUI();

		// initial render
		setUiState("loading", "LOADING / INITIALISING");
		renderBanner();
		renderPageSurface();

		// auto-load
		qs("#cms-load")?.click();
	}

	if (document.readyState === "loading")
		document.addEventListener("DOMContentLoaded", boot);
	else boot();
})();
