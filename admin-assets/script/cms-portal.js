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
	const DEFAULT_PAGE = "index.html";
	const DIRTY_STORAGE_KEY = "cms-dirty-pages";

	function getPagePathFromLocation() {
		const raw = String(location.pathname || "").replace(/^\/+/, "");
		if (!raw || raw === "index.html") return DEFAULT_PAGE;
		return raw;
	}

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

	function buildSummaryForHtml(html) {
		const main = extractRegion(html, "main");
		if (!main.found) return [];
		return parseBlocks(main.inner).map((b) => b.summary || b.type || "Block");
	}

	function buildDiffSummary(baseHtml, dirtyHtml) {
		const baseMain = extractRegion(baseHtml, "main");
		const dirtyMain = extractRegion(dirtyHtml, "main");
		if (!dirtyMain.found) return [];

		const baseBlocks = baseMain.found ? parseBlocks(baseMain.inner) : [];
		const dirtyBlocks = parseBlocks(dirtyMain.inner);

		const baseHtmlList = baseBlocks.map((b) => (b.html || "").trim());
		const added = [];
		const modified = [];

		dirtyBlocks.forEach((block) => {
			const html = (block.html || "").trim();
			const idx = baseHtmlList.indexOf(html);
			if (idx >= 0) baseHtmlList.splice(idx, 1);
			else added.push(block.summary || block.type || "Block");
		});

		// Modified detection is pending; return an empty list for now.
		return { added, modified };
	}

	function ensureModalRoot() {
		let root = qs("#cms-modal");
		if (root) return root;
		root = el("div", { id: "cms-modal", class: "cms-modal" }, [
			el("div", { class: "cms-modal__backdrop", "data-close": "true" }),
			el("div", { class: "cms-modal__panel", role: "dialog", "aria-modal": "true" }, [
				el("div", { class: "cms-modal__header" }, [
					el("h2", { id: "cms-modal-title", class: "cms-modal__title" }, [
						"Modal",
					]),
					el(
						"button",
						{
							class: "cms-modal__close",
							type: "button",
							"data-close": "true",
							"aria-label": "Close",
						},
						["×"],
					),
				]),
				el("div", { class: "cms-modal__body", id: "cms-modal-body" }, []),
				el("div", { class: "cms-modal__footer", id: "cms-modal-footer" }, []),
			]),
		]);
		document.body.appendChild(root);
		return root;
	}

	function openModal({ title, bodyNodes, footerNodes }) {
		const root = ensureModalRoot();
		qs("#cms-modal-title").textContent = title || "Modal";
		const body = qs("#cms-modal-body");
		const footer = qs("#cms-modal-footer");
		body.innerHTML = "";
		footer.innerHTML = "";
		(bodyNodes || []).forEach((n) => body.appendChild(n));
		(footerNodes || []).forEach((n) => footer.appendChild(n));
		root.classList.add("is-open");
		document.documentElement.classList.add("cms-lock");
		document.body.classList.add("cms-lock");

		root.querySelectorAll("[data-close='true']").forEach((btn) => {
			btn.addEventListener(
				"click",
				() => {
					root.classList.remove("is-open");
					document.documentElement.classList.remove("cms-lock");
					document.body.classList.remove("cms-lock");
				},
				{ once: true },
			);
		});
	}

	function openLoadingModal(title = "Loading…") {
		openModal({
			title,
			bodyNodes: [
				el("div", { class: "cms-modal__loading" }, ["Fetching changes…"]),
			],
			footerNodes: [],
		});
	}

	function loadDirtyPagesFromStorage() {
		try {
			const raw = localStorage.getItem(DIRTY_STORAGE_KEY);
			const parsed = raw ? JSON.parse(raw) : {};
			return parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			return {};
		}
	}

	function saveDirtyPagesToStorage() {
		try {
			localStorage.setItem(DIRTY_STORAGE_KEY, JSON.stringify(state.dirtyPages));
		} catch {
			// Storage failures should not block editing.
		}
	}

	function hashText(input) {
		let hash = 5381;
		const text = String(input || "");
		for (let i = 0; i < text.length; i += 1) {
			hash = (hash << 5) + hash + text.charCodeAt(i);
		}
		return String(hash >>> 0);
	}

	function dirtyCount() {
		return Object.keys(state.dirtyPages || {}).length;
	}

	function markCurrentDirty() {
		state.currentDirty = true;
	}

	function setDirtyPage(path, html, baseHtmlOverride = "") {
		if (!path) return;
		const baseHtml = baseHtmlOverride || state.originalHtml;
		state.dirtyPages[path] = {
			html,
			baseHash: hashText(baseHtml),
			dirtyHash: hashText(html),
			updatedAt: Date.now(),
		};
		saveDirtyPagesToStorage();
	}

	function clearDirtyPage(path) {
		if (!path) return;
		delete state.dirtyPages[path];
		saveDirtyPagesToStorage();
	}

	function getDirtyHtml(path) {
		return state.dirtyPages[path]?.html || "";
	}

	function buildDirtyLabel() {
		const count = dirtyCount();
		if (!count) return "CONNECTED - CLEAN";
		return `CONNECTED - DIRTY (${count} page${count === 1 ? "" : "s"})`;
	}

	function refreshUiStateForDirty() {
		if (["loading", "error", "pr", "readonly"].includes(state.uiState)) return;
		if (dirtyCount()) setUiState("dirty", buildDirtyLabel());
		else setUiState("clean", "CONNECTED - CLEAN");
	}

	async function buildBlockDataMap(paths) {
		const blockMap = {};
		await Promise.all(
			paths.map(async (path) => {
				const dirtyHtml = String(state.dirtyPages[path]?.html || "");
				try {
					const res = await fetch(
						`/api/repo/file?path=${encodeURIComponent(path)}`,
						{ headers: { Accept: "application/json" } },
					);
					if (!res.ok) throw new Error("repo fetch failed");
					const data = await res.json();
					const baseHtml = String(data.text || "");

					const baseMain = extractRegion(baseHtml, "main");
					const dirtyMain = extractRegion(dirtyHtml, "main");
					const baseBlocks = baseMain.found ? parseBlocks(baseMain.inner) : [];
					const dirtyBlocks = dirtyMain.found
						? parseBlocks(dirtyMain.inner)
						: [];

					const baseHtmlList = baseBlocks.map((b) => (b.html || "").trim());
					const all = [];
					const added = [];

					dirtyBlocks.forEach((block, idx) => {
						const html = (block.html || "").trim();
						const summary = block.summary || block.type || "Block";
						const match = baseHtmlList.indexOf(html);
						const isBase = match >= 0;
						if (match >= 0) baseHtmlList.splice(match, 1);
						const item = {
							id: `${path}::${idx}`,
							html,
							summary,
							selectable: !isBase,
						};
						all.push(item);
						if (!isBase) added.push(item);
					});

					blockMap[path] = {
						baseHtml,
						dirtyHtml,
						all,
						added,
						modified: [],
					};
				} catch {
					const main = extractRegion(dirtyHtml, "main");
					const dirtyBlocks = main.found ? parseBlocks(main.inner) : [];
					blockMap[path] = {
						baseHtml: "",
						dirtyHtml,
						all: dirtyBlocks.map((block, idx) => ({
							id: `${path}::${idx}`,
							html: (block.html || "").trim(),
							summary: block.summary || block.type || "Block",
							selectable: true,
						})),
						added: dirtyBlocks.map((block, idx) => ({
							id: `${path}::${idx}`,
							html: (block.html || "").trim(),
							summary: block.summary || block.type || "Block",
							selectable: true,
						})),
						modified: [],
					};
				}
			}),
		);
		return blockMap;
	}

	function purgeCleanDirtyPages() {
		Object.keys(state.dirtyPages || {}).forEach((path) => {
			const entry = state.dirtyPages[path];
			if (!entry) return;
			if (entry.baseHash && entry.dirtyHash && entry.baseHash === entry.dirtyHash)
				clearDirtyPage(path);
		});
	}

	async function purgeDirtyPagesFromRepo() {
		const paths = Object.keys(state.dirtyPages || {});
		if (!paths.length) return;
		await Promise.all(
			paths.map(async (path) => {
				try {
					const res = await fetch(
						`/api/repo/file?path=${encodeURIComponent(path)}`,
						{ headers: { Accept: "application/json" } },
					);
					if (!res.ok) return;
					const data = await res.json();
					const remoteText = String(data.text || "").trim();
					const entryText = String(state.dirtyPages[path]?.html || "").trim();
					if (remoteText && entryText && remoteText === entryText)
						clearDirtyPage(path);
				} catch {
					// Remote compare failure should not block modal flow.
				}
			}),
		);
	}

	function getBlocksForModes(entry, modes) {
		if (!entry) return [];
		if (modes.has("all")) return entry.all || [];
		let blocks = [];
		if (modes.has("new")) blocks = blocks.concat(entry.added || []);
		if (modes.has("modified")) blocks = blocks.concat(entry.modified || []);
		return blocks;
	}

	function countSelectedBlocks(selectedBlocks) {
		let total = 0;
		selectedBlocks.forEach((set) => {
			total += set.size;
		});
		return total;
	}

	function buildHtmlForSelection(entry, selectedIds, action) {
		const all = entry?.all || [];
		const keepAdded = action === "commit";
		const kept = all.filter((block) => {
			if (!block.selectable) return true;
			const isSelected = selectedIds.has(block.id);
			return keepAdded ? isSelected : !isSelected;
		});
		const mainHtml = kept.map((b) => b.html).join("\n\n");
		let html = entry.baseHtml || entry.dirtyHtml || "";
		if (!html) return "";
		html = replaceRegion(html, "main", mainHtml);
		return html;
	}

	function applyHtmlToCurrentPage(updatedHtml) {
		if (!updatedHtml || !updatedHtml.trim()) return;
		const hero = extractRegion(updatedHtml, "hero");
		const main = extractRegion(updatedHtml, "main");
		if (hero.found) state.heroInner = hero.inner;
		if (main.found) state.mainInner = main.inner;
		state.blocks = parseBlocks(state.mainInner);
		state.currentDirty = updatedHtml.trim() !== state.originalHtml.trim();
	}

	function renderDirtyPageList({
		selectedPages,
		selectedBlocks,
		blockData,
		modes,
		onSelectionChange,
	}) {
		const wrap = el("div", { class: "cms-modal__list" }, []);
		const paths = Object.keys(state.dirtyPages || {}).sort();
		paths.forEach((path, idx) => {
			const id = `cms-page-${idx}`;
			const checkbox = el("input", { type: "checkbox", id });
			checkbox.checked = selectedPages.has(path);
			const label = el("label", { for: id, class: "cms-modal__label" }, [path]);
			const row = el("div", { class: "cms-modal__row" }, [checkbox, label]);

			const entry = blockData[path];
			const blocks = getBlocksForModes(entry, modes);
			const blockSet = selectedBlocks.get(path) || new Set();

			const group = el("div", { class: "cms-modal__group" }, [row]);
			if (selectedPages.has(path)) {
				const list = el(
					"ul",
					{ class: "cms-modal__sublist" },
					blocks.length
						? blocks.map((block) => {
								const item = el("li", {}, []);
								const bid = `cms-block-${hashText(block.id)}`;
								const box = el("input", {
									type: "checkbox",
									id: bid,
									disabled: block.selectable ? null : "true",
								});
								box.checked = block.selectable && blockSet.has(block.id);
								const text = el(
									"label",
									{ for: bid, class: "cms-modal__label" },
									[block.summary],
								);
								item.appendChild(box);
								item.appendChild(text);

								box.addEventListener("change", () => {
									const set = selectedBlocks.get(path) || new Set();
									if (box.checked) set.add(block.id);
									else set.delete(block.id);
									if (set.size) selectedBlocks.set(path, set);
									else {
										selectedBlocks.delete(path);
										selectedPages.delete(path);
									}
									onSelectionChange();
								});
								return item;
							})
						: [el("li", {}, ["No blocks detected"])],
				);
				group.appendChild(list);
			}

			wrap.appendChild(group);

			checkbox.addEventListener("change", () => {
				if (checkbox.checked) {
					selectedPages.add(path);
					if (!selectedBlocks.has(path)) {
						const selectable = blocks
							.filter((b) => b.selectable)
							.map((b) => b.id);
						selectedBlocks.set(path, new Set(selectable));
					}
				} else {
					selectedPages.delete(path);
					selectedBlocks.delete(path);
				}
				onSelectionChange();
			});
		});
		return wrap;
	}

	function buildModalToggleBar(onChange) {
		const wrap = el("div", { class: "cms-modal__toggle" }, []);
		const newBtn = el(
			"button",
			{ class: "cms-modal__toggle-btn is-active", type: "button" },
			["New blocks"],
		);
		const modifiedBtn = el(
			"button",
			{ class: "cms-modal__toggle-btn", type: "button" },
			["Modified blocks"],
		);
		const allBtn = el("button", { class: "cms-modal__toggle-btn", type: "button" }, [
			"All blocks",
		]);

		const modes = new Set(["new"]);
		const syncButtons = () => {
			newBtn.classList.toggle("is-active", modes.has("new"));
			modifiedBtn.classList.toggle("is-active", modes.has("modified"));
			allBtn.classList.toggle("is-active", modes.has("all"));
		};

		const setAll = () => {
			modes.clear();
			modes.add("all");
			syncButtons();
			onChange(new Set(modes));
		};

		const toggleMode = (mode) => {
			if (modes.has("all")) modes.delete("all");
			if (modes.has(mode)) modes.delete(mode);
			else modes.add(mode);
			if (!modes.size) modes.add("new");
			syncButtons();
			onChange(new Set(modes));
		};

		newBtn.addEventListener("click", () => toggleMode("new"));
		modifiedBtn.addEventListener("click", () => toggleMode("modified"));
		allBtn.addEventListener("click", () => setAll());

		wrap.appendChild(newBtn);
		wrap.appendChild(modifiedBtn);
		wrap.appendChild(allBtn);
		onChange(new Set(modes));
		return wrap;
	}

	function setActionState(button, enabled) {
		button.disabled = !enabled;
		button.classList.remove("cms-btn--danger", "cms-btn--success");
		if (!enabled) return;
		const variant = button.getAttribute("data-variant");
		if (variant === "success") button.classList.add("cms-btn--success");
		else button.classList.add("cms-btn--danger");
	}

	function discardSelectedPages(paths) {
		paths.forEach((p) => clearDirtyPage(p));
		if (paths.includes(state.path)) {
			state.heroInner = state.loadedHeroInner;
			state.mainInner = state.loadedMainInner;
			state.blocks = parseBlocks(state.loadedMainInner);
			state.currentDirty = false;
			rebuildPreviewHtml();
			renderPageSurface();
		}
		refreshUiStateForDirty();
	}

	async function submitPr(paths, note, payloads = null) {
		try {
			setUiState("loading", "CREATING PR…");
			state.prUrl = "";
			state.prNumber = null;

			const files =
				Array.isArray(payloads) && payloads.length
					? payloads
					: paths.map((path) => ({
							path,
							text: state.dirtyPages[path]?.html || "",
						}));

			const baseNote = String(note || "Created by Portfolio CMS").trim();
			const body = `${baseNote}\n\n@VoodooScience1 please review + merge.`;

			const payload =
				files.length === 1
					? {
							path: files[0].path,
							text: files[0].text,
							title: `CMS: update ${files[0].path}`,
							commitMessage: `CMS: update ${files[0].path}`,
							body,
						}
					: {
							files,
							title: `CMS: update ${files.length} pages`,
							commitMessage: `CMS: update ${files.length} pages`,
							body,
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
			if (!payloads) {
				paths.forEach((path) => clearDirtyPage(path));
				purgeCleanDirtyPages();
			}

			setUiState("pr", "PR OPEN (AWAITING MERGE)");
			renderPageSurface();
			startPrPolling();
		} catch (err) {
			console.error(err);
			setUiState("error", "DISCONNECTED / ERROR");
			renderPageSurface();
		}
	}

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

	function normalizeBlocks() {
		state.blocks = (state.blocks || []).map((b, idx) => ({
			...b,
			idx,
		}));
	}

	async function insertTestBlockAt(index) {
		const html = await buildTestContainerHtml();
		state.blocks.splice(index, 0, {
			idx: index,
			type: "std-container",
			summary: "Standard container",
			html,
		});

		normalizeBlocks();
		rebuildPreviewHtml();
		markCurrentDirty();
		setDirtyPage(state.path, state.rebuiltHtml);
		refreshUiStateForDirty();
		renderPageSurface();
	}

	function stashCurrentPageIfDirty() {
		if (!state.currentDirty) {
			clearDirtyPage(state.path);
			refreshUiStateForDirty();
			return;
		}
		rebuildPreviewHtml();
		if (!state.rebuiltHtml) return;
		setDirtyPage(state.path, state.rebuiltHtml);
		refreshUiStateForDirty();
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
	let prPollTimer = null;

	const state = {
		path: getPagePathFromLocation(),
		originalHtml: "",
		rebuiltHtml: "",
		prUrl: "",
		prNumber: null,
		dirtyPages: loadDirtyPagesFromStorage(),
		currentDirty: false,

		heroInner: "",
		mainInner: "",
		loadedHeroInner: "",
		loadedMainInner: "",

		blocks: [],

		uiState: "loading",
		uiStateLabel: "LOADING / INITIALISING",
	};

	function stopPrPolling() {
		if (prPollTimer) {
			clearInterval(prPollTimer);
			prPollTimer = null;
		}
	}

	function extractPrNumber(url) {
		const m = String(url || "").match(/\/pull\/(\d+)/);
		return m ? Number(m[1]) : null;
	}

	async function refreshPrStatus() {
		const number = state.prNumber || extractPrNumber(state.prUrl);
		if (!number) return;

		const res = await fetch(`/api/pr/status?number=${number}`, {
			headers: { Accept: "application/json" },
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok)
			throw new Error(data?.error || `Status failed (${res.status})`);

		if (data.state === "merged") {
			state.prUrl = "";
			state.prNumber = null;
			stopPrPolling();
			setUiState("clean", "PR MERGED");
			renderPageSurface();
			return;
		}

		if (data.state === "closed") {
			state.prUrl = "";
			state.prNumber = null;
			stopPrPolling();
			setUiState("clean", "PR CLOSED");
			renderPageSurface();
			return;
		}

		state.prUrl = data.url || state.prUrl;
		state.prNumber = data.number || state.prNumber;
		setUiState("pr", "PR OPEN (AWAITING MERGE)");
		renderPageSurface();
	}

	function startPrPolling() {
		stopPrPolling();
		refreshPrStatus().catch((err) => console.error(err));
		prPollTimer = setInterval(() => {
			refreshPrStatus().catch((err) => console.error(err));
		}, 20000);
	}

	// -------------------------
	// Render helpers
	// -------------------------
	function setUiState(kind, label) {
		state.uiState = kind;
		state.uiStateLabel = label;
		updateStatusStrip();
		if (typeof state._updateNavCommitState === "function")
			state._updateNavCommitState();
		renderBanner();
	}

	function updateStatusStrip() {
		const pill = qs("#cms-status");
		if (pill) {
			pill.classList.remove("ok", "warn", "err");
			if (state.uiState === "clean") pill.classList.add("ok");
			else if (state.uiState === "loading") pill.classList.add("warn");
			else if (state.uiState === "dirty") pill.classList.add("warn");
			else pill.classList.add("err");

			pill.textContent = state.uiStateLabel || state.uiState.toUpperCase();
		}

		// Enable/disable buttons based on state
		const discard = qs("#cms-discard");
		if (discard) discard.disabled = dirtyCount() === 0;

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
							await insertTestBlockAt(0);
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

		const insertDivider = (index, label = "Insert block") =>
			el(
				"button",
				{
					class: "cms-divider-btn",
					type: "button",
					"data-insert": String(index),
				},
				[
					el("span", { class: "cms-divider-line", "aria-hidden": "true" }),
					el("span", { class: "cms-divider-plus", "aria-hidden": "true" }, [
						"＋",
					]),
					el("span", { class: "cms-divider-text" }, [label]),
					el("span", { class: "cms-divider-line", "aria-hidden": "true" }),
				],
			);

		mainWrap.appendChild(insertDivider(0, "Insert block"));

		// Render from state.blocks (raw HTML),
		// then run sections/lightbox for parity (same as your live site).
		state.blocks.forEach((b, idx) => {
			const frag = new DOMParser().parseFromString(b.html, "text/html").body;
			Array.from(frag.children).forEach((n) => mainWrap.appendChild(n));
			mainWrap.appendChild(insertDivider(idx + 1, "Insert block"));
		});

		root.appendChild(mainWrap);

		queueMicrotask(() => {
			mainWrap.querySelectorAll(".cms-divider-btn").forEach((btn) => {
				btn.addEventListener("click", async () => {
					const at = Number(btn.getAttribute("data-insert") || "0");
					try {
						await insertTestBlockAt(at);
					} catch (err) {
						console.error(err);
						setUiState("error", "DISCONNECTED / ERROR");
						renderPageSurface();
					}
				});
			});
		});

		// Parity behaviours
		window.runSections?.();
		window.initLightbox?.();
	}

	// -------------------------
	// UI Shell
	// -------------------------
	function mountShell() {
		const statusPill = el(
			"span",
			{ id: "cms-status", class: "cms-pill warn" },
			["LOADING"],
		);

		const discardBtn = el(
			"button",
			{ class: "cms-btn", id: "cms-discard", disabled: "true" },
			["Discard"],
		);

		const exitBtn = el("button", { class: "cms-btn", id: "cms-exit" }, [
			"Exit Admin",
		]);

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
				el("div", { class: "cms-strip-mid" }, [statusPill, prLink]),
				el("div", { class: "cms-strip-right cms-controls" }, [
					discardBtn,
					exitBtn,
				]),
			]),
		);
	}

	// -------------------------
	// Data load
	// -------------------------
	async function loadSelectedPage() {
		state.path = getPagePathFromLocation();
		state.prUrl = "";
		state.prNumber = null;
		stopPrPolling();

		setUiState("loading", "LOADING / INITIALISING");
		renderPageSurface();

		const url = `/api/repo/file?path=${encodeURIComponent(state.path)}`;
		const res = await fetch(url, { headers: { Accept: "application/json" } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);

		const data = await res.json();
		state.originalHtml = data.text || "";

		// Load draft HTML if a dirty version exists for this path.
		let dirtyHtml = getDirtyHtml(state.path);
		if (dirtyHtml && dirtyHtml.trim() === state.originalHtml.trim()) {
			clearDirtyPage(state.path);
			dirtyHtml = "";
		}
		const workingHtml = dirtyHtml || state.originalHtml;

		const hero = extractRegion(workingHtml, "hero");
		const main = extractRegion(workingHtml, "main");

		const origHero = extractRegion(state.originalHtml, "hero");
		const origMain = extractRegion(state.originalHtml, "main");

		state.loadedHeroInner = origHero.found ? origHero.inner : "";
		state.loadedMainInner = origMain.found ? origMain.inner : "";

		state.heroInner = state.loadedHeroInner;
		state.mainInner = state.loadedMainInner;
		state.blocks = parseBlocks(state.mainInner);
		state.currentDirty = false;
		if (dirtyHtml) {
			state.heroInner = hero.found ? hero.inner : state.heroInner;
			state.mainInner = main.found ? main.inner : state.mainInner;
			state.blocks = parseBlocks(state.mainInner);
			state.currentDirty = true;
		}

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
			if (dirtyHtml && !state.currentDirty) clearDirtyPage(state.path);
			purgeCleanDirtyPages();
			if (dirtyCount()) setUiState("dirty", buildDirtyLabel());
			else setUiState("clean", "CONNECTED - CLEAN");
		}

		renderPageSurface();
	}

	async function openDiscardModal() {
		openLoadingModal("Loading changes");
		await purgeDirtyPagesFromRepo();
		purgeCleanDirtyPages();
		if (!dirtyCount()) {
			qs("#cms-modal").classList.remove("is-open");
			document.documentElement.classList.remove("cms-lock");
			document.body.classList.remove("cms-lock");
			return;
		}

		const paths = Object.keys(state.dirtyPages || {});
		const blockData = await buildBlockDataMap(paths);
		const selectedPages = new Set();
		const selectedBlocks = new Map();
		let activeModes = new Set(["new"]);
		let list = null;

		const selectAll = el("input", { type: "checkbox", id: "cms-select-all" });
		const selectAllLabel = el(
			"label",
			{ for: "cms-select-all", class: "cms-modal__label" },
			["Select all pages"],
		);
		const selectAllRow = el("div", { class: "cms-modal__row" }, [
			selectAll,
			selectAllLabel,
		]);
		const divider = el("div", { class: "cms-modal__divider" }, []);
		const note = el("p", { class: "cms-modal__text" }, [
			"Confirm discarding the selected pages from memory.",
		]);

		const confirm = el("input", { type: "checkbox", id: "cms-confirm-discard" });
		const confirmLabel = el(
			"label",
			{ for: "cms-confirm-discard", class: "cms-modal__label" },
			["I understand all selected pages will be deleted"],
		);
		const confirmRow = el("div", { class: "cms-modal__row" }, [
			confirm,
			confirmLabel,
		]);

		const codeLabel = el(
			"label",
			{ for: "cms-discard-code", class: "cms-modal__label" },
			["Type DISCARD to confirm"],
		);
		const codeInput = el("input", {
			id: "cms-discard-code",
			class: "cms-modal__input",
			type: "text",
			placeholder: "DISCARD",
		});

		const action = el(
			"button",
			{
				class: "cms-btn cms-modal__action",
				type: "button",
				disabled: "true",
				"data-variant": "danger",
			},
			["Discard selected"],
		);

		const updateSelectAll = () => {
			const totalSelectable = paths.reduce((sum, path) => {
				const entry = blockData[path];
				const blocks = getBlocksForModes(entry, activeModes).filter(
					(b) => b.selectable,
				);
				return sum + blocks.length;
			}, 0);
			const totalSelected = countSelectedBlocks(selectedBlocks);
			selectAll.checked = totalSelectable > 0 && totalSelected === totalSelectable;
		};

		const updateAction = () => {
			const hasSelection = countSelectedBlocks(selectedBlocks) > 0;
			const confirmed = confirm.checked && codeInput.value === "DISCARD";
			setActionState(action, hasSelection && confirmed);
			updateSelectAll();
		};

		const rerenderList = () => {
			const next = renderDirtyPageList({
				selectedPages,
				selectedBlocks,
				blockData,
				modes: activeModes,
				onSelectionChange: () => rerenderList(),
			});
			if (list) list.replaceWith(next);
			list = next;
			updateAction();
		};
		rerenderList();

		const toggle = buildModalToggleBar((modes) => {
			activeModes = modes;
			rerenderList();
		});

		selectAll.addEventListener("change", () => {
			selectedPages.clear();
			selectedBlocks.clear();
			if (selectAll.checked) {
				paths.forEach((path) => {
					const entry = blockData[path];
					const blocks = getBlocksForModes(entry, activeModes);
					const selectable = blocks.filter((b) => b.selectable).map((b) => b.id);
					selectedPages.add(path);
					selectedBlocks.set(path, new Set(selectable));
				});
			}
			rerenderList();
		});

		confirm.addEventListener("change", updateAction);
		codeInput.addEventListener("input", updateAction);
		updateAction();

		action.addEventListener("click", () => {
			const pathsToProcess = Array.from(selectedPages);
			if (!pathsToProcess.length) return;
			pathsToProcess.forEach((path) => {
				const entry = blockData[path];
				const selectedIds = selectedBlocks.get(path) || new Set();
				const updatedHtml = buildHtmlForSelection(entry, selectedIds, "discard");
				if (!updatedHtml || updatedHtml.trim() === entry.baseHtml.trim())
					clearDirtyPage(path);
				else setDirtyPage(path, updatedHtml, entry.baseHtml);
				if (path === state.path) applyHtmlToCurrentPage(updatedHtml);
			});
			purgeCleanDirtyPages();
			qs("#cms-modal").classList.remove("is-open");
			document.documentElement.classList.remove("cms-lock");
			document.body.classList.remove("cms-lock");
			refreshUiStateForDirty();
			renderPageSurface();
		});

		openModal({
			title: "Discard changes",
			bodyNodes: [
				toggle,
				selectAllRow,
				list,
				divider,
				note,
				confirmRow,
				codeLabel,
				codeInput,
			],
			footerNodes: [action],
		});
	}

	async function openExitModal() {
		await purgeDirtyPagesFromRepo();
		purgeCleanDirtyPages();
		if (!dirtyCount()) {
			const host = location.hostname;
			const target = host.startsWith("dev.")
				? "https://dev.portfolio.tacsa.co.uk/"
				: "https://portfolio.tacsa.co.uk/";
			location.href = target;
			return;
		}

		const divider = el("div", { class: "cms-modal__divider" }, []);
		const note = el("p", { class: "cms-modal__text" }, [
			"Exit will discard all staged changes across pages.",
		]);

		const confirm = el("input", { type: "checkbox", id: "cms-confirm-exit" });
		const confirmLabel = el(
			"label",
			{ for: "cms-confirm-exit", class: "cms-modal__label" },
			["I understand all staged changes will be deleted"],
		);
		const confirmRow = el("div", { class: "cms-modal__row" }, [
			confirm,
			confirmLabel,
		]);

		const codeLabel = el(
			"label",
			{ for: "cms-exit-code", class: "cms-modal__label" },
			["Type EXIT to confirm"],
		);
		const codeInput = el("input", {
			id: "cms-exit-code",
			class: "cms-modal__input",
			type: "text",
			placeholder: "EXIT",
		});

		const action = el(
			"button",
			{
				class: "cms-btn cms-modal__action",
				type: "button",
				disabled: "true",
				"data-variant": "danger",
			},
			["Exit Admin"],
		);

		const updateAction = () => {
			const confirmed = confirm.checked && codeInput.value === "EXIT";
			setActionState(action, confirmed);
		};

		confirm.addEventListener("change", updateAction);
		codeInput.addEventListener("input", updateAction);
		updateAction();

		action.addEventListener("click", () => {
			state.dirtyPages = {};
			state.currentDirty = false;
			saveDirtyPagesToStorage();
			localStorage.removeItem(DIRTY_STORAGE_KEY);
			const host = location.hostname;
			const target = host.startsWith("dev.")
				? "https://dev.portfolio.tacsa.co.uk/"
				: "https://portfolio.tacsa.co.uk/";
			location.href = target;
		});

		openModal({
			title: "Exit Admin",
			bodyNodes: [divider, note, confirmRow, codeLabel, codeInput],
			footerNodes: [action],
		});
	}

	async function openPrModal() {
		openLoadingModal("Loading changes");
		stashCurrentPageIfDirty();
		await purgeDirtyPagesFromRepo();
		purgeCleanDirtyPages();
		const dirtyPaths = Object.keys(state.dirtyPages || {});
		if (!dirtyPaths.length) {
			qs("#cms-modal").classList.remove("is-open");
			document.documentElement.classList.remove("cms-lock");
			document.body.classList.remove("cms-lock");
			return;
		}

		const blockData = await buildBlockDataMap(dirtyPaths);
		const selectedPages = new Set();
		const selectedBlocks = new Map();
		let activeModes = new Set(["new"]);
		let list = null;

		const selectAll = el("input", { type: "checkbox", id: "cms-select-all-pr" });
		const selectAllLabel = el(
			"label",
			{ for: "cms-select-all-pr", class: "cms-modal__label" },
			["Select all pages"],
		);
		const selectAllRow = el("div", { class: "cms-modal__row" }, [
			selectAll,
			selectAllLabel,
		]);

		const noteLabel = el(
			"label",
			{ for: "cms-pr-note", class: "cms-modal__label" },
			["PR message"],
		);
		const noteInput = el("textarea", {
			id: "cms-pr-note",
			class: "cms-modal__textarea",
		});
		noteInput.value = "Created by Portfolio CMS";

		const mention = el("div", { class: "cms-modal__note" }, [
			"@VoodooScience1 please review + merge.",
		]);

		const action = el(
			"button",
			{
				class: "cms-btn cms-modal__action",
				type: "button",
				disabled: "true",
				"data-variant": "success",
			},
			["Create PR"],
		);

		const divider = el("div", { class: "cms-modal__divider" }, []);
		const confirm = el("input", { type: "checkbox", id: "cms-confirm-pr" });
		const confirmLabel = el(
			"label",
			{ for: "cms-confirm-pr", class: "cms-modal__label" },
			["I understand the selected pages will be committed"],
		);
		const confirmRow = el("div", { class: "cms-modal__row" }, [
			confirm,
			confirmLabel,
		]);

		const codeLabel = el(
			"label",
			{ for: "cms-pr-code", class: "cms-modal__label" },
			["Type CREATE to confirm"],
		);
		const codeInput = el("input", {
			id: "cms-pr-code",
			class: "cms-modal__input",
			type: "text",
			placeholder: "CREATE",
		});

		const updateSelectAll = () => {
			const totalSelectable = dirtyPaths.reduce((sum, path) => {
				const entry = blockData[path];
				const blocks = getBlocksForModes(entry, activeModes).filter(
					(b) => b.selectable,
				);
				return sum + blocks.length;
			}, 0);
			const totalSelected = countSelectedBlocks(selectedBlocks);
			selectAll.checked = totalSelectable > 0 && totalSelected === totalSelectable;
		};

		const updateAction = () => {
			const hasSelection = countSelectedBlocks(selectedBlocks) > 0;
			const confirmed = confirm.checked && codeInput.value === "CREATE";
			setActionState(action, hasSelection && confirmed);
			updateSelectAll();
		};

		const rerenderList = () => {
			const next = renderDirtyPageList({
				selectedPages,
				selectedBlocks,
				blockData,
				modes: activeModes,
				onSelectionChange: () => rerenderList(),
			});
			if (list) list.replaceWith(next);
			list = next;
			updateAction();
		};
		rerenderList();

		const toggle = buildModalToggleBar((modes) => {
			activeModes = modes;
			rerenderList();
		});

		selectAll.addEventListener("change", () => {
			selectedPages.clear();
			selectedBlocks.clear();
			if (selectAll.checked) {
				dirtyPaths.forEach((path) => {
					const entry = blockData[path];
					const blocks = getBlocksForModes(entry, activeModes);
					const selectable = blocks.filter((b) => b.selectable).map((b) => b.id);
					selectedPages.add(path);
					selectedBlocks.set(path, new Set(selectable));
				});
			}
			rerenderList();
		});

		confirm.addEventListener("change", updateAction);
		codeInput.addEventListener("input", updateAction);
		updateAction();

		action.addEventListener("click", () => {
			const pathsToProcess = Array.from(selectedPages);
			if (!pathsToProcess.length) return;
			const payloads = [];
			pathsToProcess.forEach((path) => {
				const entry = blockData[path];
				const selectedIds = selectedBlocks.get(path) || new Set();
				const commitHtml = buildHtmlForSelection(entry, selectedIds, "commit");
				const remainingHtml = buildHtmlForSelection(entry, selectedIds, "discard");
				if (commitHtml) {
					payloads.push({ path, text: commitHtml });
				}
				if (!remainingHtml || remainingHtml.trim() === entry.baseHtml.trim())
					clearDirtyPage(path);
				else setDirtyPage(path, remainingHtml, entry.baseHtml);
				if (path === state.path) applyHtmlToCurrentPage(remainingHtml);
			});

			qs("#cms-modal").classList.remove("is-open");
			document.documentElement.classList.remove("cms-lock");
			document.body.classList.remove("cms-lock");

			if (!payloads.length) return;
			submitPr(payloads.map((p) => p.path), noteInput.value, payloads);
		});

		openModal({
			title: "Create Pull Request",
			bodyNodes: [
				toggle,
				selectAllRow,
				list,
				divider,
				noteLabel,
				noteInput,
				mention,
				confirmRow,
				codeLabel,
				codeInput,
			],
			footerNodes: [action],
		});
	}

	function bindUI() {
		const handleCommitClick = () => {
			openPrModal().catch((err) => console.error(err));
		};

		qs("#cms-exit")?.addEventListener("click", () => {
			openExitModal().catch((err) => console.error(err));
		});
		qs("#cms-discard")?.addEventListener("click", () => {
			openDiscardModal().catch((err) => console.error(err));
		});

		const attachNavCommit = () => {
			const link = document.querySelector('a[data-role="admin-link"]');
			if (!link) return false;
			link.textContent = "Commit PR";
			link.classList.add("cms-nav-pr");
			link.setAttribute("href", "#");
			link.setAttribute("role", "button");
			link.addEventListener("click", (event) => {
				event.preventDefault();
				handleCommitClick();
			});

			// Stash edits before leaving via nav links.
			document.querySelectorAll(".main-nav a").forEach((a) => {
				a.addEventListener("click", () => {
					stashCurrentPageIfDirty();
				});
			});
			return true;
		};

		const updateNavCommitState = () => {
			const link = document.querySelector('a[data-role="admin-link"]');
			if (!link) return;
			const hasDirty = dirtyCount() > 0;
			link.classList.remove(
				"cms-nav-pr--ok",
				"cms-nav-pr--warn",
				"cms-nav-pr--err",
				"cms-nav-pr--pr",
				"cms-nav-pr--readonly",
			);
			if (state.uiState === "pr") link.classList.add("cms-nav-pr--pr");
			else if (state.uiState === "readonly")
				link.classList.add("cms-nav-pr--readonly");
			else if (state.uiState === "loading")
				link.classList.add("cms-nav-pr--warn");
			else if (state.uiState === "error")
				link.classList.add("cms-nav-pr--err");
			else if (hasDirty) link.classList.add("cms-nav-pr--warn");
			else link.classList.add("cms-nav-pr--ok");
		};

		const waitForNav = () => {
			const ok = attachNavCommit();
			if (ok) {
				updateNavCommitState();
				return;
			}
			requestAnimationFrame(waitForNav);
		};

		waitForNav();
		state._updateNavCommitState = updateNavCommitState;
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
		loadSelectedPage().catch((err) => {
			console.error(err);
			setUiState("error", "DISCONNECTED / ERROR");
			renderPageSurface();
		});
	}

	window.addEventListener("beforeunload", () => {
		stashCurrentPageIfDirty();
		stopPrPolling();
	});

	if (document.readyState === "loading")
		document.addEventListener("DOMContentLoaded", boot);
	else boot();
})();
