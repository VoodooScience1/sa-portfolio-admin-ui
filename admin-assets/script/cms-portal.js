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
	const PORTAL_VERSION = "2026-02-15-elkfix3";
	const MERMAID_BUNDLE_VERSION = "2026-02-15-elkfix3";
	window.__CMS_PORTAL_VERSION__ = PORTAL_VERSION;
	console.log(`[cms-portal] loaded v${PORTAL_VERSION}`);

	// -------------------------
	// CONFIG
	// -------------------------
	const DEFAULT_PAGE = "index.html";
	const DIRTY_STORAGE_KEY = "cms-dirty-pages";
	const PR_STORAGE_KEY = "cms-pr-state";
	const SESSION_STORAGE_KEY = "cms-session-state";
	const DEBUG_ENABLED_DEFAULT = true;
	const DEBUG_CODE_STYLES_DEFAULT = false;
	const UPDATE_VERSION = 30;

	const BLOCK_LIBRARY = [
		{
			id: "std-container",
			label: "Standard container",
			partial: "/admin-assets/partials/CloudFlareCMS/std-container.html",
		},
		{
			id: "small-img-lrg-txt",
			label: "Small image + large text",
			partial: "/admin-assets/partials/CloudFlareCMS/small-img-lrg-txt.html",
		},
		{
			id: "split-50",
			label: "50/50 split",
			partial: "/admin-assets/partials/CloudFlareCMS/50-50-split.html",
		},
		{
			id: "two-col",
			label: "Two column",
			partial: "/admin-assets/partials/CloudFlareCMS/two-col.html",
		},
		{
			id: "hover-cards",
			label: "Hover cards row",
			partial: "/admin-assets/partials/CloudFlareCMS/hover-cards.html",
		},
		{
			id: "square-grid",
			label: "Square grid row",
			partial: "/admin-assets/partials/CloudFlareCMS/square-grid.html",
		},
		{
			id: "portfolio-grid",
			label: "Portfolio grid",
			partial: "/admin-assets/partials/CloudFlareCMS/portfolio-grid.html",
		},
		{
			id: "accordion-styled",
			label: "Accordion (styled)",
			partial: "/admin-assets/partials/CloudFlareCMS/styled-accordion.html",
		},
		{
			id: "divider",
			label: "Divider",
			partial: "/admin-assets/partials/CloudFlareCMS/divider.html",
		},
		{
			id: "empty-block",
			label: "Empty block (dev)",
			partial: "/admin-assets/partials/CloudFlareCMS/empty-block.html",
		},
	];
	const BUILD_TOKEN = Date.now().toString(36);

	function getPagePathFromLocation() {
		const raw = String(location.pathname || "").replace(/^\/+/, "");
		if (!raw || raw === "index.html") return DEFAULT_PAGE;
		return raw;
	}

	// -------------------------
	// Tiny utilities
	// -------------------------
	const qs = (sel, root = document) => root.querySelector(sel);
	let localIdCounter = 0;
	const makeLocalId = () => {
		localIdCounter += 1;
		return `loc-${Date.now().toString(36)}-${localIdCounter}`;
	};

	const installMermaidWarningFilter = () => {
		if (window.__CMS_MERMAID_WARN_FILTER_INSTALLED) return;
		const originalWarn = console.warn;
		if (typeof originalWarn !== "function") return;
		window.__CMS_MERMAID_WARN_FILTER_INSTALLED = true;
		console.warn = function (...args) {
			const joined = args.map((v) => String(v || "")).join(" ");
			if (
				joined.includes(
					"Do not assign mappings to elements without corresponding data",
				)
			) {
				return;
			}
			return originalWarn.apply(this, args);
		};
	};

	const el = (tag, attrs = {}, children = []) => {
		const n = document.createElement(tag);
		Object.entries(attrs || {}).forEach(([k, v]) => {
			if (k === "class") n.className = v;
			else if (k === "html") n.innerHTML = v;
			else if (k.startsWith("on") && typeof v === "function")
				n.addEventListener(k.slice(2), v);
			else if (v === null || v === undefined) return;
			else n.setAttribute(k, String(v));
		});
		(children || []).forEach((c) =>
			n.appendChild(typeof c === "string" ? document.createTextNode(c) : c),
		);
		return n;
	};

	function debugEnabled() {
		const raw = localStorage.getItem("cms-debug");
		if (raw === null) return DEBUG_ENABLED_DEFAULT;
		return raw === "1";
	}

	function debugCodeStylesEnabled() {
		const raw = localStorage.getItem("cms-debug-code-styles");
		if (raw === null) return DEBUG_CODE_STYLES_DEFAULT;
		return raw === "1";
	}

	function setDebugEnabled(val) {
		localStorage.setItem("cms-debug", val ? "1" : "0");
		state.debug = Boolean(val);
		if (state.debug) {
			window.__CMS_DEBUG__ = {
				buildBaseBlocksWithOcc: (html) => buildBaseBlocksWithOcc(html),
				buildMergedRenderBlocks: (html, locals, options) =>
					buildMergedRenderBlocks(html, locals, options),
				parseBlocks: (html) => parseBlocks(html),
				assignAnchorsFromHtml: (baseHtml, mergedHtml, locals) =>
					assignAnchorsFromHtml(baseHtml, mergedHtml, locals),
			};
		} else {
			delete window.__CMS_DEBUG__;
		}
		renderDebugOverlay();
		renderDebugPill();
	}

	function setDebugCodeStylesEnabled(val) {
		localStorage.setItem("cms-debug-code-styles", val ? "1" : "0");
		state.debugCodeStyles = Boolean(val);
		renderDebugOverlay();
	}

	function normalizeFragmentHtml(html) {
		const doc = new DOMParser().parseFromString(
			`<div id="__wrap__">${String(html || "")}</div>`,
			"text/html",
		);
		const wrap = doc.querySelector("#__wrap__");
		if (!wrap) return "";

		const stripCmsIds = (node) => {
			if (node.nodeType !== Node.ELEMENT_NODE) return;
			node.removeAttribute("data-cms-id");
			Array.from(node.children).forEach((child) => stripCmsIds(child));
		};

		const stripHighlightMarkup = (node) => {
			if (node.nodeType !== Node.ELEMENT_NODE) return;
			node.querySelectorAll?.("[data-cms-preview]").forEach((el) => el.remove());
			node
				.querySelectorAll?.(
					".mermaid-wrap, .mermaid-admin-preview, .cms-mermaid-preview__diagram",
				)
				.forEach((el) => el.remove());
			node
				.querySelectorAll?.("[data-processed]")
				.forEach((el) => el.removeAttribute("data-processed"));
			if (node.classList?.contains("hljs")) node.classList.remove("hljs");
			if (node.hasAttribute?.("data-highlighted"))
				node.removeAttribute("data-highlighted");
			if (node.tagName?.toLowerCase() === "code") {
				node.classList?.remove("hljs");
				node.removeAttribute?.("data-highlighted");
			}
			node.querySelectorAll?.("code").forEach((code) => {
				code.classList.remove("hljs");
				code.removeAttribute("data-highlighted");
			});
			node.querySelectorAll?.("span").forEach((span) => {
				const cls = span.getAttribute("class") || "";
				const isHljs = cls
					.split(/\s+/)
					.some((c) => c === "hljs" || c.startsWith("hljs-"));
				if (!isHljs) return;
				span.replaceWith(document.createTextNode(span.textContent || ""));
			});
		};

		const parts = [];
		wrap.childNodes.forEach((node) => {
			if (node.nodeType === Node.ELEMENT_NODE) {
				const clone = node.cloneNode(true);
				stripCmsIds(clone);
				stripHighlightMarkup(clone);
				parts.push(clone.outerHTML);
				return;
			}
			if (node.nodeType === Node.TEXT_NODE) {
				const text = (node.textContent || "").replace(/\s+/g, " ").trim();
				if (text) parts.push(`#text:${text}`);
			}
		});
		return parts.join("\n");
	}

	function escapeHtml(text) {
		return String(text || "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;");
	}

	function escapeAttr(text) {
		return escapeHtml(text).replace(/"/g, "&quot;");
	}

	function indentLines(text, level) {
		const pad = "\t".repeat(level);
		const raw = String(text || "");
		const pres = [];
		const placeholder = raw.replace(/<pre[\s\S]*?<\/pre>/gi, (match) => {
			const token = `__CMS_PRE_${pres.length}__`;
			pres.push(match);
			return token;
		});
		const lines = placeholder.split("\n");
		const indented = lines
			.map((line) => (line ? `${pad}${line}` : line))
			.join("\n");
		return indented.replace(
			/__CMS_PRE_(\d+)__/g,
			(_, idx) => pres[Number(idx)],
		);
	}

	function normalizeBool(val, fallback = "false") {
		if (val === true) return "true";
		if (val === false) return "false";
		const raw = String(val || "")
			.trim()
			.toLowerCase();
		if (raw === "true" || raw === "false") return raw;
		return fallback;
	}

	function guessLanguageFromText(text) {
		const raw = String(text || "").trim();
		if (!raw) return "auto";
		if (
			/(^|\n)\s*(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|architecture-beta|architecture)\b/i.test(
				raw,
			)
		)
			return "mermaid";
		if (raw.startsWith("<") || /<\/[a-z]/i.test(raw)) return "html";
		if (/^\s*[{[]/.test(raw) && /":\s*/.test(raw)) return "json";
		if (/(^|\n)\s*#/.test(raw) || /```/.test(raw)) return "markdown";
		if (
			/(^|\n)\s*(def|class|import|from|elif|except|with|yield|lambda)\b/.test(
				raw,
			) ||
			/(^|\n)\s*print\(/.test(raw) ||
			/(^|\n)\s*self\./.test(raw)
		)
			return "python";
		if (/(^|\n)\s*(const|let|var|function)\s+/.test(raw) || /=>/.test(raw))
			return "javascript";
		if (/[.#][A-Za-z0-9_-]+\s*\{/.test(raw) || /:\s*[^;]+;/.test(raw))
			return "css";
		if (/(^|\n)\s*[A-Za-z0-9_-]+\s*:\s*[^{};\n]+(\n|$)/.test(raw))
			return "yaml";
		return "auto";
	}

	function getLangFromCodeEl(codeEl) {
		if (!codeEl) return "";
		const cls = codeEl.getAttribute("class") || "";
		const match = cls.match(/language-([a-z0-9_-]+)/i);
		return match ? match[1] : codeEl.getAttribute("data-lang") || "";
	}

	function serializeAttrsOrdered(attrs, order) {
		const parts = [];
		order.forEach((key) => {
			if (!(key in attrs)) return;
			const value = attrs[key];
			if (value === null || value === undefined || value === "") return;
			parts.push(`${key}="${escapeAttr(value)}"`);
		});
		return parts.length ? ` ${parts.join(" ")}` : "";
	}

	function serializeImgStub(attrs) {
		let overlayText = attrs.overlayText || "";
		if (!attrs.overlayTitle && !overlayText && attrs.overlayEnabled !== false) {
			overlayText =
				normalizeBool(attrs.lightbox, "false") === "true"
					? "Click to view"
					: "";
		}
		const ordered = {
			class: "img-stub",
			"data-img": attrs.img || "",
			"data-caption": attrs.caption || "",
			"data-lightbox": normalizeBool(attrs.lightbox, "false"),
			"data-overlay": attrs.overlayEnabled === false ? "false" : "",
			"data-overlay-title": attrs.overlayTitle || "",
			"data-overlay-text": overlayText,
			"data-size": attrs.size || "",
			"data-scale": attrs.scale && attrs.scale !== "auto" ? attrs.scale : "",
		};
		const order = [
			"class",
			"data-img",
			"data-caption",
			"data-lightbox",
			"data-overlay",
			"data-overlay-title",
			"data-overlay-text",
			"data-size",
			"data-scale",
		];
		return `<div${serializeAttrsOrdered(ordered, order)}></div>`;
	}

	function serializeVideoStub(attrs) {
		const ordered = {
			class: "video-stub",
			"data-video": attrs.video || "",
			"data-caption": attrs.caption || "",
			"data-scale": attrs.scale && attrs.scale !== "auto" ? attrs.scale : "",
		};
		const order = ["class", "data-video", "data-caption", "data-scale"];
		return `<div${serializeAttrsOrdered(ordered, order)}></div>`;
	}

	function serializeDocEmbedStub(attrs) {
		const ordered = {
			class: "doc-embed",
			"data-doc": attrs.doc || "",
			"data-title": attrs.title || "",
			"data-desc": attrs.desc || "",
		};
		const order = ["class", "data-doc", "data-title", "data-desc"];
		return `<div${serializeAttrsOrdered(ordered, order)}></div>`;
	}

	function sanitizeImagePath(rawPath, fallbackName = "") {
		const base = "assets/img/";
		const raw = String(rawPath || fallbackName || "").trim();
		if (!raw) return "";
		let path = raw.replace(/^\/+/, "");
		if (path.startsWith(base)) {
			path = path.slice(base.length);
		} else if (path.startsWith("assets/")) {
			path = path.slice("assets/".length);
			if (path.startsWith("img/")) path = path.slice("img/".length);
		} else if (path.startsWith("img/")) {
			path = path.slice("img/".length);
		}
		const parts = path
			.split("/")
			.map((part) => part.replace(/[^A-Za-z0-9._-]/g, "-"))
			.filter((part) => part && part !== "." && part !== "..");
		if (!parts.length) return "";
		return `${base}${parts.join("/")}`;
	}

	function normalizeImageSource(value) {
		const raw = String(value || "").trim();
		if (!raw) return "";
		if (/^https?:\/\//i.test(raw)) return raw;
		const local = sanitizeImagePath(raw, "");
		return local ? `/${local}` : "";
	}

	function getYouTubeVideoId(value) {
		const raw = String(value || "").trim();
		if (!raw) return "";
		if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
		let url = null;
		try {
			url = new URL(raw);
		} catch {
			return "";
		}
		const host = url.hostname.toLowerCase();
		if (host.includes("youtu.be")) {
			return url.pathname.replace(/^\/+/, "").split("/")[0] || "";
		}
		if (!host.includes("youtube.com")) return "";
		if (url.pathname === "/watch") {
			return url.searchParams.get("v") || "";
		}
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[0] === "embed" && parts[1]) return parts[1];
		if (parts[0] === "shorts" && parts[1]) return parts[1];
		if (parts[0] === "live" && parts[1]) return parts[1];
		return "";
	}

	function normalizeVideoSource(value) {
		const id = getYouTubeVideoId(value);
		return id ? `https://www.youtube.com/embed/${id}` : "";
	}

	function getLocalAssetPath(value) {
		const raw = String(value || "").trim();
		if (!raw) return "";
		if (/^https?:\/\//i.test(raw)) return "";
		return sanitizeImagePath(raw, "");
	}

	const ASSET_CACHE_DB = "cms-asset-cache";
	const ASSET_CACHE_STORE = "uploads";
	const ASSET_CACHE_MAX_BYTES = 25 * 1024 * 1024;
	let assetCachePromise = null;

	function openAssetCacheDb() {
		if (typeof indexedDB === "undefined") return Promise.resolve(null);
		if (assetCachePromise) return assetCachePromise;
		assetCachePromise = new Promise((resolve) => {
			const req = indexedDB.open(ASSET_CACHE_DB, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(ASSET_CACHE_STORE)) {
					const store = db.createObjectStore(ASSET_CACHE_STORE, {
						keyPath: "path",
					});
					store.createIndex("updatedAt", "updatedAt");
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => resolve(null);
		});
		return assetCachePromise;
	}

	function guessImageMime(path) {
		const ext =
			String(path || "")
				.split(".")
				.pop()
				?.toLowerCase() || "";
		if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
		if (ext === "png") return "image/png";
		if (ext === "webp") return "image/webp";
		if (ext === "gif") return "image/gif";
		if (ext === "svg") return "image/svg+xml";
		if (ext === "avif") return "image/avif";
		return "image/*";
	}

	async function assetCachePut(item) {
		const db = await openAssetCacheDb();
		if (!db || !item?.path) return;
		return new Promise((resolve) => {
			const tx = db.transaction(ASSET_CACHE_STORE, "readwrite");
			const store = tx.objectStore(ASSET_CACHE_STORE);
			store.put({
				path: item.path,
				content: item.content || "",
				encoding: item.encoding || "base64",
				mime: item.mime || "",
				bytes: item.bytes || (item.content ? item.content.length : 0),
				updatedAt: Date.now(),
			});
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
		});
	}

	async function assetCacheGet(path) {
		const db = await openAssetCacheDb();
		if (!db || !path) return null;
		return new Promise((resolve) => {
			const tx = db.transaction(ASSET_CACHE_STORE, "readonly");
			const store = tx.objectStore(ASSET_CACHE_STORE);
			const req = store.get(path);
			req.onsuccess = () => resolve(req.result || null);
			req.onerror = () => resolve(null);
		});
	}

	async function assetCachePrune(keepPaths) {
		const db = await openAssetCacheDb();
		if (!db) return;
		const keep = new Set(keepPaths || []);
		return new Promise((resolve) => {
			const tx = db.transaction(ASSET_CACHE_STORE, "readwrite");
			const store = tx.objectStore(ASSET_CACHE_STORE);
			const req = store.getAll();
			req.onsuccess = () => {
				const items = Array.isArray(req.result) ? req.result : [];
				let total = 0;
				items.forEach((item) => {
					total += Number(item.bytes || 0);
					if (keep.size && !keep.has(item.path)) store.delete(item.path);
				});
				if (ASSET_CACHE_MAX_BYTES && total > ASSET_CACHE_MAX_BYTES) {
					const sorted = items
						.filter((item) => !(keep.size && keep.has(item.path)))
						.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
					let remaining = total;
					for (const item of sorted) {
						store.delete(item.path);
						remaining -= Number(item.bytes || 0);
						if (remaining <= ASSET_CACHE_MAX_BYTES) break;
					}
				}
			};
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
		});
	}

	function getCachedAssetDataUrl(path) {
		if (!path) return "";
		const item = (state.assetUploads || []).find((it) => it.path === path);
		if (!item?.content) return "";
		const mime = item.mime || guessImageMime(path);
		return `data:${mime};base64,${item.content}`;
	}

	function sanitizeHref(href) {
		const raw = String(href || "").trim();
		if (!raw) return "";
		if (raw.startsWith("/")) return raw;
		if (raw.startsWith("https://")) return raw;
		return "";
	}

	function normalizeDocPath(value) {
		const raw = String(value || "").trim();
		if (!raw) return "";
		if (/^https?:\/\//i.test(raw)) return raw;
		let path = raw.replace(/^\/+/, "");
		if (path.startsWith("docs/")) path = `assets/${path}`;
		else if (!path.startsWith("assets/")) path = `assets/docs/${path}`;
		return `/${path}`;
	}

	function sanitizeRteHtml(html, ctx = {}) {
		let rawHtml = String(html || "");
		rawHtml = rawHtml.replace(
			/<code\b[^>]*>([\s\S]*?)<\/code>/gi,
			(match, inner) => {
				const escaped = String(inner || "")
					.replace(/&(?!(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;")
					.replace(/</g, "&lt;")
					.replace(/>/g, "&gt;");
				return match.replace(inner, escaped);
			},
		);
		const doc = new DOMParser().parseFromString(
			`<div id="__wrap__">${rawHtml}</div>`,
			"text/html",
		);
		const wrap = doc.querySelector("#__wrap__");
		if (!wrap) return "";
		wrap.querySelectorAll(".cms-code-toolbar").forEach((node) => node.remove());
		wrap
			.querySelectorAll(".cms-accordion-actions")
			.forEach((node) => node.remove());
		wrap
			.querySelectorAll(
				"select.cms-code-toolbar__select, .cms-code-toolbar__btn",
			)
			.forEach((node) => node.remove());

		const mergeAdjacentPres = (parent) => {
			const children = Array.from(parent.childNodes);
			for (let i = 0; i < children.length; i += 1) {
				const node = children[i];
				if (!(node instanceof Element)) continue;
				if (node.tagName.toLowerCase() !== "pre") {
					if (node.childNodes?.length) mergeAdjacentPres(node);
					continue;
				}
				const codeEl = node.querySelector("code");
				const baseText = codeEl ? codeEl.textContent : node.textContent;
				const lines = [baseText || ""].map((t) =>
					String(t || "").replace(/\n+$/g, ""),
				);
				let j = i + 1;
				while (j < children.length) {
					const next = children[j];
					if (next instanceof Element && next.tagName.toLowerCase() === "pre") {
						const nextCode = next.querySelector("code");
						const nextText = nextCode ? nextCode.textContent : next.textContent;
						lines.push(String(nextText || "").replace(/\n+$/g, ""));
						next.remove();
						j += 1;
						continue;
					}
					if (
						next?.nodeType === Node.TEXT_NODE &&
						String(next.textContent || "").trim() === ""
					) {
						next.remove();
						j += 1;
						continue;
					}
					break;
				}
				const merged = lines.join("\n");
				const lang = getLangFromCodeEl(node.querySelector("code")) || "";
				const clean = doc.createElement("code");
				if (lang) clean.className = `language-${lang}`;
				clean.textContent = merged;
				node.innerHTML = "";
				node.appendChild(clean);
			}
		};

		mergeAdjacentPres(wrap);

		const accState = ctx._accordionState || { index: 0 }; // 0-based item index per ADR-015
		const pageHash = ctx.pageHash || hashText(ctx.path || "");
		const blockShort = ctx.blockIdShort || hashText(ctx.blockId || "block");

		const blockTags = new Set([
			"div",
			"p",
			"h1",
			"h2",
			"h3",
			"blockquote",
			"table",
			"thead",
			"tbody",
			"tr",
			"th",
			"td",
			"pre",
			"ul",
			"ol",
			"li",
		]);
		const isBlockNode = (node) =>
			node?.nodeType === Node.ELEMENT_NODE &&
			blockTags.has(node.tagName.toLowerCase());
		const serializeChildren = (node) => {
			const parts = [];
			Array.from(node.childNodes).forEach((child) => {
				const html = sanitizeNode(child);
				if (!html) return;
				parts.push({ html, block: isBlockNode(child) });
			});
			return parts
				.map((part, idx) => {
					if (!idx) return part.html;
					const prev = parts[idx - 1];
					if (prev.block && part.block) return `\n${part.html}`;
					return part.html;
				})
				.join("");
		};

		const serializeAccordion = (node) => {
			const itemIndex = accState.index;
			accState.index += 1;
			const id = `acc-${pageHash}-${blockShort}-${itemIndex}`;
			const labelNode = node.querySelector(".tab-label");
			const contentNode = node.querySelector(".tab-content");
			const title = labelNode?.textContent?.trim() || "Item";
			const body = contentNode
				? sanitizeRteHtml(contentNode.innerHTML, {
						...ctx,
						_accordionState: accState,
					})
				: "";

			const lines = [
				`<div class="tab">`,
				`\t<input type="checkbox" id="${escapeAttr(id)}" />`,
				`\t<label class="tab-label" for="${escapeAttr(id)}">${escapeHtml(title)}</label>`,
				`\t<div class="tab-content">`,
				body ? indentLines(body, 2) : "",
				`\t</div>`,
				`</div>`,
			].filter((line) => line !== "");
			return lines.join("\n");
		};

		const serializeDocCard = (node) => {
			const link =
				node.querySelector(".doc-card__link") || node.querySelector("a");
			const href = sanitizeHref(link?.getAttribute("href") || "");
			if (!href) return "";
			const title =
				node.querySelector(".doc-card__title")?.textContent?.trim() ||
				link?.textContent?.trim() ||
				"Document";
			const desc =
				node.querySelector(".doc-card__desc")?.textContent?.trim() || "";
			const target =
				link?.getAttribute("target") === "_blank" ? "_blank" : "_blank";
			const rel = target === "_blank" ? "noopener noreferrer" : "";
			const safeDesc = desc ? `<div class="doc-card__desc">${escapeHtml(desc)}</div>` : "";
			return [
				`<div class="doc-card doc-card--compact">`,
				`<a class="doc-card__link" href="${escapeAttr(
					href,
				)}" target="${target}" rel="${rel}" data-doc-open>`,
				`<span class="material-icons doc-card__type-icon" aria-hidden="true">insert_drive_file</span>`,
				`<div class="doc-card__text">`,
				`<div class="doc-card__title">${escapeHtml(title)}</div>`,
				safeDesc,
				`</div>`,
				`<div class="doc-card__overlay">`,
				`<div class="doc-card__overlay-content">`,
				`<span class="material-icons" aria-hidden="true">open_in_new</span>`,
				`<span class="doc-card__overlay-label">Open document</span>`,
				`</div>`,
				`</div>`,
				`</a>`,
				`</div>`,
			]
				.filter(Boolean)
				.join("");
		};

		const serializeDocEmbed = (node) => {
			const href = sanitizeHref(normalizeDocPath(node.getAttribute("data-doc")));
			if (!href) return "";
			const title = node.getAttribute("data-title") || "";
			const desc = node.getAttribute("data-desc") || "";
			return serializeDocEmbedStub({ doc: href, title, desc });
		};

		const serializeStandardImage = (node) => {
			const img = node.querySelector("img");
			const src = img?.getAttribute("src") || "";
			const alt = img?.getAttribute("alt") || "";
			if (!src) return "";
			return [
				`<div class="img-text-div-img">`,
				`\t<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" />`,
				`</div>`,
			].join("\n");
		};

		const sanitizeNode = (node) => {
			if (node.nodeType === Node.TEXT_NODE) {
				const text = node.textContent || "";
				if (
					/Auto\s*JS\s*JSON\s*HTML\s*CSS\s*Python\s*Markdown\s*YAML\s*Format/.test(
						text,
					)
				) {
					const cleaned = text.replace(
						/Auto\s*JS\s*JSON\s*HTML\s*CSS\s*Python\s*Markdown\s*YAML\s*Format/g,
						"",
					);
					if (!cleaned.trim()) return "";
					return escapeHtml(cleaned.replace(/\s+/g, " "));
				}
				const normalized = text.replace(/\s+/g, " ");
				if (!normalized.trim()) return "";
				return escapeHtml(normalized);
			}
			if (node.nodeType !== Node.ELEMENT_NODE) return "";

			const tag = node.tagName.toLowerCase();
			const cls = node.getAttribute("class") || "";

			if (cls.includes("cms-inline-actions")) return "";
			if (cls.includes("cms-table-wrap")) return serializeChildren(node);

			if (tag === "div") {
				if (cls.includes("img-stub")) {
					const overlayEnabled = node.getAttribute("data-overlay") !== "false";
					return serializeImgStub({
						img: node.getAttribute("data-img") || "",
						caption: node.getAttribute("data-caption") || "",
						lightbox: node.getAttribute("data-lightbox") || "false",
						overlayEnabled,
						overlayTitle: node.getAttribute("data-overlay-title") || "",
						overlayText: node.getAttribute("data-overlay-text") || "",
						size: node.getAttribute("data-size") || "",
						scale: node.getAttribute("data-scale") || "",
					});
				}
				if (
					cls.includes("flex-accordion-wrapper") ||
					cls.includes("flex-accordion-box")
				) {
					const cleanCls = cls
						.split(/\s+/)
						.filter((name) => name && !name.startsWith("cms-"))
						.join(" ");
					const inner = serializeChildren(node);
					const classAttr = cleanCls ? ` class="${escapeAttr(cleanCls)}"` : "";
					return `<div${classAttr}>${inner}</div>`;
				}
				if (cls.includes("video-stub")) {
					return serializeVideoStub({
						video: node.getAttribute("data-video") || "",
						caption: node.getAttribute("data-caption") || "",
						scale: node.getAttribute("data-scale") || "",
					});
				}
				if (cls.includes("tab")) return serializeAccordion(node);
				if (cls.includes("doc-card")) return serializeDocCard(node);
				if (cls.includes("doc-embed")) return serializeDocEmbed(node);
				if (cls.includes("img-text-div-img"))
					return serializeStandardImage(node);
				if (cls && cls.trim()) {
					// Disallow arbitrary classes from free typing.
					return serializeChildren(node);
				}
				const inner = serializeChildren(node);
				return `<div>${inner}</div>`;
			}

			if (cls.includes("cms-code-toolbar")) return "";

			if (tag === "select" || tag === "option" || tag === "button") {
				return "";
			}

			if (tag === "code") {
				const lang = getLangFromCodeEl(node);
				const text = escapeHtml(node.textContent || "");
				if (lang) {
					return `<code class="language-${escapeAttr(lang)}">${text}</code>`;
				}
				return `<code>${text}</code>`;
			}

			if (tag === "p" || tag === "strong" || tag === "em" || tag === "u") {
				const inner = serializeChildren(node);
				return `<${tag}>${inner}</${tag}>`;
			}

			if (tag === "b") {
				const inner = serializeChildren(node);
				return `<strong>${inner}</strong>`;
			}

			if (tag === "i") {
				const inner = serializeChildren(node);
				return `<em>${inner}</em>`;
			}

			if (tag === "h1") {
				return serializeChildren(node);
			}

			if (tag === "h2" || tag === "h3") {
				const inner = serializeChildren(node);
				return `<${tag}>${inner}</${tag}>`;
			}

			if (tag === "blockquote") {
				const inner = serializeChildren(node);
				return `<blockquote>${inner}</blockquote>`;
			}

			if (tag === "table") {
				const inner = serializeChildren(node);
				const cls = node.getAttribute("class") || "";
				const isBorderless = cls.split(/\s+/).includes("table-borderless");
				return isBorderless
					? `<table class="table-borderless">${inner}</table>`
					: `<table>${inner}</table>`;
			}

			if (tag === "thead" || tag === "tbody") {
				const inner = serializeChildren(node);
				return `<${tag}>${inner}</${tag}>`;
			}

			if (tag === "tr") {
				const inner = serializeChildren(node);
				return `<tr>${inner}</tr>`;
			}

			if (tag === "th" || tag === "td") {
				const inner = serializeChildren(node);
				return `<${tag}>${inner}</${tag}>`;
			}

			if (tag === "pre") {
				const codeChild = node.querySelector("code");
				const lang = getLangFromCodeEl(codeChild);
				const rawText = codeChild ? codeChild.textContent : node.textContent;
				const text = escapeHtml(rawText || "");
				if (lang) {
					return `<pre><code class="language-${escapeAttr(lang)}">${text}</code></pre>`;
				}
				return `<pre><code>${text}</code></pre>`;
			}

			if (tag === "ul" || tag === "ol") {
				const inner = serializeChildren(node);
				return `<${tag}>${inner}</${tag}>`;
			}

			if (tag === "li") {
				const inner = serializeChildren(node).trim();
				return `<li>${inner}</li>`;
			}

			if (tag === "br") return "<br />";

			if (tag === "a") {
				const href = sanitizeHref(node.getAttribute("href"));
				if (!href) return serializeChildren(node);
				const target =
					node.getAttribute("target") === "_blank" ? "_blank" : null;
				const rel = target === "_blank" ? "noopener noreferrer" : null;
				const attrs = {
					href,
					target,
					rel,
				};
				const order = ["href", "target", "rel"];
				return `<a${serializeAttrsOrdered(attrs, order)}>${serializeChildren(
					node,
				)}</a>`;
			}

			if (tag === "img") {
				// ADR-014: images must not be emitted as raw <img> from RTE.
				// Allowed image insertions are tool-emitted patterns handled above:
				// - <div class="img-stub" ...></div>
				// - <div class="img-text-div-img"><img ... /></div>
				return "";
			}

			if (tag === "input" || tag === "label") {
				// Accordion elements are handled by the tab wrapper.
				return "";
			}

			return serializeChildren(node);
		};

		return serializeChildren(wrap).trim();
	}

	function parseHeroInner(innerHtml) {
		const doc = new DOMParser().parseFromString(
			`<div id="__wrap__">${String(innerHtml || "")}</div>`,
			"text/html",
		);
		const wrap = doc.querySelector("#__wrap__");
		const hero = wrap?.querySelector(".default-div-wrapper.hero-override");
		if (!hero) {
			return { type: "legacy", raw: innerHtml || "" };
		}
		const titleEl = hero.querySelector("h1");
		const subtitleEl = hero.querySelector("p");
		const titleStyle = titleEl?.getAttribute("style") || "";
		const subtitleStyle = subtitleEl?.getAttribute("style") || "";
		const titleAlign = /text-align\s*:/i.test(titleStyle)
			? normalizeHeadingAlign(getHeadingAlignFromStyle(titleStyle), "center")
			: "center";
		const subtitleAlign = /text-align\s*:/i.test(subtitleStyle)
			? normalizeHeadingAlign(getHeadingAlignFromStyle(subtitleStyle), titleAlign)
			: titleAlign;
		const align = normalizeHeadingAlign(subtitleAlign || titleAlign, "center");
		const title = titleEl?.textContent?.trim() || "";
		const subtitle = subtitleEl?.textContent?.trim() || "";
		return { type: "hero", title, subtitle, align };
	}

	function serializeHeroInner(model) {
		if (!model || model.type !== "hero") {
			return String(model?.raw || "").trim();
		}
		const title = escapeHtml(model.title || "");
		const subtitle = escapeHtml(model.subtitle || "");
		const align = normalizeHeadingAlign(model.align, "center");
		const titleStyle = applyTextAlignStyle("", align);
		const subtitleStyle = applyTextAlignStyle("", align);
		const titleAttr = titleStyle ? ` style="${escapeAttr(titleStyle)}"` : "";
		const subtitleAttr = subtitleStyle
			? ` style="${escapeAttr(subtitleStyle)}"`
			: "";
		return [
			`<div class="div-wrapper">`,
			`\t<div class="default-div-wrapper hero-override">`,
			`\t\t<div class="std-container-text">`,
			`\t\t\t<h1${titleAttr}>${title}</h1>`,
			`\t\t\t<p${subtitleAttr}>${subtitle}</p>`,
			`\t\t</div>`,
			`\t</div>`,
			`</div>`,
		].join("\n");
	}

	function heroModelsEqual(a, b) {
		if (!a || !b) return false;
		if (a.type !== b.type) return false;
		if (a.type === "hero") {
			return (
				a.title === b.title &&
				a.subtitle === b.subtitle &&
				normalizeHeadingAlign(a.align, "center") ===
					normalizeHeadingAlign(b.align, "center")
			);
		}
		return String(a.raw || "").trim() === String(b.raw || "").trim();
	}

	function applyHeroRegion(html, innerHtml) {
		const trimmed = String(innerHtml || "").trim();
		if (!trimmed) return html;
		const hero = extractRegion(html || "", "hero");
		if (!hero.found) return html;
		return replaceRegion(html, "hero", trimmed);
	}

	function normalizePortfolioBool(value, fallback) {
		if (value === undefined || value === null) return fallback;
		if (typeof value === "string")
			return String(value).toLowerCase() !== "false";
		return Boolean(value);
	}

	function normalizePortfolioTypeLabel(value) {
		return String(value || "").trim();
	}

	function normalizePortfolioTypeKey(value) {
		const raw = normalizePortfolioTypeLabel(value).toLowerCase();
		if (!raw) return "";
		const key = raw
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+/, "")
			.replace(/-+$/, "");
		return key;
	}

	function normalizeHeadingAlign(value, fallback = "left") {
		const raw = String(value || "").toLowerCase();
		if (raw === "center") return "center";
		if (raw === "left") return "left";
		return fallback;
	}

	function getHeadingAlignFromStyle(style) {
		const match = String(style || "").match(/text-align\s*:\s*(left|center)/i);
		return match ? match[1].toLowerCase() : "left";
	}

	function applyTextAlignStyle(style, align) {
		const rawStyle = String(style || "");
		const hasAlign = /text-align\s*:/i.test(rawStyle);
		const cleaned = rawStyle
			.split(";")
			.map((part) => part.trim())
			.filter(Boolean)
			.filter((part) => !/^text-align\s*:/i.test(part))
			.join("; ");
		const normalizedAlign = normalizeHeadingAlign(align, "left");
		if (normalizedAlign === "center") {
			return cleaned ? `${cleaned}; text-align: center;` : "text-align: center;";
		}
		if (normalizedAlign === "left") {
			if (!hasAlign) return cleaned;
			return cleaned ? `${cleaned}; text-align: left;` : "text-align: left;";
		}
		return cleaned;
	}

	function slugifyHeading(text) {
		const raw = String(text || "").trim().toLowerCase();
		if (!raw) return "";
		return raw
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+/, "")
			.replace(/-+$/, "");
	}

	function resolveHeadingAnchor({ enabled, anchor, text }) {
		if (!enabled) return "";
		const existing = String(anchor || "").trim();
		if (existing) return existing;
		return slugifyHeading(text);
	}

	function buildHeadingHtml({ tag, text, align, style, anchor }) {
		const headingText = String(text || "").trim();
		if (!headingText) return "";
		const safeTag = String(tag || "h2").toLowerCase();
		const anchorValue = String(anchor || "").trim();
		const anchorAttr = anchorValue ? ` id="${escapeAttr(anchorValue)}"` : "";
		const mergedStyle = applyTextAlignStyle(style || "", align);
		const styleAttr = mergedStyle ? ` style="${escapeAttr(mergedStyle)}"` : "";
		return `<${safeTag}${anchorAttr}${styleAttr}>${escapeHtml(
			headingText,
		)}</${safeTag}>`;
	}

	function normalizePortfolioDate(value) {
		const raw = String(value || "").trim();
		if (!raw) return "";
		const lower = raw.toLowerCase();
		if (
			lower === "present" ||
			lower === "current" ||
			lower === "on-going" ||
			lower === "ongoing"
		)
			return "present";
		const match = raw.match(/(\d{1,2})\D+(\d{4})/);
		if (!match) return raw;
		const month = Math.max(1, Math.min(12, Number(match[1] || 0)));
		const year = Number(match[2] || 0);
		if (!year) return raw;
		return `${String(month).padStart(2, "0")}-${year}`;
	}

	function normalizePortfolioTags(value) {
		const rawList = Array.isArray(value)
			? value
			: String(value || "").split(",");
		const seen = new Set();
		const output = [];
		rawList.forEach((item) => {
			const tag = String(item || "").trim();
			if (!tag || seen.has(tag)) return;
			seen.add(tag);
			output.push(tag);
		});
		return output;
	}

	function normalizePortfolioLinks(value) {
		const raw = value && typeof value === "object" ? value : {};
		const keys = ["site", "github", "youtube", "facebook"];
		const output = {};
		keys.forEach((key) => {
			const href = sanitizeHref(raw[key] || "");
			if (href) output[key] = href;
		});
		return output;
	}

	function normalizePortfolioGallery(value) {
		const rawList = Array.isArray(value) ? value : [];
		const seen = new Set();
		const output = [];
		rawList.forEach((item) => {
			const raw =
				typeof item === "string" ? item : item?.src || item?.path || "";
			const safePath = sanitizeImagePath(raw || "", "");
			if (!safePath) return;
			const src = `/${safePath}`;
			if (seen.has(src)) return;
			seen.add(src);
			output.push(src);
		});
		return output;
	}

	function normalizePortfolioCard(raw) {
		const safe = raw && typeof raw === "object" ? raw : {};
		return {
			title: String(safe.title || "").trim(),
			type: normalizePortfolioTypeLabel(safe.type),
			start: normalizePortfolioDate(safe.start),
			end: normalizePortfolioDate(safe.end),
			summary: String(safe.summary || "").trim(),
			tags: normalizePortfolioTags(safe.tags),
			links: normalizePortfolioLinks(safe.links),
			gallery: normalizePortfolioGallery(safe.gallery),
		};
	}

	function isPortfolioCardEmpty(card) {
		const safe = card && typeof card === "object" ? card : {};
		const hasLinks =
			safe.links && typeof safe.links === "object"
				? Object.keys(safe.links).length > 0
				: false;
		return (
			!safe.title &&
			!safe.type &&
			!safe.start &&
			!safe.end &&
			!safe.summary &&
			!(safe.tags && safe.tags.length) &&
			!hasLinks &&
			!(safe.gallery && safe.gallery.length)
		);
	}

	function normalizePortfolioGrid(raw, attrs = {}) {
		const safe = raw && typeof raw === "object" ? raw : {};
		const title = String(safe.title || attrs.title || "").trim();
		const titleAnchor = String(
			safe.titleAnchor || attrs.titleAnchor || "",
		).trim();
		const rawAlign =
			typeof safe.titleAlign === "string" || typeof safe.titleAlign === "number"
				? String(safe.titleAlign)
				: typeof attrs.titleAlign === "string"
					? attrs.titleAlign
					: "";
		const titleAlign = rawAlign
			? normalizeHeadingAlign(rawAlign, "center")
			: "";
		const intro = String(safe.intro || attrs.intro || "").trim();
		const maxFromAttrs = Number(attrs.maxVisible);
		const maxFromData = Number(safe.maxVisible);
		const maxRaw = Number.isFinite(maxFromData)
			? maxFromData
			: Number.isFinite(maxFromAttrs)
				? maxFromAttrs
				: 3;
		const maxVisible = Number.isFinite(maxRaw)
			? Math.max(0, Math.floor(maxRaw))
			: 3;
		const showSearch = normalizePortfolioBool(
			safe.showSearch ?? attrs.showSearch,
			true,
		);
	const showTypeFilters = normalizePortfolioBool(
		safe.showTypeFilters ?? attrs.showTypeFilters,
		true,
	);
	const showTagFilters = normalizePortfolioBool(
		safe.showTagFilters ?? attrs.showTagFilters,
		true,
	);
	const showLinkFilters = normalizePortfolioBool(
		safe.showLinkFilters ?? attrs.showLinkFilters,
		true,
	);
	const cards = Array.isArray(safe.cards)
		? safe.cards
				.map((card) => normalizePortfolioCard(card))
				.filter((card) => !isPortfolioCardEmpty(card))
			: [];
		return {
			title,
			titleAnchor,
			titleAlign,
		intro,
		maxVisible,
		showSearch,
		showTypeFilters,
		showTagFilters,
		showLinkFilters,
		cards,
	};
}

	function parsePortfolioCardsFromHtml(node) {
		const cards = Array.from(node.querySelectorAll(".portfolio-card"));
		return cards.map((card) => {
			const title =
				card.querySelector(".portfolio-card__title")?.textContent?.trim() || "";
			const type =
				card.querySelector(".portfolio-card__type")?.textContent?.trim() ||
				card.getAttribute("data-type-label") ||
				"";
			const start = card.getAttribute("data-start") || "";
			const end = card.getAttribute("data-end") || "";
			const summary =
				card.querySelector(".portfolio-card__summary")?.innerHTML?.trim() || "";
			let tags = Array.from(card.querySelectorAll(".portfolio-card__tag"))
				.map((tag) => tag.textContent?.trim() || "")
				.filter(Boolean);
			if (!tags.length) {
				tags = String(card.getAttribute("data-tags") || "")
					.split(",")
					.map((tag) => tag.trim())
					.filter(Boolean);
			}
			const links = {};
			card.querySelectorAll(".portfolio-card__icon[data-link]").forEach((el) => {
				const key = el.getAttribute("data-link") || "";
				if (!key || key === "gallery") return;
				const href = el.getAttribute("href") || el.dataset.href || "";
				if (href) links[key] = href;
			});
			let gallery = [];
			const galleryRaw = card.getAttribute("data-gallery") || "";
			if (galleryRaw) {
				try {
					const parsed = JSON.parse(galleryRaw);
					if (Array.isArray(parsed)) gallery = parsed;
				} catch {
					gallery = galleryRaw
						.split(",")
						.map((item) => item.trim())
						.filter(Boolean);
				}
			}
			return {
				title,
				type,
				start,
				end,
				summary,
				tags,
				links,
				gallery,
			};
		});
	}

	function parsePortfolioGridNode(node) {
		const cmsId = node.getAttribute("data-cms-id") || "";
		const attrs = {};
		if (node.hasAttribute("data-max-visible")) {
			const maxVisible = Number(node.getAttribute("data-max-visible"));
			if (Number.isFinite(maxVisible)) attrs.maxVisible = maxVisible;
		}
		if (node.hasAttribute("data-show-search"))
			attrs.showSearch = node.getAttribute("data-show-search");
		if (node.hasAttribute("data-show-types"))
			attrs.showTypeFilters = node.getAttribute("data-show-types");
	if (node.hasAttribute("data-show-tags"))
		attrs.showTagFilters = node.getAttribute("data-show-tags");
	if (node.hasAttribute("data-show-links"))
		attrs.showLinkFilters = node.getAttribute("data-show-links");
		const headerEl = node.querySelector(".portfolio-grid__header h1,h2,h3");
		const headerText = headerEl?.textContent?.trim() || "";
		const headerStyle = headerEl?.getAttribute("style") || "";
		const headerAnchor = headerEl?.getAttribute("id") || "";
		if (/text-align\s*:/i.test(headerStyle)) {
			attrs.titleAlign = normalizeHeadingAlign(
				getHeadingAlignFromStyle(headerStyle),
				"center",
			);
		}
		if (headerAnchor) attrs.titleAnchor = headerAnchor;
		const introHtml = node.querySelector(".portfolio-grid__intro")?.innerHTML || "";

		let data = null;
		const script = node.querySelector(
			'script[type="application/json"][data-cms="portfolio"]',
		);
		if (script) {
			try {
				data = JSON.parse(script.textContent || "{}");
			} catch {
				data = null;
			}
		}

		let cards = [];
		if (!data || typeof data !== "object") {
			data = {};
			cards = parsePortfolioCardsFromHtml(node);
		} else if (!Array.isArray(data.cards)) {
			cards = parsePortfolioCardsFromHtml(node);
		} else {
			cards = data.cards;
		}
		const merged = {
			...attrs,
			title: data?.title ?? headerText,
			intro: data?.intro ?? introHtml,
			...(data || {}),
			cards,
		};
		const normalized = normalizePortfolioGrid(merged, attrs);
		return {
			type: "portfolioGrid",
			cmsId,
			...normalized,
		};
	}

	function parseMainBlockNode(node) {
		if (!node || !node.classList) {
			return { type: "legacy", raw: String(node?.outerHTML || "") };
		}
		const stripHighlightMarkup = (root) => {
			root.querySelectorAll("[data-cms-preview]").forEach((el) => el.remove());
			root.querySelectorAll("pre code").forEach((code) => {
				code.classList.remove("hljs");
				code.removeAttribute("data-highlighted");
				code.textContent = code.textContent || "";
			});
		};
		const cleanNode = node.cloneNode(true);
		stripHighlightMarkup(cleanNode);
		const cls = cleanNode.classList;
		const cmsId = cleanNode.getAttribute("data-cms-id") || "";
		if (cls.contains("section")) {
			const type = (cleanNode.getAttribute("data-type") || "").trim();
			if (type === "twoCol") {
				const leftNode = cleanNode.querySelector("[data-col='left']");
				const rightNode = cleanNode.querySelector("[data-col='right']");
				const leftHeadingEl = leftNode?.querySelector("h1,h2,h3");
				const rightHeadingEl = rightNode?.querySelector("h1,h2,h3");
				const leftHeadingTag = leftHeadingEl
					? leftHeadingEl.tagName.toLowerCase()
					: "h2";
				const rightHeadingTag = rightHeadingEl
					? rightHeadingEl.tagName.toLowerCase()
					: "h2";
				const safeLeftHeadingTag =
					leftHeadingTag === "h1" ? "h2" : leftHeadingTag;
				const safeRightHeadingTag =
					rightHeadingTag === "h1" ? "h2" : rightHeadingTag;
				const leftHeadingStyle = leftHeadingEl?.getAttribute("style") || "";
				const rightHeadingStyle = rightHeadingEl?.getAttribute("style") || "";
				const leftHeadingAnchor = leftHeadingEl?.getAttribute("id") || "";
				const rightHeadingAnchor = rightHeadingEl?.getAttribute("id") || "";
				const leftHeadingAlign = normalizeHeadingAlign(
					getHeadingAlignFromStyle(leftHeadingStyle),
					"left",
				);
				const rightHeadingAlign = normalizeHeadingAlign(
					getHeadingAlignFromStyle(rightHeadingStyle),
					"left",
				);
				let leftHtml = leftNode?.innerHTML || "";
				if (leftHeadingEl && leftNode) {
					const clone = leftNode.cloneNode(true);
					const removeHeading = clone.querySelector("h1,h2,h3");
					if (removeHeading) removeHeading.remove();
					leftHtml = clone.innerHTML || "";
				}
				let rightHtml = rightNode?.innerHTML || "";
				if (rightHeadingEl && rightNode) {
					const clone = rightNode.cloneNode(true);
					const removeHeading = clone.querySelector("h1,h2,h3");
					if (removeHeading) removeHeading.remove();
					rightHtml = clone.innerHTML || "";
				}
				return {
					type: "twoCol",
					cmsId,
					heading: leftHeadingEl?.textContent?.trim() || "",
					headingTag: safeLeftHeadingTag,
					leftHeading: leftHeadingEl?.textContent?.trim() || "",
					leftHeadingTag: safeLeftHeadingTag,
					leftHeadingStyle,
					leftHeadingAlign,
					leftHeadingAnchor,
					rightHeading: rightHeadingEl?.textContent?.trim() || "",
					rightHeadingTag: safeRightHeadingTag,
					rightHeadingStyle,
					rightHeadingAlign,
					rightHeadingAnchor,
					left: leftHtml,
					right: rightHtml,
				};
			}
			if (type === "imgText" || type === "split50") {
				const headingEl = cleanNode.querySelector("h1,h2,h3");
				const headingTag = headingEl ? headingEl.tagName.toLowerCase() : "h2";
				const safeHeadingTag = headingTag === "h1" ? "h2" : headingTag;
				const headingStyle = headingEl?.getAttribute("style") || "";
				const headingAnchor = headingEl?.getAttribute("id") || "";
				const headingAlign = normalizeHeadingAlign(
					getHeadingAlignFromStyle(headingStyle),
					"left",
				);
				const video = cleanNode.getAttribute("data-video") || "";
				const hasVideo = Boolean(video);
				const overlayEnabled =
					!hasVideo && cleanNode.getAttribute("data-overlay") !== "false";
				let body = cleanNode.innerHTML || "";
				if (headingEl) {
					const clone = cleanNode.cloneNode(true);
					const removeHeading = clone.querySelector("h1,h2,h3");
					if (removeHeading) removeHeading.remove();
					body = clone.innerHTML || "";
				}
				return {
					type,
					cmsId,
					imgPos: cleanNode.getAttribute("data-img-pos") || "left",
					img: hasVideo ? "" : cleanNode.getAttribute("data-img") || "",
					video,
					caption: cleanNode.getAttribute("data-caption") || "",
					lightbox: hasVideo
						? "false"
						: cleanNode.getAttribute("data-lightbox") || "false",
					overlayEnabled,
					overlayTitle: hasVideo
						? ""
						: cleanNode.getAttribute("data-overlay-title") || "",
					overlayText: hasVideo
						? ""
						: cleanNode.getAttribute("data-overlay-text") || "",
					heading: headingEl?.textContent?.trim() || "",
					headingTag: safeHeadingTag,
					headingStyle,
					headingAlign,
					headingAnchor,
					body,
				};
			}
			return { type: "legacy", cmsId, raw: cleanNode.outerHTML };
		}

		if (cls.contains("portfolio-grid")) {
			return parsePortfolioGridNode(cleanNode);
		}

		if (cls.contains("grid-wrapper") && cls.contains("grid-wrapper--row")) {
			if (cleanNode.querySelector(".content.box.box-img")) {
				const cards = Array.from(
					cleanNode.querySelectorAll(".content.box.box-img"),
				).map((card) => {
					const img = card.querySelector("img");
					const title = card.querySelector(".content-title");
					const text = card.querySelector(".content-text");
					return {
						src: img?.getAttribute("src") || "",
						alt: img?.getAttribute("alt") || "",
						lightbox: img?.classList.contains("js-lightbox") || false,
						overlayTitle: title?.textContent?.trim() || "",
						overlayText: text?.textContent?.trim() || "",
					};
				});
				return { type: "hoverCardRow", cmsId, cards };
			}
			if (cleanNode.querySelector(".box > img")) {
				const items = Array.from(cleanNode.querySelectorAll(".box > img")).map(
					(img) => ({
						src: img.getAttribute("src") || "",
						alt: img.getAttribute("alt") || "",
						lightbox: img.classList.contains("js-lightbox") || false,
					}),
				);
				return { type: "squareGridRow", cmsId, items };
			}
		}

		if (cls.contains("flex-accordion-wrapper")) {
			const box = cleanNode.querySelector(".flex-accordion-box") || cleanNode;
			const titleEl = box.querySelector("h1,h2,h3");
			const titleTag = titleEl ? titleEl.tagName.toLowerCase() : "h2";
			const safeTitleTag = titleTag === "h1" ? "h2" : titleTag;
			const titleAnchor = titleEl?.getAttribute("id") || "";
			const introParts = [];
			let reachedTabs = false;
			Array.from(box.children).forEach((child) => {
				if (reachedTabs) return;
				if (child.classList?.contains("tab")) {
					reachedTabs = true;
					return;
				}
				if (titleEl && child === titleEl) return;
				introParts.push(child.outerHTML || "");
			});
			const intro = introParts.join("\n").trim();
			const items = Array.from(box.querySelectorAll(".tab")).map((tab) => {
				const label =
					tab.querySelector(".tab-label")?.textContent?.trim() || "";
				const body = tab.querySelector(".tab-content")?.innerHTML || "";
				return { label, body };
			});
			return {
				type: "styledAccordion",
				cmsId,
				title: titleEl?.textContent?.trim() || "",
				titleTag: safeTitleTag,
				titleStyle: titleEl?.getAttribute("style") || "",
				titleAnchor,
				titleAlign: normalizeHeadingAlign(
					getHeadingAlignFromStyle(titleEl?.getAttribute("style") || ""),
					"left",
				),
				intro,
				items,
			};
		}

		if (cls.contains("div-wrapper")) {
			const inner = cleanNode.querySelector(".default-div-wrapper");
			if (inner && !inner.classList.contains("hero-override")) {
				const headingEl = inner.querySelector("h1,h2,h3");
				const headingTag = headingEl ? headingEl.tagName.toLowerCase() : "h2";
				const headingStyle = headingEl?.getAttribute("style") || "";
				const headingAnchor = headingEl?.getAttribute("id") || "";
				const clone = inner.cloneNode(true);
				const removeHeading = clone.querySelector("h1,h2,h3");
				if (removeHeading) removeHeading.remove();
				const wrapper = clone.querySelector(".std-container-text");
				const body = wrapper ? wrapper.innerHTML || "" : clone.innerHTML || "";
				return {
					type: "stdContainer",
					cmsId,
					heading: headingEl?.textContent?.trim() || "",
					headingTag,
					headingStyle,
					headingAlign: normalizeHeadingAlign(
						getHeadingAlignFromStyle(headingStyle),
						"left",
					),
					headingAnchor,
					body,
				};
			}
		}

		return { type: "legacy", cmsId, raw: cleanNode.outerHTML };
	}

	function parseMainBlocksFromHtml(mainHtml) {
		const doc = new DOMParser().parseFromString(
			`<div id="__wrap__">${String(mainHtml || "")}</div>`,
			"text/html",
		);
		const wrap = doc.querySelector("#__wrap__");
		const nodes = wrap ? Array.from(wrap.children) : [];
		const occMap = new Map();
		const usedIds = new Set();
		return nodes.map((node, idx) => {
			const sig = signatureForHtml(node?.outerHTML || "");
			const occ = sig ? occMap.get(sig) || 0 : 0;
			if (sig) occMap.set(sig, occ + 1);
			const existingId = node?.getAttribute("data-cms-id") || "";
			const cmsId = ensureUniqueCmsId({
				existingId,
				sig,
				occ,
				fallback: node?.outerHTML || String(idx),
				usedIds,
			});
			if (cmsId && existingId !== cmsId) {
				node.setAttribute("data-cms-id", cmsId);
			}
			const parsed = parseMainBlockNode(node);
			return {
				...parsed,
				cmsId,
			};
		});
	}

	function getBlockCmsId(block, idx, ctx) {
		if (block?.cmsId) return block.cmsId;
		if (block?.baseId) return block.baseId;
		if (block?.id) return block.id;
		const sig = ctx?.sig || signatureForHtml(block?.raw || block?.html || "");
		const occ = Number.isInteger(ctx?.occ)
			? ctx.occ
			: Number.isInteger(block?.occ)
				? block.occ
				: idx;
		if (ctx?.blockId) return ctx.blockId;
		return makeCmsIdFromSig(sig, occ, block?.raw || block?.html || String(idx));
	}

	function serializeSectionStub(block, ctx) {
		const cmsId = getBlockCmsId(block, ctx?.index ?? 0, ctx);
		const type = block.type;
		const attrs = {
			class: "section",
			"data-cms-id": cmsId,
			"data-type": type,
		};
		const hasVideo = Boolean(block.video);
		if (block.imgPos && block.imgPos !== "left") {
			attrs["data-img-pos"] = block.imgPos;
		}
		if (hasVideo) {
			attrs["data-video"] = block.video;
		} else if (block.img) {
			attrs["data-img"] = block.img;
		}
		if (block.caption) attrs["data-caption"] = block.caption;
		if (!hasVideo) {
			attrs["data-lightbox"] = normalizeBool(block.lightbox, "false");
			if (block.overlayEnabled === false) attrs["data-overlay"] = "false";
			if (block.overlayTitle) attrs["data-overlay-title"] = block.overlayTitle;
		}
		let overlayText = block.overlayText || "";
		if (
			!hasVideo &&
			!block.overlayTitle &&
			!overlayText &&
			block.overlayEnabled !== false
		) {
			overlayText =
				normalizeBool(block.lightbox, "false") === "true"
					? "Click to view"
					: "";
		}
		if (!hasVideo && overlayText) attrs["data-overlay-text"] = overlayText;
		const order = [
			"class",
			"data-cms-id",
			"data-type",
			"data-img-pos",
			"data-video",
			"data-img",
			"data-caption",
			"data-lightbox",
			"data-overlay",
			"data-overlay-title",
			"data-overlay-text",
		];
		const headingText = (block.heading || "").trim();
		const headingTag = (block.headingTag || "h2").toLowerCase();
		const headingHtml = headingText
			? buildHeadingHtml({
					tag: headingTag,
					text: headingText,
					align: block.headingAlign,
					style: block.headingStyle,
					anchor: block.headingAnchor,
				})
			: "";
		const body = sanitizeRteHtml(block.body || "", ctx);
		const content = headingHtml
			? [headingHtml, body].filter(Boolean).join("\n")
			: body;
		const lines = [`<div${serializeAttrsOrdered(attrs, order)}>`];
		if (content) lines.push(indentLines(content, 1));
		lines.push(`</div>`);
		return lines.join("\n");
	}

	function serializeTwoCol(block, ctx) {
		const cmsId = getBlockCmsId(block, ctx?.index ?? 0, ctx);
		const leftHeadingText = (block.leftHeading || block.heading || "").trim();
		const rightHeadingText = (block.rightHeading || "").trim();
		const leftHeadingTag = (
			block.leftHeadingTag ||
			block.headingTag ||
			"h2"
		).toLowerCase();
		const rightHeadingTag = (
			block.rightHeadingTag ||
			block.headingTag ||
			"h2"
		).toLowerCase();
		const leftHeadingHtml = leftHeadingText
			? buildHeadingHtml({
					tag: leftHeadingTag,
					text: leftHeadingText,
					align: block.leftHeadingAlign,
					style: block.leftHeadingStyle,
					anchor: block.leftHeadingAnchor,
				})
			: "";
		const rightHeadingHtml = rightHeadingText
			? buildHeadingHtml({
					tag: rightHeadingTag,
					text: rightHeadingText,
					align: block.rightHeadingAlign,
					style: block.rightHeadingStyle,
					anchor: block.rightHeadingAnchor,
				})
			: "";
		const left = sanitizeRteHtml(block.left || "", ctx);
		const right = sanitizeRteHtml(block.right || "", ctx);
		const lines = [
			`<div class="section" data-cms-id="${escapeAttr(
				cmsId,
			)}" data-type="twoCol">`,
			`\t<div data-col="left">`,
			leftHeadingHtml ? `\t\t${leftHeadingHtml}` : "",
			left ? indentLines(left, 2) : "",
			`\t</div>`,
			`\t<div data-col="right">`,
			rightHeadingHtml ? `\t\t${rightHeadingHtml}` : "",
			right ? indentLines(right, 2) : "",
			`\t</div>`,
			`</div>`,
		].filter((line) => line !== "");
		return lines.join("\n");
	}

	function serializeStdContainer(block, ctx) {
		const cmsId = getBlockCmsId(block, ctx?.index ?? 0, ctx);
		const headingText = String(block.heading || "").trim();
		const headingTag = (block.headingTag || "h2").toLowerCase();
		const headingHtml = headingText
			? buildHeadingHtml({
					tag: headingTag,
					text: headingText,
					align: block.headingAlign,
					style: block.headingStyle,
					anchor: block.headingAnchor,
				})
			: "";
		const body = sanitizeRteHtml(block.body || "", ctx);
		const content = [headingHtml, body].filter(Boolean).join("\n");
		const lines = [
			`<div class="div-wrapper" data-cms-id="${escapeAttr(cmsId)}">`,
			`\t<div class="default-div-wrapper">`,
		];
		if (content) {
			lines.push(`\t\t<div class="std-container-text">`);
			lines.push(indentLines(content, 3));
			lines.push(`\t\t</div>`);
		}
		lines.push(`\t</div>`, `</div>`);
		return lines.join("\n");
	}

	function serializeHoverCardRow(block, ctx) {
		const cmsId = getBlockCmsId(block, ctx?.index ?? 0, ctx);
		const lines = [
			`<div class="grid-wrapper grid-wrapper--row" data-cms-id="${escapeAttr(
				cmsId,
			)}">`,
		];
		(block.cards || []).forEach((card) => {
			const imgClass = card.lightbox
				? "content-image js-lightbox"
				: "content-image";
			lines.push(
				`\t<div class="content box box-img">`,
				`\t\t<div class="content-overlay"></div>`,
				`\t\t<img class="${imgClass}" src="${escapeAttr(
					card.src,
				)}" alt="${escapeAttr(card.alt)}" />`,
				`\t\t<div class="content-details fadeIn-bottom">`,
				`\t\t\t<h3 class="content-title">${escapeHtml(
					card.overlayTitle || "",
				)}</h3>`,
				`\t\t\t<p class="content-text">${escapeHtml(
					card.overlayText || "",
				)}</p>`,
				`\t\t</div>`,
				`\t</div>`,
			);
		});
		lines.push(`</div>`);
		return lines.join("\n");
	}

	function serializeSquareGridRow(block, ctx) {
		const cmsId = getBlockCmsId(block, ctx?.index ?? 0, ctx);
		const lines = [
			`<div class="grid-wrapper grid-wrapper--row" data-cms-id="${escapeAttr(
				cmsId,
			)}">`,
		];
		(block.items || []).forEach((item) => {
			const imgClass = item.lightbox ? "js-lightbox" : "";
			const classAttr = imgClass ? ` class="${imgClass}"` : "";
			lines.push(
				`\t<div class="box">`,
				`\t\t<img${classAttr} src="${escapeAttr(
					item.src,
				)}" alt="${escapeAttr(item.alt)}" />`,
				`\t</div>`,
			);
		});
		lines.push(`</div>`);
		return lines.join("\n");
	}

	function formatPortfolioSummaryHtml(summary, ctx) {
		const raw = String(summary || "").replace(/\r\n/g, "\n").trim();
		if (!raw) return "";
		if (/<[a-z][\s\S]*>/i.test(raw)) {
			return sanitizeRteHtml(raw, ctx);
		}
		const parts = raw
			.split(/\n{2,}/)
			.map((part) => part.trim())
			.filter(Boolean);
		if (!parts.length) return "";
		return parts
			.map((part) => `<p>${escapeHtml(part).replace(/\n/g, "<br />")}</p>`)
			.join("\n");
	}

	function serializePortfolioGrid(block, ctx) {
		const cmsId = getBlockCmsId(block, ctx?.index ?? 0, ctx);
		const normalized = normalizePortfolioGrid(block);
		const types = Array.from(
			new Set(
				normalized.cards
					.map((card) => normalizePortfolioTypeLabel(card.type))
					.filter(Boolean),
			),
		).sort((a, b) => a.localeCompare(b));
	const tags = Array.from(
		new Set(
			normalized.cards
				.flatMap((card) => card.tags || [])
				.map((tag) => String(tag || "").trim())
				.filter(Boolean),
		),
	).sort((a, b) => a.localeCompare(b));
	const linkOrder = ["site", "github", "youtube", "facebook", "gallery"];
	const linkFilters = linkOrder.filter((key) =>
		normalized.cards.some((card) => {
			if (key === "gallery") return Boolean(card.gallery?.length);
			return Boolean(card.links?.[key]);
		}),
	);

	const typeColorMap = {
		work: "#2563eb",
		academic: "#dc2626",
		personal: "#16a34a",
	};
	const hashPortfolioKey = (value) => {
		const text = String(value || "");
		let hash = 0;
		for (let i = 0; i < text.length; i += 1) {
			hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
		}
		return hash;
	};
	const getTypeColor = (typeKey) => {
		if (!typeKey) return "";
		if (typeColorMap[typeKey]) return typeColorMap[typeKey];
		const hue = hashPortfolioKey(typeKey) % 360;
		return `hsl(${hue} 70% 42%)`;
	};
	const showLinkFilters =
		Boolean(normalized.showLinkFilters) && Boolean(linkFilters.length);
	const githubSvg =
		'<svg class="portfolio-icon portfolio-icon--github" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 0.3c-6.6 0-12 5.4-12 12 0 5.3 3.4 9.8 8.2 11.4 0.6 0.1 0.8-0.3 0.8-0.6v-2.2c-3.3 0.7-4-1.4-4-1.4-0.5-1.3-1.2-1.7-1.2-1.7-1-0.7 0.1-0.7 0.1-0.7 1.1 0.1 1.7 1.2 1.7 1.2 1 1.7 2.6 1.2 3.2 0.9 0.1-0.7 0.4-1.2 0.7-1.5-2.6-0.3-5.4-1.3-5.4-5.9 0-1.3 0.5-2.4 1.2-3.2-0.1-0.3-0.5-1.5 0.1-3.1 0 0 1-0.3 3.3 1.2 1-0.3 2-0.4 3-0.4s2.1 0.1 3 0.4c2.3-1.5 3.3-1.2 3.3-1.2 0.6 1.6 0.2 2.8 0.1 3.1 0.8 0.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.4 5.9 0.4 0.4 0.8 1 0.8 2v3c0 0.3 0.2 0.7 0.8 0.6 4.8-1.6 8.2-6.1 8.2-11.4 0-6.6-5.4-12-12-12z"/></svg>';

	const attrs = {
		class: "portfolio-grid",
		"data-cms-id": cmsId,
		"data-max-visible": String(normalized.maxVisible || 0),
		"data-show-search": normalized.showSearch ? "true" : "false",
		"data-show-types": normalized.showTypeFilters ? "true" : "false",
		"data-show-tags": normalized.showTagFilters ? "true" : "false",
		"data-show-links": normalized.showLinkFilters ? "true" : "false",
	};
	const order = [
		"class",
		"data-cms-id",
		"data-max-visible",
		"data-show-search",
		"data-show-types",
		"data-show-tags",
		"data-show-links",
	];
	const lines = [`<div${serializeAttrsOrdered(attrs, order)}>`];
	const hasControls =
		normalized.showSearch || normalized.showTypeFilters || normalized.showTagFilters;

		if (normalized.title) {
			const titleAlign = normalized.titleAlign || "";
			const alignValue = normalizeHeadingAlign(titleAlign, "center");
			const alignStyle = titleAlign
				? alignValue === "left"
					? "text-align: left;"
					: "text-align: center;"
				: "";
			const headingHtml = buildHeadingHtml({
				tag: "h2",
				text: normalized.title,
				align: titleAlign,
				style: alignStyle,
				anchor: normalized.titleAnchor,
			});
			lines.push(`\t<div class="portfolio-grid__header">`);
			if (headingHtml) lines.push(`\t\t${headingHtml}`);
			lines.push(`\t</div>`);
		}
		if (normalized.intro) {
			const introHtml = /<[a-z][\s\S]*>/i.test(normalized.intro)
				? sanitizeRteHtml(normalized.intro, ctx)
				: `<p>${escapeHtml(normalized.intro)}</p>`;
			lines.push(`\t<div class="portfolio-grid__intro">`);
			if (introHtml) lines.push(indentLines(introHtml, 2));
			lines.push(`\t</div>`);
		}
		if (normalized.title || normalized.intro) {
			lines.push(`\t<div class="portfolio-grid__divider"></div>`);
		}

		if (hasControls) {
			lines.push(`\t<div class="portfolio-grid__controls">`);
			if (normalized.showSearch) {
				lines.push(
					`\t\t<div class="portfolio-grid__search">`,
					`\t\t\t<input type="search" class="portfolio-grid__search-input" placeholder="Search projects" aria-label="Search projects" />`,
					`\t\t</div>`,
				);
			}
			lines.push(`\t</div>`);
		}

		const hasFilters =
			(normalized.showTypeFilters && types.length) ||
			(normalized.showTagFilters && tags.length) ||
			showLinkFilters;

		if (hasFilters) {
			lines.push(`\t<div class="portfolio-grid__filters">`);
			lines.push(`\t\t<div class="portfolio-grid__filters-title">Filters</div>`);
			if (normalized.showTypeFilters && types.length) {
				lines.push(
					`\t\t<div class="portfolio-grid__filter-row" data-filter-row="type">`,
					`\t\t\t<div class="portfolio-grid__filter-label">Categories</div>`,
					`\t\t\t<div class="portfolio-grid__filter-group" data-filter="type">`,
					`\t\t\t\t<button type="button" class="portfolio-filter-pill is-active" data-type="">All</button>`,
				);
				types.forEach((type) => {
					lines.push(
						`\t\t\t\t<button type="button" class="portfolio-filter-pill" data-type="${escapeAttr(
							type,
						)}">${escapeHtml(type)}</button>`,
					);
				});
				lines.push(`\t\t\t</div>`, `\t\t</div>`);
			}
			if (normalized.showTagFilters && tags.length) {
				lines.push(
					`\t\t<div class="portfolio-grid__filter-row" data-filter-row="tag">`,
					`\t\t\t<div class="portfolio-grid__filter-label">Skills</div>`,
					`\t\t\t<div class="portfolio-grid__filter-group" data-filter="tag">`,
				);
				tags.forEach((tag) => {
					lines.push(
						`\t\t\t\t<button type="button" class="portfolio-filter-pill" data-tag="${escapeAttr(
							tag,
						)}">${escapeHtml(tag)}</button>`,
					);
				});
				lines.push(`\t\t\t</div>`, `\t\t</div>`);
			}
			if (showLinkFilters) {
				const linkIconMap = {
					site: { icon: "link", label: "Website" },
					github: { icon: "github", label: "GitHub" },
					youtube: { icon: "smart_display", label: "YouTube" },
					facebook: { icon: "chat_bubble", label: "Message" },
					gallery: { icon: "collections", label: "Gallery" },
				};
				lines.push(
					`\t\t<div class="portfolio-grid__filter-row" data-filter-row="link">`,
					`\t\t\t<div class="portfolio-grid__filter-label">Links</div>`,
					`\t\t\t<div class="portfolio-grid__filter-group" data-filter="link">`,
				);
				linkFilters.forEach((key) => {
					const meta = linkIconMap[key];
					if (!meta) return;
					const iconMarkup =
						meta.icon === "github"
							? githubSvg
							: `<span class="material-icons" aria-hidden="true">${meta.icon}</span>`;
					lines.push(
						`\t\t\t\t<button type="button" class="portfolio-filter-icon portfolio-filter-icon--${escapeAttr(
							key,
						)}" data-link="${escapeAttr(
							key,
						)}" data-tooltip="${escapeAttr(
							meta.label,
						)}" aria-label="${escapeAttr(meta.label)}">`,
						`\t\t\t\t\t${iconMarkup}`,
						`\t\t\t\t</button>`,
					);
				});
				lines.push(`\t\t\t</div>`, `\t\t</div>`);
			}
			lines.push(`\t</div>`);
		}

		lines.push(`\t<div class="portfolio-grid__cards">`);
		normalized.cards.forEach((card) => {
			const typeLabel = normalizePortfolioTypeLabel(card.type);
			const typeKey = normalizePortfolioTypeKey(typeLabel);
			const tagsValue = (card.tags || []).join(", ");
			const galleryValue = (card.gallery || []).join(",");
			const typeColor = getTypeColor(typeKey);
			const cardAttrs = {
				class: "portfolio-card",
				"data-type": typeKey,
				"data-type-label": typeLabel,
				"data-tags": tagsValue,
				"data-start": card.start || "",
				"data-end": card.end || "",
				"data-gallery": galleryValue,
				style: typeColor ? `--portfolio-type-bg:${typeColor};` : "",
			};
			const cardOrder = [
				"class",
				"data-type",
				"data-type-label",
				"data-tags",
				"data-start",
				"data-end",
				"data-gallery",
				"style",
			];
			const dateText = (() => {
				const start = card.start || "";
				const end = card.end || "";
				if (start && end && start !== end) return `${start} - ${end}`;
				return start || end;
			})();
			const summaryHtml = formatPortfolioSummaryHtml(card.summary, ctx);
			const hasSummary = Boolean(summaryHtml);
			const hasTags = Boolean(card.tags?.length);
			lines.push(
				`\t\t<article${serializeAttrsOrdered(cardAttrs, cardOrder)}>`,
				`\t\t\t<div class="portfolio-card__head">`,
				`\t\t\t\t<div>`,
				`\t\t\t\t\t<div class="portfolio-card__title">${escapeHtml(
					card.title || "",
				)}</div>`,
				`\t\t\t\t\t<div class="portfolio-card__date">${escapeHtml(
					dateText || "",
				)}</div>`,
				`\t\t\t\t</div>`,
				`\t\t\t\t<div class="portfolio-card__icons">`,
			);
			const iconMap = {
				site: { icon: "link", label: "Website" },
				github: { icon: "github", label: "GitHub" },
				youtube: { icon: "smart_display", label: "YouTube" },
				facebook: { icon: "chat_bubble", label: "Message" },
			};
			Object.entries(iconMap).forEach(([key, meta]) => {
				const href = card.links?.[key] || "";
				if (!href) return;
				const iconMarkup =
					meta.icon === "github"
						? githubSvg
						: `<span class="material-icons" aria-hidden="true">${meta.icon}</span>`;
				lines.push(
					`\t\t\t\t\t<a class="portfolio-card__icon portfolio-card__icon--${escapeAttr(
						key,
					)}" href="${escapeAttr(
						href,
					)}" target="_blank" rel="noopener noreferrer" data-link="${escapeAttr(
						key,
					)}" data-tooltip="${escapeAttr(meta.label)}" aria-label="${escapeAttr(
						meta.label,
					)}">`,
					`\t\t\t\t\t\t${iconMarkup}`,
					`\t\t\t\t\t</a>`,
				);
			});
			if (card.gallery?.length) {
				lines.push(
					`\t\t\t\t\t<button type="button" class="portfolio-card__icon portfolio-card__icon--gallery" data-link="gallery" data-tooltip="Gallery" aria-label="Gallery">`,
					`\t\t\t\t\t\t<span class="material-icons" aria-hidden="true">collections</span>`,
					`\t\t\t\t\t</button>`,
				);
			}
			lines.push(
				`\t\t\t\t</div>`,
				`\t\t\t</div>`,
				`\t\t\t<div class="portfolio-card__type">${escapeHtml(
					typeLabel || "",
				)}</div>`,
			);
			if (hasSummary) {
				lines.push(`\t\t\t<div class="portfolio-card__divider"></div>`);
				lines.push(`\t\t\t<div class="portfolio-card__summary">`);
				lines.push(indentLines(summaryHtml, 4));
				lines.push(`\t\t\t</div>`);
			}
			if (hasTags) {
				if (hasSummary || typeLabel)
					lines.push(`\t\t\t<div class="portfolio-card__divider"></div>`);
				lines.push(`\t\t\t<div class="portfolio-card__tags">`);
				card.tags.forEach((tag) => {
					lines.push(
						`\t\t\t\t<button type="button" class="portfolio-card__tag" data-tag="${escapeAttr(
							tag,
						)}">${escapeHtml(tag)}</button>`,
					);
				});
				lines.push(`\t\t\t</div>`);
			}
			lines.push(`\t\t</article>`);
		});
		lines.push(`\t</div>`);

		const jsonPayload = {
			version: 1,
			title: normalized.title || "",
			titleAnchor: normalized.titleAnchor || "",
			titleAlign: normalized.titleAlign || "",
			intro: normalized.intro || "",
			maxVisible: normalized.maxVisible,
			showSearch: normalized.showSearch,
			showTypeFilters: normalized.showTypeFilters,
			showTagFilters: normalized.showTagFilters,
			showLinkFilters: normalized.showLinkFilters,
			cards: normalized.cards.map((card) => ({
				title: card.title || "",
				type: card.type || "",
				start: card.start || "",
				end: card.end || "",
				summary: card.summary || "",
				tags: card.tags || [],
				links: card.links || {},
				gallery: card.gallery || [],
			})),
		};
		const jsonText = JSON.stringify(jsonPayload, null, 2).replace(
			/<\/script>/gi,
			"<\\/script>",
		);
		lines.push(
			`\t<script type="application/json" class="portfolio-grid__data" data-cms="portfolio">`,
			indentLines(jsonText, 2),
			`\t</script>`,
		);
		lines.push(`</div>`);
		const open = lines[0];
		const close = lines[lines.length - 1];
		const inner = lines.slice(1, -1).join("\n");
		const wrapped = [open, `\t<div class="std-container-text">`];
		if (inner) wrapped.push(indentLines(inner, 1));
		wrapped.push(`\t</div>`, close);
		return wrapped.join("\n");
	}

	function serializeStyledAccordion(block, ctx) {
		const cmsId = getBlockCmsId(block, ctx?.index ?? 0, ctx);
		const titleText = String(block.title || "").trim();
		const titleTag = (block.titleTag || "h2").toLowerCase();
		const safeTitleTag = titleTag === "h1" ? "h2" : titleTag;
		const titleHtml = titleText
			? buildHeadingHtml({
					tag: safeTitleTag,
					text: titleText,
					align: block.titleAlign,
					style: block.titleStyle,
					anchor: block.titleAnchor,
				})
			: "";
		const introRaw = String(block.intro || "").trim();
		const pageHash = ctx?.pageHash || hashText(ctx?.path || "");
		const blockShort = ctx?.blockIdShort || hashText(ctx?.blockId || "block");
		const items = Array.isArray(block.items) ? block.items : [];
		const lines = [
			`<div class="flex-accordion-wrapper" data-cms-id="${escapeAttr(cmsId)}">`,
			`\t<div class="flex-accordion-box">`,
		];
		if (titleHtml) lines.push(`\t\t${titleHtml}`);
		if (introRaw) {
			const introHtml = /<[a-z][\s\S]*>/i.test(introRaw)
				? sanitizeRteHtml(introRaw, ctx)
				: `<p>${escapeHtml(introRaw)}</p>`;
			if (introHtml) lines.push(indentLines(introHtml, 2));
		}
		items.forEach((item, idx) => {
			const id = `acc-${pageHash}-${blockShort}-${idx + 1}`;
			const labelText = String(item?.label || "").trim() || `Item ${idx + 1}`;
			const body = sanitizeRteHtml(item?.body || "", ctx);
			lines.push(
				`\t\t<div class="tab">`,
				`\t\t\t<input type="checkbox" id="${escapeAttr(id)}" />`,
				`\t\t\t<label class="tab-label" for="${escapeAttr(id)}">${escapeHtml(
					labelText,
				)}</label>`,
				`\t\t\t<div class="tab-content">`,
				body ? indentLines(body, 3) : "",
				`\t\t\t</div>`,
				`\t\t</div>`,
			);
		});
		lines.push(`\t</div>`, `</div>`);
		return lines.filter(Boolean).join("\n");
	}

	function serializeMainBlocks(blocks, ctx) {
		const list = blocks || [];
		const occMap = new Map();
		const usedIds = new Set();
		return list
			.map((block, idx) => {
				const sig =
					signatureForHtml(block?.raw || block?.html || "") ||
					hashText(JSON.stringify(block || {}));
				const occ = sig ? occMap.get(sig) || 0 : 0;
				if (sig) occMap.set(sig, occ + 1);
				const stableId = ensureUniqueCmsId({
					existingId: block?.baseId || block?.id || block?.cmsId || "",
					sig,
					occ,
					fallback: block?.raw || block?.html || String(idx),
					usedIds,
				});
				const blockCtx = {
					...ctx,
					index: idx,
					sig,
					occ,
					blockId: stableId,
					blockIdShort: hashText(String(stableId || "block")).slice(0, 4),
				};
				if (block.type === "twoCol") return serializeTwoCol(block, blockCtx);
				if (block.type === "stdContainer")
					return serializeStdContainer(block, blockCtx);
				if (block.type === "imgText" || block.type === "split50")
					return serializeSectionStub(block, blockCtx);
				if (block.type === "hoverCardRow")
					return serializeHoverCardRow(block, blockCtx);
				if (block.type === "squareGridRow")
					return serializeSquareGridRow(block, blockCtx);
				if (block.type === "portfolioGrid")
					return serializePortfolioGrid(block, blockCtx);
				if (block.type === "styledAccordion")
					return serializeStyledAccordion(block, blockCtx);
				if (block.raw || block.html) {
					try {
						const doc = new DOMParser().parseFromString(
							`<div id="__wrap__">${String(
								block.raw || block.html || "",
							)}</div>`,
							"text/html",
						);
						const node = doc.querySelector("#__wrap__")?.firstElementChild;
						if (node) {
							const existingId = node.getAttribute("data-cms-id") || "";
							const nodeId = ensureUniqueCmsId({
								existingId,
								sig,
								occ,
								fallback: node.outerHTML || String(idx),
								usedIds,
							});
							if (nodeId && existingId !== nodeId) {
								node.setAttribute("data-cms-id", nodeId);
							}
							return node.outerHTML.trim();
						}
					} catch {
						// fall through
					}
				}
				return String(block.raw || block.html || "").trim();
			})
			.filter(Boolean)
			.join("\n\n");
	}

	function parsePageToModel(html, path) {
		const text = String(html || "");
		const hero = extractRegion(text, "hero");
		const main = extractRegion(text, "main");
		const heroModel = hero.found
			? parseHeroInner(hero.inner)
			: { type: "legacy", raw: "" };
		const mainBlocks = main.found ? parseMainBlocksFromHtml(main.inner) : [];
		const baselineRegistry = buildBaselineRegistry(text || "");
		return {
			path,
			hero: heroModel,
			main: mainBlocks,
			baselineRegistry,
			rawHero: hero.found ? hero.inner : "",
			rawMain: main.found ? main.inner : "",
		};
	}

	function serializeModelToCanonicalHtml(model, baseHtml = "") {
		let heroInner = serializeHeroInner(model.hero);
		if (baseHtml) {
			const baseHero = extractRegion(baseHtml, "hero");
			if (baseHero.found) {
				const baseHeroModel = parseHeroInner(baseHero.inner || "");
				const modelHero = model.hero || {};
				const unchanged =
					baseHeroModel.type === "hero" &&
					modelHero.type === "hero" &&
					baseHeroModel.title === modelHero.title &&
					baseHeroModel.subtitle === modelHero.subtitle;
				if (unchanged) heroInner = (baseHero.inner || "").trim();
			}
		}
		const mainInner = serializeMainBlocks(model.main, {
			path: model.path || "",
		});
		let output = baseHtml || model?.sourceHtml || "";
		if (!output) return "";
		output = replaceRegion(output, "hero", heroInner);
		output = replaceRegion(output, "main", mainInner);

		if (baseHtml) {
			const baseOutside = stripOutsideCms(baseHtml);
			const nextOutside = stripOutsideCms(output);
			if (baseOutside !== nextOutside) {
				console.warn("[cms-portal] non-marker content changed");
			}
		}

		const roundTrip = parsePageToModel(output, model.path || "");
		if ((roundTrip.main || []).length !== (model.main || []).length) {
			console.warn("[cms-portal] round-trip block count mismatch");
		}
		return output;
	}

	function normalizeForDirtyCompare(html, path) {
		const model = parsePageToModel(html, path);
		const heroInner = serializeHeroInner(model.hero);
		const mainInner = serializeMainBlocks(model.main, {
			path: model.path || path || "",
		});
		return `${heroInner}\n---\n${mainInner}`;
	}

	function canonicalizeFullHtml(html, path) {
		try {
			const model = parsePageToModel(html, path);
			return serializeModelToCanonicalHtml(model, html);
		} catch (err) {
			console.warn("[cms-portal] canonicalize failed", err);
			return html;
		}
	}

	function ensureModalRoot() {
		let root = qs("#cms-modal");
		if (root) return root;
		root = el("div", { id: "cms-modal", class: "cms-modal" }, [
			el("div", { class: "cms-modal__backdrop", "data-close": "true" }),
			el(
				"div",
				{ class: "cms-modal__panel", role: "dialog", "aria-modal": "true" },
				[
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
				],
			),
		]);
		document.body.appendChild(root);
		return root;
	}

	function openModal({
		title,
		bodyNodes,
		footerNodes,
		pruneAssets = false,
		onClose,
		scrollTarget = null,
	}) {
		const root = ensureModalRoot();
		const scrollTop = document.scrollingElement
			? document.scrollingElement.scrollTop
			: window.scrollY || 0;
		root.dataset.scrollY = String(scrollTop);
		root._scrollTarget =
			scrollTarget instanceof HTMLElement ? scrollTarget : null;
		qs("#cms-modal-title").textContent = title || "Modal";
		const body = qs("#cms-modal-body");
		const footer = qs("#cms-modal-footer");
		body.innerHTML = "";
		footer.innerHTML = "";
		(bodyNodes || []).forEach((n) => body.appendChild(n));
		(footerNodes || []).forEach((n) => footer.appendChild(n));
		root.dataset.pruneAssets = pruneAssets ? "true" : "false";
		root.classList.add("is-open");
		document.documentElement.classList.add("cms-lock");
		document.body.classList.add("cms-lock");

		const closeHandler = typeof onClose === "function" ? onClose : closeModal;
		const closeButtons = Array.from(
			root.querySelectorAll("[data-close='true']"),
		).map((btn) => {
			const clone = btn.cloneNode(true);
			btn.replaceWith(clone);
			return clone;
		});
		closeButtons.forEach((btn) => {
			btn.addEventListener(
				"click",
				() => {
					closeHandler();
				},
				{ once: true },
			);
		});
	}

	function closeModal() {
		const root = qs("#cms-modal");
		if (!root) return;
		const pruneAssets = root.dataset.pruneAssets === "true";
		const scrollY = Number(root.dataset.scrollY);
		const scrollTarget = root._scrollTarget || null;
		root.dataset.pruneAssets = "false";
		root.dataset.scrollY = "";
		root._scrollTarget = null;
		root.classList.remove("is-open");
		document.documentElement.classList.remove("cms-lock");
		document.body.classList.remove("cms-lock");
		if (pruneAssets) pruneUnusedAssetUploads();
		requestAnimationFrame(() => {
			if (scrollTarget && scrollTarget.isConnected) {
				scrollTarget.scrollIntoView({ block: "center", behavior: "smooth" });
				return;
			}
			if (Number.isFinite(scrollY)) {
				const scroller = document.scrollingElement;
				if (scroller) scroller.scrollTop = scrollY;
				else window.scrollTo({ top: scrollY, left: 0, behavior: "auto" });
			}
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
			if (!parsed || typeof parsed !== "object") return {};
			Object.values(parsed).forEach((entry) => {
				entry.localBlocks = normalizeLocalBlocks(entry.localBlocks || []);
			});
			return parsed;
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

	function loadPrState() {
		try {
			const raw = localStorage.getItem(PR_STORAGE_KEY);
			const data = raw ? JSON.parse(raw) : [];
			return Array.isArray(data) ? data : [];
		} catch {
			return [];
		}
	}

	function savePrState() {
		localStorage.setItem(PR_STORAGE_KEY, JSON.stringify(state.prList || []));
	}

	function loadSessionState() {
		try {
			const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
			const data = raw ? JSON.parse(raw) : {};
			return {
				baselines:
					data.baselines && typeof data.baselines === "object"
						? data.baselines
						: {},
				committedByPr:
					data.committedByPr && typeof data.committedByPr === "object"
						? data.committedByPr
						: {},
			};
		} catch {
			return { baselines: {}, committedByPr: {} };
		}
	}

	function saveSessionState() {
		sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(state.session));
	}

	function signatureForHtml(html) {
		return normalizeFragmentHtml(html || "");
	}

	function makeCmsIdFromSig(sig, occ, fallback = "") {
		const token = sig || fallback || String(occ || 0);
		return `cms-${hashText(token)}-${occ || 0}`;
	}

	function ensureUniqueCmsId({ existingId, sig, occ, fallback, usedIds }) {
		let id = existingId || "";
		if (!id || usedIds.has(id)) {
			const base = makeCmsIdFromSig(sig, occ, fallback);
			id = base;
			if (usedIds.has(id)) {
				let n = 1;
				while (usedIds.has(`${base}-${n}`)) n += 1;
				id = `${base}-${n}`;
			}
		}
		usedIds.add(id);
		return id;
	}

	function parseFirstElementFromHtml(html) {
		try {
			const doc = new DOMParser().parseFromString(
				`<div id="__wrap__">${String(html || "")}</div>`,
				"text/html",
			);
			return doc.querySelector("#__wrap__")?.firstElementChild || null;
		} catch {
			return null;
		}
	}

	function buildCmsIdContext(baseHtml, localBlocks) {
		const usedIds = new Set();
		const sigCounts = new Map();
		const bumpSig = (sig) => {
			if (!sig) return;
			sigCounts.set(sig, (sigCounts.get(sig) || 0) + 1);
		};
		const baseBlocks = buildBaseBlocksWithOcc(baseHtml || "");
		baseBlocks.forEach((block) => {
			if (block.id) usedIds.add(block.id);
			if (block.sig) bumpSig(block.sig);
		});
		normalizeLocalBlocks(localBlocks || []).forEach((item) => {
			const node = parseFirstElementFromHtml(item.html || "");
			if (!node) return;
			const id = node.getAttribute("data-cms-id") || "";
			if (id) usedIds.add(id);
			const sig = signatureForHtml(node.outerHTML || "");
			bumpSig(sig);
		});
		return { usedIds, sigCounts };
	}

	function ensureBlockHtmlHasCmsId(html, ctx) {
		const node = parseFirstElementFromHtml(html);
		if (!node) return { html: String(html || ""), cmsId: "" };
		const sig = signatureForHtml(node.outerHTML || "");
		const occ = sig ? ctx.sigCounts.get(sig) || 0 : 0;
		const existingId = node.getAttribute("data-cms-id") || "";
		const cmsId = ensureUniqueCmsId({
			existingId,
			sig,
			occ,
			fallback: node.outerHTML || String(html || ""),
			usedIds: ctx.usedIds,
		});
		if (sig) ctx.sigCounts.set(sig, occ + 1);
		if (cmsId && existingId !== cmsId) node.setAttribute("data-cms-id", cmsId);
		return { html: node.outerHTML, cmsId };
	}

	function buildBaseBlocksWithOcc(baseHtml) {
		const main = extractRegion(baseHtml || "", "main");
		const blocks = main.found ? parseBlocks(main.inner) : [];
		const occMap = new Map();
		const usedIds = new Set();
		return blocks.map((block, idx) => {
			const sig = signatureForHtml(block.html || "");
			const occ = sig ? occMap.get(sig) || 0 : 0;
			if (sig) occMap.set(sig, occ + 1);
			let baseId = "";
			let updatedHtml = block.html || "";
			try {
				const doc = new DOMParser().parseFromString(
					`<div id="__wrap__">${String(block.html || "")}</div>`,
					"text/html",
				);
				const node = doc.querySelector("#__wrap__")?.firstElementChild;
				const existingId = node?.getAttribute("data-cms-id") || "";
				baseId = ensureUniqueCmsId({
					existingId,
					sig,
					occ,
					fallback: block.html,
					usedIds,
				});
				if (node && baseId && existingId !== baseId) {
					node.setAttribute("data-cms-id", baseId);
					updatedHtml = node.outerHTML;
				}
			} catch {
				baseId = "";
			}
			if (!baseId) {
				baseId = ensureUniqueCmsId({
					existingId: "",
					sig,
					occ,
					fallback: block.html || String(idx),
					usedIds,
				});
			}
			return { html: updatedHtml, sig, occ, id: baseId, pos: idx };
		});
	}

	function buildBaselineRegistry(baseHtml) {
		const blocks = buildBaseBlocksWithOcc(baseHtml || "");
		const byId = new Map();
		const order = [];
		blocks.forEach((block) => {
			if (!block.id) return;
			byId.set(block.id, block);
			order.push(block.id);
		});
		return { blocks, byId, order };
	}

	function anchorKey(anchor) {
		if (anchor?.id) return `id:${anchor.id}`;
		if (!anchor?.sig && anchor?.sig !== "") return "";
		return `${anchor.sig}::${anchor.occ ?? 0}`;
	}

	function ensureSessionBaseline(path, baseHtml) {
		if (!path) return;
		const existing = state.session.baselines[path];
		if (Array.isArray(existing) && existing.length) {
			if (typeof existing[0] === "object") return;
			const baseBlocks = buildBaseBlocksWithOcc(baseHtml || "");
			state.session.baselines[path] = existing.map((sig, idx) => {
				const base = baseBlocks[idx];
				return {
					id:
						base?.id ||
						(sig
							? makeCmsIdFromSig(sig, idx, String(idx))
							: makeCmsIdFromSig(String(idx), idx, String(idx))),
					sig: sig || "",
					pos: idx,
				};
			});
			saveSessionState();
			return;
		}
		const main = extractRegion(baseHtml || "", "main");
		const blocks = main.found ? parseBlocks(main.inner) : [];
		const occMap = new Map();
		state.session.baselines[path] = blocks.map((b, idx) => {
			const sig = signatureForHtml(b.html || "");
			const occ = sig ? occMap.get(sig) || 0 : 0;
			if (sig) occMap.set(sig, occ + 1);
			return {
				id: sig
					? makeCmsIdFromSig(sig, occ, b.html || "")
					: makeCmsIdFromSig(String(idx), occ, b.html || ""),
				sig,
				pos: idx,
			};
		});
		saveSessionState();
		state.baselineRegistry[path] = buildBaselineRegistry(baseHtml);
	}

	function addSessionCommitted(prNumber, path, blockList) {
		if (!prNumber || !path || !Array.isArray(blockList) || !blockList.length)
			return;
		const bucket = state.session.committedByPr[prNumber] || {};
		const list = bucket[path] || [];
		blockList.forEach((item) => {
			const sig = signatureForHtml(item?.html || "");
			if (!sig && !item?.baseId) return;
			list.push({
				id: item?.baseId || null,
				sig: sig || null,
				pos: Number.isInteger(item.pos) ? item.pos : null,
			});
		});
		bucket[path] = list;
		state.session.committedByPr[prNumber] = bucket;
		saveSessionState();
	}

	function removeSessionCommitted(prNumber) {
		if (!prNumber) return;
		delete state.session.committedByPr[prNumber];
		saveSessionState();
	}

	function committedMatchesForPath(path) {
		const countsById = new Map();
		const countsBySig = new Map();
		const byPosById = new Map();
		const byPosBySig = new Map();
		Object.values(state.session.committedByPr || {}).forEach((byPath) => {
			const list = byPath?.[path] || [];
			list.forEach((item) => {
				const id = item?.id || null;
				const sig = item?.sig || item;
				if (id) {
					if (Number.isInteger(item?.pos)) {
						const slot = byPosById.get(item.pos) || [];
						slot.push(id);
						byPosById.set(item.pos, slot);
					}
					countsById.set(id, (countsById.get(id) || 0) + 1);
					return;
				}
				if (!sig) return;
				if (Number.isInteger(item?.pos)) {
					const slot = byPosBySig.get(item.pos) || [];
					slot.push(sig);
					byPosBySig.set(item.pos, slot);
				}
				countsBySig.set(sig, (countsBySig.get(sig) || 0) + 1);
			});
		});
		return { countsById, countsBySig, byPosById, byPosBySig };
	}
	function getActivePr() {
		return (state.prList || [])[0] || null;
	}

	function syncActivePrState() {
		const active = getActivePr();
		state.prUrl = active?.url || "";
		state.prNumber = active?.number || null;
	}

	function addPrToState(pr) {
		if (!pr?.url && !pr?.number) return;
		const list = state.prList || [];
		const exists = list.some(
			(item) => item?.number === pr.number || item?.url === pr.url,
		);
		const next = exists
			? list
			: [{ url: pr.url, number: pr.number, createdAt: Date.now() }, ...list];
		state.prList = next;
		savePrState();
		syncActivePrState();
	}

	function removePrFromState(number) {
		const list = state.prList || [];
		state.prList = list.filter((item) => item?.number !== number);
		savePrState();
		syncActivePrState();
		resetPendingBlocksIfNoPr();
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

	function normalizeLocalBlocks(items) {
		if (!Array.isArray(items)) return [];
		return items
			.map((item, idx) => {
				if (typeof item === "string") {
					return {
						id: makeLocalId(),
						html: item,
						pos: null,
						anchor: null,
						placement: "after",
						status: "staged",
						kind: "new",
						action: "insert",
						legacyIdx: idx,
					};
				}
				if (item && typeof item === "object") {
					const action =
						item.action === "remove"
							? "remove"
							: item.action === "mark"
								? "mark"
								: item.action === "reorder"
									? "reorder"
									: "insert";
					const kind = item.kind === "edited" ? "edited" : "new";
					const sourceKey = item.sourceKey || null;
					const allowBaseId =
						action !== "insert" ||
						(kind === "edited" &&
							action === "insert" &&
							typeof sourceKey === "string" &&
							sourceKey.startsWith("id:"));
					return {
						id: item.id || makeLocalId(),
						html: String(item.html || ""),
						pos: Number.isInteger(item.pos) ? item.pos : null,
						anchor: item.anchor || null,
						placement: item.placement === "before" ? "before" : "after",
						status: item.status === "pending" ? "pending" : "staged",
						prNumber: item.prNumber || null,
						kind,
						baseId: allowBaseId ? item.baseId || null : null,
						sourceKey,
						order: Array.isArray(item.order) ? item.order.slice() : null,
						action,
					};
				}
				return null;
			})
			.filter(Boolean);
	}

	function hydrateLocalBlocksWithBaseIds(baseHtml, localBlocks) {
		const items = normalizeLocalBlocks(localBlocks);
		if (!items.length) return items;
		const baseBlocks = buildBaseBlocksWithOcc(baseHtml || "");
		const idBySigOcc = new Map();
		baseBlocks.forEach((block) => {
			if (!block.sig) return;
			idBySigOcc.set(`${block.sig}::${block.occ ?? 0}`, block.id);
		});
		return items.map((item) => {
			const isInsert = item.action === "insert";
			const isEditedInsert =
				isInsert &&
				item.kind === "edited" &&
				typeof item.sourceKey === "string" &&
				item.sourceKey.startsWith("id:");
			let anchor = item.anchor;
			if (anchor?.sig && !anchor.id) {
				const id = idBySigOcc.get(`${anchor.sig}::${anchor.occ ?? 0}`);
				if (id) anchor = { ...anchor, id };
			}
			let baseId = item.baseId;
			if (!baseId && anchor?.id && (isEditedInsert || !isInsert))
				baseId = anchor.id;
			return { ...item, anchor, baseId };
		});
	}

	function getHydratedLocalBlocks(baseHtml, localBlocks, options = {}) {
		const hydrated = hydrateLocalBlocksWithBaseIds(baseHtml, localBlocks);
		if (!options.filtered) return hydrated;
		const filtered = filterLocalBlocksAgainstBase(baseHtml, hydrated);
		return options.pendingOnly ? normalizePendingBlocks(filtered) : filtered;
	}

	function assignAnchorsFromHtml(baseHtml, mergedHtml, localBlocks) {
		const items = normalizeLocalBlocks(localBlocks);
		if (!items.length) return items;
		const main = extractRegion(mergedHtml || "", "main");
		if (!main.found) return items;

		const mergedBlocks = parseBlocks(main.inner);
		const baseBlocks = buildBaseBlocksWithOcc(baseHtml || "");
		const baseById = new Map(baseBlocks.map((b) => [b.id, b]));
		const mergedSigs = mergedBlocks.map((b) => signatureForHtml(b.html || ""));
		const baselineMap = mergedBlocks.map((block) => {
			try {
				const doc = new DOMParser().parseFromString(
					`<div id="__wrap__">${String(block.html || "")}</div>`,
					"text/html",
				);
				const node = doc.querySelector("#__wrap__")?.firstElementChild;
				const cmsId = node?.getAttribute("data-cms-id") || "";
				return cmsId ? baseById.get(cmsId) || null : null;
			} catch {
				return null;
			}
		});

		const localPosBySig = new Map();
		mergedSigs.forEach((sig, idx) => {
			if (baselineMap[idx]) return;
			const list = localPosBySig.get(sig) || [];
			list.push(idx);
			localPosBySig.set(sig, list);
		});

		return items.map((item) => {
			if (item.anchor?.id && !item.anchor?.sig) {
				const match = baseBlocks.find((b) => b.id === item.anchor.id);
				if (match) {
					return {
						...item,
						anchor: {
							...item.anchor,
							sig: match.sig,
							occ: match.occ,
						},
					};
				}
			}
			if (item.anchor?.sig) {
				if (!item.anchor?.id) {
					const match = baseBlocks.find(
						(b) =>
							b.sig === item.anchor.sig &&
							(b.occ ?? 0) === (item.anchor.occ ?? 0),
					);
					if (match?.id) {
						return {
							...item,
							anchor: { ...item.anchor, id: match.id },
						};
					}
				}
				return item;
			}
			const sig = signatureForHtml(item.html || "");
			const list = localPosBySig.get(sig) || [];
			const idx = list.length ? list.shift() : null;
			if (!list.length) localPosBySig.delete(sig);
			let anchor = null;
			let placement = item.placement || "after";
			let pos = item.pos;
			if (idx !== null) {
				pos = idx;
				let nextBaseline = null;
				for (let j = idx; j < baselineMap.length; j += 1) {
					if (baselineMap[j]) {
						nextBaseline = baselineMap[j];
						break;
					}
				}
				if (nextBaseline) {
					anchor = {
						id: nextBaseline.id,
						sig: nextBaseline.sig,
						occ: nextBaseline.occ,
					};
					placement = "before";
				} else {
					let prevBaseline = null;
					for (let j = idx - 1; j >= 0; j -= 1) {
						if (baselineMap[j]) {
							prevBaseline = baselineMap[j];
							break;
						}
					}
					if (prevBaseline) {
						anchor = {
							id: prevBaseline.id,
							sig: prevBaseline.sig,
							occ: prevBaseline.occ,
						};
						placement = "after";
					}
				}
			}
			return { ...item, anchor, placement, pos };
		});
	}

	function applyAnchoredInserts(baseBlocks, localBlocks, options = {}) {
		const respectRemovals = options.respectRemovals !== false;
		const baseOrderOverride = options.baseOrderOverride || null;
		const baseById = new Map(baseBlocks.map((block) => [block.id, block]));
		const beforeMap = new Map();
		const afterMap = new Map();
		const orphans = [];
		const positional = [];
		const removeKeys = new Set();
		const removeBaseIds = new Set();
		const movedBaseIds = new Set();
		const orderIndex = new Map();
		localBlocks.forEach((item, idx) => {
			orderIndex.set(item, idx);
			if (item.action === "insert" && item.kind === "edited") {
				const editedBaseId = item.baseId || null;
				if (editedBaseId) removeBaseIds.add(editedBaseId);
			}
			const key = anchorKey(item.anchor);
			if (respectRemovals && item.action === "remove" && item.baseId) {
				removeBaseIds.add(item.baseId);
			}
			if (respectRemovals && item.action === "remove" && key) {
				removeKeys.add(key);
				return;
			}
			if (item.action === "remove" || item.action === "mark") return;
			if (item.action === "reorder") return;
			if (
				!key &&
				Number.isInteger(item.pos) &&
				item.baseId &&
				item.action === "insert"
			) {
				positional.push(item);
				movedBaseIds.add(item.baseId);
				return;
			}
			if (!key) {
				orphans.push(item);
				return;
			}
			const map = item.placement === "before" ? beforeMap : afterMap;
			const list = map.get(key) || [];
			list.push(item);
			map.set(key, list);
		});
		const sortAnchored = (list) => {
			list.sort((a, b) => {
				const aHas = Number.isInteger(a.pos);
				const bHas = Number.isInteger(b.pos);
				if (aHas && bHas && a.pos !== b.pos) return a.pos - b.pos;
				if (aHas && !bHas) return -1;
				if (!aHas && bHas) return 1;
				return (orderIndex.get(a) || 0) - (orderIndex.get(b) || 0);
			});
		};
		beforeMap.forEach((list) => sortAnchored(list));
		afterMap.forEach((list) => sortAnchored(list));
		let baseOrder = baseBlocks;
		if (Array.isArray(baseOrderOverride) && baseOrderOverride.length) {
			const used = new Set();
			const ordered = [];
			baseOrderOverride.forEach((id) => {
				const block = baseById.get(id);
				if (!block) return;
				ordered.push(block);
				used.add(id);
			});
			baseBlocks.forEach((block) => {
				if (used.has(block.id)) return;
				ordered.push(block);
			});
			baseOrder = ordered;
		}
		if (positional.length) {
			const baseById = new Map(baseBlocks.map((block) => [block.id, block]));
			baseOrder = baseBlocks.filter((block) => !removeBaseIds.has(block.id));
			const sorted = [...positional].sort((a, b) => a.pos - b.pos);
			let inserted = 0;
			sorted.forEach((item) => {
				const baseBlock = baseById.get(item.baseId);
				if (!baseBlock) return;
				const target = Math.max(
					0,
					Math.min(item.pos + inserted, baseOrder.length),
				);
				baseOrder.splice(target, 0, baseBlock);
				inserted += 1;
			});
		}
		const merged = [];
		baseOrder.forEach((block) => {
			const key = anchorKey(block);
			const before = beforeMap.get(key) || [];
			before.forEach((item) => merged.push({ html: item.html, _local: item }));
			const after = afterMap.get(key) || [];
			if (
				removeKeys.has(key) ||
				(removeBaseIds.has(block.id) && !movedBaseIds.has(block.id))
			) {
				after.forEach((item) => merged.push({ html: item.html, _local: item }));
				return;
			}
			merged.push({
				html: block.html,
				_base: true,
				id: block.id,
				sig: block.sig,
				occ: block.occ,
			});
			after.forEach((item) => merged.push({ html: item.html, _local: item }));
		});
		orphans.forEach((item) => merged.push({ html: item.html, _local: item }));
		return merged;
	}

	function normalizeReorderOrderIds(order, baseBlocks) {
		if (!Array.isArray(order) || !order.length) return [];
		const baseIds = new Set(baseBlocks.map((b) => b.id));
		const byHash = new Map();
		baseBlocks.forEach((block) => {
			const sig = block.sig || signatureForHtml(block.html || "");
			const hash = hashText(sig || block.id || "");
			if (!hash) return;
			const list = byHash.get(hash) || [];
			list.push(block.id);
			byHash.set(hash, list);
		});
		const usage = new Map();
		const resolved = [];
		order.forEach((raw) => {
			const key = String(raw || "");
			if (!key) return;
			if (baseIds.has(key)) {
				resolved.push(key);
				return;
			}
			const match = key.match(/^(?:base|cms)-([0-9a-z]+)-\d+$/i);
			const hash = match?.[1] || "";
			if (!hash) return;
			const list = byHash.get(hash) || [];
			const used = usage.get(hash) || 0;
			const pick = list[used];
			if (pick) {
				resolved.push(pick);
				usage.set(hash, used + 1);
			}
		});
		return resolved;
	}

	function buildBaseOrderFromReorders(baseBlocks, localBlocks, explicitOrder) {
		const orderFromLocal = normalizeLocalBlocks(localBlocks || []).find(
			(item) => item.action === "reorder" && Array.isArray(item.order),
		);
		const normalizedOrder = normalizeReorderOrderIds(
			orderFromLocal?.order,
			baseBlocks,
		);
		const baseOrder =
			Array.isArray(explicitOrder) && explicitOrder.length
				? explicitOrder.slice()
				: normalizedOrder.length
					? normalizedOrder.slice()
					: orderFromLocal?.order?.slice() || baseBlocks.map((b) => b.id);
		const baseIds = new Set(baseBlocks.map((b) => b.id));
		const filtered = baseOrder.filter((id) => baseIds.has(id));
		baseBlocks.forEach((block) => {
			if (!filtered.includes(block.id)) filtered.push(block.id);
		});
		if (orderFromLocal?.order) return filtered;
		const reorderItems = normalizeLocalBlocks(localBlocks)
			.filter((item) => item.action === "reorder" && item.baseId)
			.sort((a, b) => {
				if (Number.isInteger(a.pos) && Number.isInteger(b.pos)) {
					return a.pos - b.pos;
				}
				if (Number.isInteger(a.pos)) return -1;
				if (Number.isInteger(b.pos)) return 1;
				return 0;
			});
		reorderItems.forEach((item) => {
			const id = item.baseId;
			if (!id) return;
			const currentIdx = filtered.indexOf(id);
			if (currentIdx >= 0) filtered.splice(currentIdx, 1);
			const target = Number.isInteger(item.pos)
				? Math.max(0, Math.min(item.pos, filtered.length))
				: filtered.length;
			filtered.splice(target, 0, id);
		});
		return filtered;
	}

	function buildMergedRenderBlocks(baseHtml, localBlocks, options = {}) {
		const baseBlocks = buildBaseBlocksWithOcc(baseHtml || "");
		const baseOrderOverride = buildBaseOrderFromReorders(
			baseBlocks,
			localBlocks,
			options.baseOrderOverride,
		);
		if (!localBlocks || !localBlocks.length) {
			return baseBlocks.map((block) => ({
				html: block.html,
				_base: true,
				id: block.id,
				sig: block.sig,
				occ: block.occ,
			}));
		}
		return applyAnchoredInserts(baseBlocks, localBlocks, {
			...options,
			baseOrderOverride,
		});
	}

	function getAnchorForIndex(targetIndex, mergedRender) {
		const anchorFromBlock = (block) => {
			if (block?._base && block.sig) {
				return { id: block.id, sig: block.sig, occ: block.occ };
			}
			const localAnchor = block?._local?.anchor;
			if (localAnchor && (localAnchor.id || localAnchor.sig)) {
				return {
					id: localAnchor.id || null,
					sig: localAnchor.sig || null,
					occ: localAnchor.occ ?? null,
				};
			}
			return null;
		};
		for (let i = targetIndex - 1; i >= 0; i -= 1) {
			const anchor = anchorFromBlock(mergedRender[i]);
			if (anchor) return { anchor, placement: "after" };
		}
		for (let i = targetIndex; i < mergedRender.length; i += 1) {
			const anchor = anchorFromBlock(mergedRender[i]);
			if (anchor) return { anchor, placement: "before" };
		}
		return { anchor: null, placement: "after" };
	}

	function summarizeMergedBlocks(mergedRender, centerIndex, radius = 3) {
		if (!Array.isArray(mergedRender) || mergedRender.length === 0) return [];
		const start = Math.max(0, centerIndex - radius);
		const end = Math.min(mergedRender.length - 1, centerIndex + radius);
		const summary = [];
		for (let i = start; i <= end; i += 1) {
			const block = mergedRender[i];
			summary.push({
				idx: i,
				base: block?._base
					? { id: block.id || null, sig: block.sig || null, occ: block.occ }
					: null,
				local: block?._local
					? {
							id: block._local.id || null,
							action: block._local.action || null,
							placement: block._local.placement || null,
							anchor: block._local.anchor || null,
							pos: Number.isInteger(block._local.pos) ? block._local.pos : null,
						}
					: null,
			});
		}
		return summary;
	}

	function hasRemovalActions(localBlocks) {
		return normalizeLocalBlocks(localBlocks).some(
			(item) => item.action === "remove",
		);
	}

	function hasRemovalOrMarkActions(localBlocks) {
		return normalizeLocalBlocks(localBlocks).some(
			(item) =>
				item.action === "remove" ||
				item.action === "mark" ||
				item.action === "reorder",
		);
	}

	function updateLocalBlocksAndRender(path, updatedLocal) {
		const baseHtml = state.originalHtml || "";
		const entry = state.dirtyPages[path] || {};
		const dirtyHtml = entry?.html ? entry.html : baseHtml;
		const normalizedLocal = normalizeLocalBlocks(updatedLocal);
		const hasLocal = normalizedLocal.length > 0;
		if (!hasLocal) {
			state.lastReorderLocal = null;
			if (entry?.html) {
				const baseHero = extractRegion(baseHtml, "hero");
				const entryHero = extractRegion(entry.html, "hero");
				const baseHeroModel = parseHeroInner(baseHero.inner || "");
				const entryHeroModel = parseHeroInner(entryHero.inner || "");
				const heroChanged =
					baseHero.found &&
					entryHero.found &&
					!heroModelsEqual(baseHeroModel, entryHeroModel);
				if (heroChanged) {
					const heroInner = serializeHeroInner(entryHeroModel);
					const rebased = replaceRegion(baseHtml, "hero", heroInner);
					setDirtyPage(path, rebased, baseHtml, []);
					if (path === state.path) {
						applyHtmlToCurrentPage(rebased);
						renderPageSurface();
					}
					refreshUiStateForDirty();
					return;
				}
			}
			clearDirtyPage(path);
			if (path === state.path) {
				applyHtmlToCurrentPage(baseHtml);
				renderPageSurface();
			}
			refreshUiStateForDirty();
			return;
		}
		const updatedHtml = mergeDirtyWithBase(baseHtml, dirtyHtml, updatedLocal, {
			respectRemovals: hasRemovalActions(updatedLocal),
			path,
		});
		const hasReorder = normalizedLocal.some(
			(item) => item.action === "reorder",
		);
		if (hasReorder) state.lastReorderLocal = normalizedLocal;
		else state.lastReorderLocal = null;
		const isSameAsBase =
			normalizeForDirtyCompare(updatedHtml, path) ===
			normalizeForDirtyCompare(baseHtml, path);
		const onlyReorders =
			hasLocal &&
			normalizedLocal.every(
				(item) => item.action !== "mark" && item.kind !== "new",
			);
		if (isSameAsBase && onlyReorders && !hasReorder) {
			clearDirtyPage(path);
			if (path === state.path) {
				applyHtmlToCurrentPage(baseHtml);
				renderPageSurface();
			}
			refreshUiStateForDirty();
			return;
		}
		const matchesBase =
			normalizeForDirtyCompare(updatedHtml || "", path) ===
			normalizeForDirtyCompare(baseHtml || "", path);
		if (!updatedHtml || (!hasLocal && matchesBase)) {
			clearDirtyPage(path);
		} else {
			const anchoredLocal = assignAnchorsFromHtml(
				baseHtml,
				updatedHtml,
				updatedLocal,
			);
			setDirtyPage(path, updatedHtml, baseHtml, anchoredLocal);
		}
		if (path === state.path) {
			applyHtmlToCurrentPage(updatedHtml || baseHtml);
			if (hasReorder) state.currentDirty = true;
			renderPageSurface();
		}
		refreshUiStateForDirty();
	}

	function normalizePendingBlocks(localBlocks) {
		if ((state.prList || []).length) return localBlocks;
		return normalizeLocalBlocks(localBlocks).map((item) => ({
			...item,
			status: "staged",
			prNumber: null,
		}));
	}

	function resetPendingBlocksIfNoPr() {
		if ((state.prList || []).length) return;
		let changed = false;
		Object.keys(state.dirtyPages || {}).forEach((path) => {
			const entry = state.dirtyPages[path];
			if (!entry) return;
			const normalized = normalizeLocalBlocks(entry.localBlocks || []);
			let localChanged = false;
			const updated = normalized.map((item) => {
				if (item.status !== "pending") return item;
				localChanged = true;
				return { ...item, status: "staged", prNumber: null };
			});
			if (localChanged) {
				entry.localBlocks = updated;
				entry.updatedAt = Date.now();
				changed = true;
			}
		});
		if (changed) saveDirtyPagesToStorage();
	}

	function setDirtyPage(
		path,
		html,
		baseHtmlOverride = "",
		localBlocksOverride,
	) {
		if (!path) return;
		const baseHtml = baseHtmlOverride || state.originalHtml;
		const existing = state.dirtyPages[path] || {};
		const localBlocks =
			localBlocksOverride !== undefined
				? localBlocksOverride
				: existing.localBlocks;
		let normalizedLocal = normalizeLocalBlocks(localBlocks);
		if (html && baseHtml) {
			normalizedLocal = assignAnchorsFromHtml(baseHtml, html, normalizedLocal);
		}
		let canonicalHtml =
			normalizedLocal.length > 0
				? mergeDirtyWithBase(baseHtml || "", html || baseHtml || "", normalizedLocal, {
						respectRemovals: hasRemovalActions(normalizedLocal),
						path,
					})
				: html;
		canonicalHtml = canonicalizeFullHtml(canonicalHtml, path);
		state.dirtyPages[path] = {
			html: canonicalHtml,
			baseHash: hashText(normalizeForDirtyCompare(baseHtml, path)),
			dirtyHash: hashText(normalizeForDirtyCompare(canonicalHtml, path)),
			updatedAt: Date.now(),
			localBlocks: normalizedLocal,
		};
		saveDirtyPagesToStorage();
		pruneUnusedAssetUploads();
	}

	function clearDirtyPage(path) {
		if (!path) return;
		delete state.dirtyPages[path];
		saveDirtyPagesToStorage();
		pruneUnusedAssetUploads();
	}

	function buildDirtyLabel() {
		const count = dirtyCount();
		if (!count) return "CONNECTED - CLEAN";
		return `CONNECTED - DIRTY (${count} page${count === 1 ? "" : "s"})`;
	}

	function buildPrLabel() {
		const prCount = (state.prList || []).length;
		const dirty = dirtyCount();
		const base =
			prCount > 1 ? `PR OPEN (${prCount})` : "PR OPEN (AWAITING MERGE)";
		if (!dirty) return base;
		return `${base} \u2022 DIRTY (${dirty} page${dirty === 1 ? "" : "s"})`;
	}

	function filterLocalBlocksAgainstBase(baseHtml, localBlocks) {
		const items = normalizeLocalBlocks(localBlocks);
		if (!items.length) return [];
		const main = extractRegion(baseHtml, "main");
		if (!main.found) return items;

		const baseBlocks = buildBaseBlocksWithOcc(baseHtml || "");
		const baseById = new Map(baseBlocks.map((b) => [b.id, b]));
		const baseBySigOcc = new Map(
			baseBlocks.map((b) => [`${b.sig}::${b.occ ?? 0}`, b]),
		);
		const baseIds = new Set(baseBlocks.map((b) => b.id).filter(Boolean));
		const baseSigByPos = baseBlocks.map((b) => signatureForHtml(b.html || ""));
		const localsWithPos = items
			.filter((item) => Number.isInteger(item.pos))
			.map((item) => item.pos)
			.sort((a, b) => a - b);
		const dropBaseIds = new Set();
		items.forEach((item) => {
			if (item.action !== "insert" || item.kind !== "edited") return;
			let base =
				(item.baseId && baseById.get(item.baseId)) ||
				(item.anchor?.id && baseById.get(item.anchor.id)) ||
				(item.anchor?.sig &&
					baseBySigOcc.get(`${item.anchor.sig}::${item.anchor.occ ?? 0}`));
			if (!base?.html || !base.id) return;
			const baseSig = signatureForHtml(base.html || "");
			const itemSig = signatureForHtml(item.html || "");
			if (baseSig && itemSig && baseSig === itemSig) {
				dropBaseIds.add(base.id);
			}
		});

		return items.filter((item) => {
			const baseKeyId = item.baseId || item.anchor?.id || "";
			if (
				item.action === "mark" ||
				item.action === "remove" ||
				item.action === "reorder"
			) {
				if (baseKeyId && !baseIds.has(baseKeyId)) return false;
				return !dropBaseIds.has(baseKeyId);
			}
			if (baseKeyId && dropBaseIds.has(baseKeyId)) return false;
			const html = (item.html || "").trim();
			if (!html) return false;
			if (Number.isInteger(item.pos)) {
				const beforeCount = localsWithPos.filter(
					(pos) => pos < item.pos,
				).length;
				const baseIndex = item.pos - beforeCount;
				const baseSigAt = baseSigByPos[baseIndex] || "";
				const itemSig = signatureForHtml(html);
				// Drop any local block that now exactly matches the repo at its mapped position.
				return baseSigAt !== itemSig;
			}
			return true;
		});
	}

	function mergeDirtyWithBase(
		baseHtml,
		dirtyHtml,
		localBlocks = [],
		options = {},
	) {
		const baseMain = extractRegion(baseHtml, "main");
		const dirtyMain = extractRegion(dirtyHtml, "main");
		if (!baseMain.found || !dirtyMain.found) return dirtyHtml;

		const baseBlocks = buildBaseBlocksWithOcc(baseHtml || "");
		const respectRemovals = options.respectRemovals !== false;

		const useLocal = Array.isArray(localBlocks) && localBlocks.length;
		const dirtyOnly = [];
		if (useLocal) {
			localBlocks.forEach((item) => {
				if (!item) return;
				if (item.html) {
					dirtyOnly.push(item);
					return;
				}
				if (
					item.action === "reorder" ||
					item.action === "remove" ||
					item.action === "mark"
				) {
					dirtyOnly.push(item);
				}
			});
			// Ignore dirtyHtml main when localBlocks are present to avoid duplication.
			const hasAnchors =
				dirtyOnly.some((item) => item.anchor && item.anchor.sig) ||
				dirtyOnly.some((item) => item.action === "reorder");
			let mergedBlocks = [];
			const removeBaseIds = new Set(
				dirtyOnly
					.filter((item) => item.action === "remove" && item.baseId)
					.map((item) => item.baseId),
			);
			if (hasAnchors) {
				const baseOrderOverride = buildBaseOrderFromReorders(
					baseBlocks,
					dirtyOnly,
					options.baseOrderOverride,
				);
				mergedBlocks = applyAnchoredInserts(baseBlocks, dirtyOnly, {
					respectRemovals,
					baseOrderOverride,
				});
			} else {
				const withPos = dirtyOnly.filter((item) => Number.isInteger(item.pos));
				const withoutPos = dirtyOnly.filter(
					(item) => !Number.isInteger(item.pos),
				);
				const posMap = new Map();
				withPos.forEach((item) => {
					const list = posMap.get(item.pos) || [];
					list.push(item);
					posMap.set(item.pos, list);
				});
				const slots = baseBlocks.length + withPos.length;
				let baseIndex = 0;
				for (let i = 0; i < slots; i += 1) {
					const localsAt = posMap.get(i);
					if (localsAt && localsAt.length) {
						localsAt.forEach((item) =>
							mergedBlocks.push({ html: item.html, _local: item }),
						);
						continue;
					}
					if (baseIndex < baseBlocks.length) {
						const baseBlock = baseBlocks[baseIndex];
						if (!removeBaseIds.has(baseBlock.id)) {
							mergedBlocks.push({
								html: baseBlock.html,
								_base: true,
								id: baseBlock.id,
								sig: baseBlock.sig,
								occ: baseBlock.occ,
							});
						}
						baseIndex += 1;
					}
				}
				while (baseIndex < baseBlocks.length) {
					const baseBlock = baseBlocks[baseIndex];
					if (!removeBaseIds.has(baseBlock.id)) {
						mergedBlocks.push({
							html: baseBlock.html,
							_base: true,
							id: baseBlock.id,
							sig: baseBlock.sig,
							occ: baseBlock.occ,
						});
					}
					baseIndex += 1;
				}
				withoutPos.forEach((item) => {
					mergedBlocks.push({ html: item.html, _local: item });
				});
			}

			let merged = baseHtml || "";
			const dirtyHero = extractRegion(dirtyHtml, "hero");
			const baseHero = extractRegion(baseHtml, "hero");
			const baseHeroModel = parseHeroInner(baseHero.inner || "");
			const dirtyHeroModel = parseHeroInner(dirtyHero.inner || "");
			const heroUnchanged =
				baseHeroModel.type === "hero" &&
				dirtyHeroModel.type === "hero" &&
				baseHeroModel.title === dirtyHeroModel.title &&
				baseHeroModel.subtitle === dirtyHeroModel.subtitle;
			const heroInner = heroUnchanged
				? (baseHero.inner || "").trim()
				: serializeHeroInner(dirtyHeroModel);
			if (heroInner) merged = replaceRegion(merged, "hero", heroInner);
			const mainInner = serializeMainFromBlocks(mergedBlocks, {
				path: options.path || state.path || "",
			});
			merged = replaceRegion(merged, "main", mainInner);
			return merged;
		} else {
			const dirtyBlocks = parseBlocks(dirtyMain.inner);
			const baseHtmlList = baseBlocks.map((b) => (b.html || "").trim());
			dirtyBlocks.forEach((block) => {
				const html = (block.html || "").trim();
				const match = baseHtmlList.indexOf(html);
				if (match >= 0) baseHtmlList.splice(match, 1);
				else dirtyOnly.push(block);
			});
		}

		const mergedBlocks = baseBlocks.map((block) => ({ html: block.html }));
		const withPos = dirtyOnly
			.filter((item) => Number.isInteger(item.pos))
			.sort((a, b) => a.pos - b.pos);
		const withoutPos = dirtyOnly.filter((item) => !Number.isInteger(item.pos));
		let offset = 0;
		withPos.forEach((item) => {
			const insertAt = Math.max(
				0,
				Math.min(item.pos + offset, mergedBlocks.length),
			);
			mergedBlocks.splice(insertAt, 0, { html: item.html });
			offset += 1;
		});
		withoutPos.forEach((item) => {
			mergedBlocks.push({ html: item.html });
		});

		let merged = baseHtml || "";
		const dirtyHero = extractRegion(dirtyHtml, "hero");
		const baseHero = extractRegion(baseHtml, "hero");
		const baseHeroModel = parseHeroInner(baseHero.inner || "");
		const dirtyHeroModel = parseHeroInner(dirtyHero.inner || "");
		const heroUnchanged =
			baseHeroModel.type === "hero" &&
			dirtyHeroModel.type === "hero" &&
			baseHeroModel.title === dirtyHeroModel.title &&
			baseHeroModel.subtitle === dirtyHeroModel.subtitle;
		const heroInner = heroUnchanged
			? (baseHero.inner || "").trim()
			: serializeHeroInner(dirtyHeroModel);
		if (heroInner) merged = replaceRegion(merged, "hero", heroInner);
		const canonicalMain = serializeMainFromBlocks(
			mergedBlocks.map((b) => ({ html: b.html })),
			{ path: options.path || state.path || "" },
		);
		merged = replaceRegion(merged, "main", canonicalMain);
		return merged;
	}

	function refreshUiStateForDirty() {
		if (["loading", "error", "readonly"].includes(state.uiState)) return;
		if (state.prUrl) {
			setUiState("pr", buildPrLabel());
			return;
		}
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

					const localBlocks = getHydratedLocalBlocks(
						baseHtml,
						state.dirtyPages[path]?.localBlocks || [],
						{ filtered: true, pendingOnly: true },
					);
					const all = [];
					const added = [];
					const modified = [];
					const removed = [];
					const mergedForList = localBlocks.length
						? mergeDirtyWithBase(
								baseHtml || dirtyHtml || "",
								dirtyHtml || baseHtml || "",
								localBlocks,
								{
									respectRemovals: hasRemovalActions(localBlocks),
									path,
								},
							)
						: dirtyHtml;
					const baseBlocks = buildBaseBlocksWithOcc(baseHtml || "");
					const mergedBlocks = localBlocks.length
						? applyAnchoredInserts(baseBlocks, localBlocks, {
								respectRemovals: hasRemovalActions(localBlocks),
								baseOrderOverride: buildBaseOrderFromReorders(
									baseBlocks,
									localBlocks,
								),
							})
						: extractRegion(baseHtml, "main").found
							? parseBlocks(extractRegion(baseHtml, "main").inner).map((b) => ({
									html: b.html,
									_base: true,
								}))
							: [];
					const markKeys = new Set(
						localBlocks
							.filter((item) => item.action === "mark")
							.map((item) => anchorKey(item.anchor))
							.filter(Boolean),
					);
					const heroSource = mergedForList || dirtyHtml || baseHtml || "";
					const baseHero = extractRegion(baseHtml, "hero");
					const dirtyHero = extractRegion(heroSource, "hero");
					const baseHeroModel = parseHeroInner(baseHero.inner || "");
					const dirtyHeroModel = parseHeroInner(dirtyHero.inner || "");
					const heroChanged =
						baseHero.found &&
						dirtyHero.found &&
						!heroModelsEqual(baseHeroModel, dirtyHeroModel);
					const heroEntry = heroChanged
						? {
								id: `${path}::hero`,
								baseInner: baseHero.inner || "",
								dirtyInner: dirtyHero.inner || "",
								summary:
									dirtyHeroModel.type === "hero" && dirtyHeroModel.title
										? `Hero: ${dirtyHeroModel.title}`
										: "Hero",
							}
						: null;

					const summarize = (html) => {
						const doc = new DOMParser().parseFromString(
							`<div id="__wrap__">${html}</div>`,
							"text/html",
						);
						const node = doc.querySelector("#__wrap__")?.firstElementChild;
						if (!node) return { type: "block", summary: "Block" };
						return detectBlock(node);
					};

					mergedBlocks.forEach((block, idx) => {
						if (block?._base && markKeys.has(anchorKey(block))) return;
						const html = (block.html || "").trim();
						const info = summarize(html);
						const localItem = block._local || null;
						const isLocal = Boolean(localItem);
						const isBase = !isLocal;
						const item = {
							id: `${path}::${idx}`,
							idx,
							html,
							summary: info.summary || info.type || "Block",
							selectable:
								!isBase && (!localItem || localItem.status !== "pending"),
							localStatus: localItem?.status || (isLocal ? "staged" : null),
							prNumber: localItem?.prNumber || null,
							localId: localItem?.id || null,
							baseId: isBase ? block.id : localItem?.baseId || null,
							removed: false,
						};
						if (!isBase) added.push(item);
					});

					const removedItems = localBlocks
						.filter((item) => item.action === "mark")
						.map((item, idx) => {
							const html = (item.html || "").trim();
							const info = summarize(html);
							return {
								id: `${path}::remove::${item.id || idx}`,
								idx: mergedBlocks.length + idx,
								html,
								summary: `Deleted: ${info.summary || info.type || "Block"}`,
								selectable: item.status !== "pending",
								localStatus: item.status || "staged",
								prNumber: item.prNumber || null,
								localId: item.id || null,
								baseId: item.baseId || null,
								removed: true,
							};
						});
					removedItems.forEach((item) => {
						removed.push(item);
					});

					const baseOrder = baseBlocks.map((b) => b.id);
					const currentOrder = buildBaseOrderFromReorders(
						baseBlocks,
						localBlocks,
					);
					const movedIds = currentOrder.filter(
						(id, idx) => baseOrder[idx] && baseOrder[idx] !== id,
					);
					const reorderEntry = localBlocks.find(
						(item) => item.action === "reorder",
					);
					const reorderItems = movedIds.map((id, idx) => {
						const base = baseBlocks.find((b) => b.id === id);
						const info = base
							? summarize(base.html || "")
							: { summary: "Block" };
						return {
							id: `${path}::reorder::${id}::${idx}`,
							idx: mergedBlocks.length + removedItems.length + idx,
							html: base?.html || "",
							summary: `Moved: ${info.summary || "Block"}`,
							selectable: reorderEntry?.status !== "pending",
							localStatus: reorderEntry?.status || "staged",
							prNumber: reorderEntry?.prNumber || null,
							localId: reorderEntry?.id || null,
							baseId: id,
							removed: false,
						};
					});
					reorderItems.forEach((item) => {
						modified.push(item);
					});

					if (heroEntry) {
						const heroItem = {
							id: heroEntry.id,
							idx: -1,
							html: String(heroEntry.dirtyInner || "").trim(),
							summary: heroEntry.summary || "Hero",
							selectable: true,
							localStatus: "staged",
							prNumber: null,
							localId: null,
							baseId: "hero",
							removed: false,
							kind: "hero",
						};
						modified.unshift(heroItem);
					}

					all.push(...added, ...modified, ...removed);

					blockMap[path] = {
						path,
						baseHtml,
						dirtyHtml: mergedForList,
						localBlocks,
						hero: heroEntry,
						all,
						added,
						modified,
						removed,
					};
				} catch {
					const main = extractRegion(dirtyHtml, "main");
					const dirtyBlocks = main.found ? parseBlocks(main.inner) : [];
					blockMap[path] = {
						path,
						baseHtml: "",
						dirtyHtml,
						all: dirtyBlocks.map((block, idx) => ({
							id: `${path}::${idx}`,
							html: (block.html || "").trim(),
							summary: block.summary || block.type || "Block",
							selectable: true,
							removed: false,
						})),
						added: dirtyBlocks.map((block, idx) => ({
							id: `${path}::${idx}`,
							html: (block.html || "").trim(),
							summary: block.summary || block.type || "Block",
							selectable: true,
							removed: false,
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
			const hasLocal = normalizeLocalBlocks(entry.localBlocks || []).length > 0;
			if (
				!hasLocal &&
				entry.baseHash &&
				entry.dirtyHash &&
				entry.baseHash === entry.dirtyHash
			) {
				clearDirtyPage(path);
				return;
			}
			if (hasLocal) return;
			if (path === state.path) {
				const baseNow = state.originalHtml || "";
				const dirtyNow = entry.html || "";
				if (
					baseNow &&
					normalizeForDirtyCompare(dirtyNow, path) ===
						normalizeForDirtyCompare(baseNow, path)
				) {
					clearDirtyPage(path);
					return;
				}
			}
		});
	}

	async function purgeDirtyPagesFromRepo(force = false) {
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
					const entry = state.dirtyPages[path] || {};
					const cleanedLocal = getHydratedLocalBlocks(
						data.text || "",
						entry.localBlocks,
						{ filtered: true, pendingOnly: true },
					);
					const merged = mergeDirtyWithBase(
						data.text || "",
						entry.html || "",
						cleanedLocal,
						{
							respectRemovals: hasRemovalActions(cleanedLocal),
							path,
						},
					);
					const remappedLocal = cleanedLocal.length
						? assignAnchorsFromHtml(data.text || "", merged, cleanedLocal)
						: (state.prList || []).length
							? assignAnchorsFromHtml(data.text || "", merged, cleanedLocal)
							: [];
					const remoteText = normalizeForDirtyCompare(data.text || "", path);
					const entryText = normalizeForDirtyCompare(merged || "", path);
					if (
						!cleanedLocal.length &&
						remoteText &&
						entryText &&
						remoteText === entryText
					) {
						clearDirtyPage(path);
						return;
					}
					setDirtyPage(path, merged, data.text || "", remappedLocal);
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
		if (modes.has("deleted")) blocks = blocks.concat(entry.removed || []);
		return blocks;
	}

	function countSelectedBlocks(selectedBlocks) {
		let total = 0;
		selectedBlocks.forEach((set) => {
			total += set.size;
		});
		return total;
	}

	function getSelectedLocalIds(entry, selectedIds) {
		const selectedLocalIds = new Set();
		if (!entry || !selectedIds || !selectedIds.size) return selectedLocalIds;
		(entry.all || []).forEach((block) => {
			if (!selectedIds.has(block.id)) return;
			if (block.localId) selectedLocalIds.add(block.localId);
		});
		return selectedLocalIds;
	}

	function buildHtmlForSelection(entry, selectedIds, action) {
		const baseHtml = entry?.baseHtml || entry?.dirtyHtml || "";
		if (!baseHtml) return "";
		const heroInfo = entry?.hero || null;
		const heroSelected =
			heroInfo && selectedIds ? selectedIds.has(heroInfo.id) : false;
		const heroBase = heroInfo?.baseInner || "";
		const heroDirty = heroInfo?.dirtyInner || "";
		const localBlocks = normalizeLocalBlocks(entry?.localBlocks || []);
		if (!selectedIds || !selectedIds.size) {
			const result =
				action === "discard"
					? baseHtml
					: mergeDirtyWithBase(baseHtml, baseHtml, [], {
							respectRemovals: true,
							path: entry?.path || state.path,
						});
			const heroInner =
				action === "commit"
					? heroSelected
						? heroDirty
						: heroBase
					: heroSelected
						? heroBase
						: heroDirty;
			const withHero = heroInfo
				? applyHeroRegion(result, heroInner)
				: result;
			return canonicalizeFullHtml(withHero, entry?.path || state.path);
		}
		const selectedLocalIds = getSelectedLocalIds(entry, selectedIds);
		const selectedLocal = localBlocks
			.filter((item) => selectedLocalIds.has(item.id))
			.map((item) => {
				if (action === "commit" && item.action === "mark") {
					return { ...item, action: "remove" };
				}
				return item;
			});
		if (action === "commit") {
			const result = mergeDirtyWithBase(baseHtml, baseHtml, selectedLocal, {
				respectRemovals: true,
				path: entry?.path || state.path,
			});
			const withHero = heroInfo
				? applyHeroRegion(result, heroSelected ? heroDirty : heroBase)
				: result;
			return canonicalizeFullHtml(withHero, entry?.path || state.path);
		}
		const remainingLocal = localBlocks.filter(
			(item) => !selectedLocalIds.has(item.id),
		);
		const result = mergeDirtyWithBase(baseHtml, baseHtml, remainingLocal, {
			respectRemovals: hasRemovalActions(remainingLocal),
			path: entry?.path || state.path,
		});
		const withHero = heroInfo
			? applyHeroRegion(result, heroSelected ? heroBase : heroDirty)
			: result;
		return canonicalizeFullHtml(withHero, entry?.path || state.path);
	}

	function applyHtmlToCurrentPage(updatedHtml) {
		if (!updatedHtml || !updatedHtml.trim()) return;
		const hero = extractRegion(updatedHtml, "hero");
		const main = extractRegion(updatedHtml, "main");
		if (hero.found) state.heroInner = hero.inner;
		if (main.found) state.mainInner = main.inner;
		state.blocks = parseBlocks(state.mainInner);
		// Use the same normaliser as the dirty store to avoid whitespace drift.
		state.currentDirty =
			normalizeForDirtyCompare(updatedHtml, state.path) !==
			normalizeForDirtyCompare(state.originalHtml, state.path);
	}

	function renderDirtyPageList({
		selectedPages,
		selectedBlocks,
		blockData,
		modes,
		onSelectionChange,
	}) {
		const wrap = el("div", { class: "cms-modal__list cms-modal__list--scroll" }, []);
		const paths = Object.keys(state.dirtyPages || {}).sort();
		paths.forEach((path, idx) => {
			const id = `cms-page-${idx}`;
			const checkbox = el("input", { type: "checkbox", id });
			checkbox.checked = selectedPages.has(path);
			const label = el("label", { for: id, class: "cms-modal__label" }, [path]);
			const row = el("div", { class: "cms-modal__row cms-modal__page" }, [
				checkbox,
				label,
			]);

			const entry = blockData[path];
			const blocks = getBlocksForModes(entry, modes);
			const blockSet = selectedBlocks.get(path) || new Set();
			const selectable = blocks.filter((b) => b.selectable);
			if (!selectable.length) {
				selectedPages.delete(path);
				selectedBlocks.delete(path);
			}
			checkbox.disabled = selectable.length === 0;

			const group = el("div", { class: "cms-modal__group" }, [row]);
			if (selectedPages.has(path)) {
				const list = el(
					"ul",
					{ class: "cms-modal__sublist" },
					blocks.length
						? blocks.map((block) => {
								const item = el("li", { class: "cms-modal__block" }, []);
								const box = el("input", { type: "checkbox" });
								box.disabled = !block.selectable;
								box.checked = block.selectable && blockSet.has(block.id);
								const text = el("span", { class: "cms-modal__label" }, [
									block.summary,
								]);
								if (block.localStatus === "pending") {
									text.appendChild(
										el("span", { class: "cms-modal__badge" }, [
											`Pending PR${block.prNumber ? ` #${block.prNumber}` : ""}`,
										]),
									);
								}
								if (block.removed) {
									text.appendChild(
										el("span", { class: "cms-modal__badge" }, [
											"Marked delete",
										]),
									);
								}

								const toggle = () => {
									if (!block.selectable) return;
									const set = selectedBlocks.get(path) || new Set();
									if (box.checked) set.add(block.id);
									else set.delete(block.id);
									if (set.size) selectedBlocks.set(path, set);
									else {
										selectedBlocks.delete(path);
										selectedPages.delete(path);
									}
									onSelectionChange();
								};

								box.addEventListener("click", (event) => {
									event.stopPropagation();
									if (box.disabled) return;
									toggle();
								});
								item.addEventListener("click", (event) => {
									if (event.target === box) return;
									if (box.disabled) return;
									box.checked = !box.checked;
									toggle();
								});

								item.appendChild(box);
								item.appendChild(text);
								return item;
							})
						: [el("li", { class: "cms-modal__block" }, ["No blocks detected"])],
				);
				group.appendChild(list);
			}

			wrap.appendChild(group);

			const togglePage = () => {
				if (checkbox.disabled) return;
				if (checkbox.checked) {
					selectedPages.add(path);
					if (!selectedBlocks.has(path)) {
						selectedBlocks.set(path, new Set(selectable.map((b) => b.id)));
					}
				} else {
					selectedPages.delete(path);
					selectedBlocks.delete(path);
				}
				onSelectionChange();
			};

			checkbox.addEventListener("click", (event) => {
				event.stopPropagation();
				togglePage();
			});
			label.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (checkbox.disabled) return;
				checkbox.checked = !checkbox.checked;
				togglePage();
			});

			row.addEventListener("click", (event) => {
				if (event.target === checkbox) return;
				if (checkbox.disabled) return;
				checkbox.checked = !checkbox.checked;
				togglePage();
			});
		});
		return wrap;
	}

	function buildModalToggleBar(onChange, options = {}) {
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
		const deletedBtn = el(
			"button",
			{ class: "cms-modal__toggle-btn", type: "button" },
			["Marked delete"],
		);
		const allBtn = el(
			"button",
			{ class: "cms-modal__toggle-btn", type: "button" },
			["All blocks"],
		);

		const modes = new Set(options.defaultModes || ["new"]);
		const syncButtons = () => {
			newBtn.classList.toggle("is-active", modes.has("new"));
			modifiedBtn.classList.toggle("is-active", modes.has("modified"));
			deletedBtn.classList.toggle("is-active", modes.has("deleted"));
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
		deletedBtn.addEventListener("click", () => toggleMode("deleted"));
		allBtn.addEventListener("click", () => setAll());

		wrap.appendChild(newBtn);
		wrap.appendChild(modifiedBtn);
		wrap.appendChild(deletedBtn);
		wrap.appendChild(allBtn);
		syncButtons();
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

	function addAssetUpload({ name, content, path, mime = "" }) {
		if (!name || !content) return;
		const clean = sanitizeImagePath(path || "", name);
		if (!clean) return;
		state.assetUploads = (state.assetUploads || []).filter(
			(item) => item.path !== clean,
		);
		state.assetUploads.push({
			path: clean,
			content,
			encoding: "base64",
			mime,
		});
		assetCachePut({
			path: clean,
			content,
			encoding: "base64",
			mime,
		});
	}

	function pruneUnusedAssetUploads() {
		if (!state.assetUploads || !state.assetUploads.length) return;
		const referenced = getReferencedAssetPaths();
		const next = state.assetUploads.filter((item) => referenced.has(item.path));
		if (next.length !== state.assetUploads.length) {
			state.assetUploads = next;
		}
		assetCachePrune(referenced);
	}

	function mergePrFiles(pageFiles, assetFiles) {
		const merged = [];
		const seen = new Set();
		[...(assetFiles || []), ...(pageFiles || [])].forEach((file) => {
			const path = String(file?.path || "").trim();
			if (!path || seen.has(path)) return;
			seen.add(path);
			merged.push(file);
		});
		return merged;
	}

	function getReferencedAssetPaths() {
		const referenced = new Set();
		Object.values(state.dirtyPages || {}).forEach((entry) => {
			const html = entry?.html || "";
			if (!html) return;
			const doc = new DOMParser().parseFromString(html, "text/html");
			doc.querySelectorAll("[data-img]").forEach((node) => {
				const local = getLocalAssetPath(node.getAttribute("data-img") || "");
				if (local) referenced.add(local);
			});
			doc.querySelectorAll("img").forEach((img) => {
				const local = getLocalAssetPath(img.getAttribute("src") || "");
				if (local) referenced.add(local);
			});
		});
		return referenced;
	}

	async function rehydrateAssetUploadsFromCache() {
		const referenced = getReferencedAssetPaths();
		if (!referenced.size) return;
		const existing = new Set(
			(state.assetUploads || []).map((item) => item.path),
		);
		const missing = Array.from(referenced).filter(
			(path) => !existing.has(path),
		);
		if (!missing.length) return;
		const recovered = await Promise.all(
			missing.map((path) => assetCacheGet(path)),
		);
		recovered.filter(Boolean).forEach((item) => {
			state.assetUploads.push({
				path: item.path,
				content: item.content || "",
				encoding: item.encoding || "base64",
				mime: item.mime || "",
			});
		});
	}

	function applyLocalImagePreviews(root = document) {
		const uploads = state.assetUploads || [];
		if (!uploads.length) return;
		const byPath = new Map(uploads.map((item) => [item.path, item]));
		const resolveDataUrl = (src) => {
			const local = getLocalAssetPath(src);
			if (!local) return "";
			const item = byPath.get(local);
			if (!item?.content) return "";
			const mime = item.mime || guessImageMime(local);
			return `data:${mime};base64,${item.content}`;
		};
		root.querySelectorAll("[data-img]").forEach((node) => {
			const src = node.getAttribute("data-img") || "";
			if (!src || src.startsWith("data:")) return;
			const dataUrl = resolveDataUrl(src);
			if (dataUrl) node.style.backgroundImage = `url("${dataUrl}")`;
		});
		root.querySelectorAll("img").forEach((img) => {
			const src = img.getAttribute("src") || "";
			if (!src || src.startsWith("data:")) return;
			const dataUrl = resolveDataUrl(src);
			if (dataUrl) img.src = dataUrl;
		});
	}

	async function submitPr(paths, note, payloads = null) {
		try {
			setUiState("loading", "CREATING PR…");
			state.prUrl = "";
			state.prNumber = null;

			const pageFiles =
				Array.isArray(payloads) && payloads.length
					? payloads
					: paths.map((path) => ({
							path,
							text: state.dirtyPages[path]?.html || "",
						}));
			const assetFiles = (state.assetUploads || []).map((item) => ({
				path: item.path,
				content: item.content,
				encoding: item.encoding || "base64",
			}));
			const files = mergePrFiles(pageFiles, assetFiles);

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

			addPrToState({ url: data?.pr?.url || "", number: data?.pr?.number });
			if (!payloads) {
				paths.forEach((path) => clearDirtyPage(path));
				purgeCleanDirtyPages();
			}
			pruneUnusedAssetUploads();

			setUiState("pr", buildPrLabel());
			renderPageSurface();
			startPrPolling();
			return data?.pr || null;
		} catch (err) {
			console.error(err);
			setUiState("error", "DISCONNECTED / ERROR");
			renderPageSurface();
			return null;
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

	function stripOutsideCms(html) {
		const hero = extractRegion(html, "hero");
		const main = extractRegion(html, "main");
		if (!hero.found || !main.found) return html;
		const beforeHero = html.slice(0, hero.startIndex);
		const between = html.slice(hero.endIndex, main.startIndex);
		const afterMain = html.slice(main.endIndex);
		return `${beforeHero}${between}${afterMain}`;
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

	function serializeMainFromBlocks(blocks, ctx = {}) {
		const models = (blocks || []).map((b) => {
			const doc = new DOMParser().parseFromString(
				`<div id="__wrap__">${String(b.html || "")}</div>`,
				"text/html",
			);
			const node = doc.querySelector("#__wrap__")?.firstElementChild;
			if (!node) return { type: "legacy", raw: String(b.html || "") };
			return parseMainBlockNode(node);
		});
		return serializeMainBlocks(models, ctx);
	}

	function normalizeBlocks() {
		state.blocks = (state.blocks || []).map((b, idx) => ({
			...b,
			idx,
		}));
	}

	async function insertBlockFromPartial(index, anchorOverride, partialPath) {
		const html = await loadPartialHtml(partialPath);
		return insertHtmlAt(index, anchorOverride, html);
	}

	async function insertHtmlAt(index, anchorOverride, html) {
		const localEntry = state.dirtyPages[state.path] || {};
		const localBlocks = normalizeLocalBlocks(localEntry.localBlocks || []);
		const mergedForIndex = buildMergedRenderBlocks(
			state.originalHtml || "",
			localBlocks,
			{ respectRemovals: hasRemovalActions(localBlocks) },
		);
		let anchor = null;
		let placement = "after";
		if (anchorOverride?.anchor) {
			anchor = anchorOverride.anchor;
			placement = anchorOverride.placement || "after";
		} else {
			const anchorInfo = getAnchorForIndex(index, mergedForIndex);
			anchor = anchorInfo.anchor;
			placement = anchorInfo.placement;
		}
		const idCtx = buildCmsIdContext(state.originalHtml || "", localBlocks);
		const normalizedLocal = localBlocks.map((item) => {
			if (!item?.html) return item;
			const node = parseFirstElementFromHtml(item.html);
			const existingId = node?.getAttribute("data-cms-id") || "";
			if (existingId) return item;
			const ensured = ensureBlockHtmlHasCmsId(item.html, idCtx);
			if (!ensured.html || ensured.html === item.html) return item;
			return { ...item, html: ensured.html };
		});
		const ensuredNew = ensureBlockHtmlHasCmsId(html, idCtx);
		const countLocalBefore = (merged, targetIndex) => {
			if (!Array.isArray(merged) || !Number.isInteger(targetIndex)) return 0;
			let count = 0;
			const limit = Math.min(targetIndex, merged.length);
			for (let i = 0; i < limit; i += 1) {
				if (merged[i]?._local) count += 1;
			}
			return count;
		};
		const localInsertIndex = countLocalBefore(mergedForIndex, index);
		const updatedLocal = normalizedLocal.slice();
		updatedLocal.splice(Math.max(0, Math.min(localInsertIndex, updatedLocal.length)), 0, {
			id: makeLocalId(),
			html: ensuredNew.html,
			anchor,
			placement,
			status: "staged",
			kind: "new",
			pos: index,
		});
		state.blocks.splice(index, 0, {
			idx: index,
			type: "std-container",
			summary: "Standard container",
			html: ensuredNew.html,
		});

		normalizeBlocks();
		rebuildPreviewHtml();
		markCurrentDirty();
		setDirtyPage(state.path, state.rebuiltHtml, "", updatedLocal);
		refreshUiStateForDirty();
		renderPageSurface();
	}

	function openInsertBlockModal(index, anchorInfo) {
		const list = el("div", { class: "cms-modal__list" }, []);
		BLOCK_LIBRARY.forEach((item) => {
			const row = el(
				"div",
				{
					class: "cms-modal__row cms-modal__row--pick",
					role: "button",
					tabindex: "0",
					"aria-label": `Insert ${item.label}`,
				},
				[
					el("span", { class: "cms-modal__label" }, [item.label]),
					el(
						"button",
						{
							class: "cms-btn cms-modal__action cms-modal__action--pick",
							type: "button",
						},
						["Insert"],
					),
				],
			);
			const handlePick = async () => {
				closeModal();
				try {
					await insertBlockFromPartial(index, anchorInfo, item.partial);
				} catch (err) {
					console.error(err);
					setUiState("error", "DISCONNECTED / ERROR");
					renderPageSurface();
				}
			};
			row.addEventListener("click", handlePick);
			row.addEventListener("keydown", (event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					handlePick();
				}
			});
			list.appendChild(row);
		});
		openModal({
			title: "Insert block",
			bodyNodes: [list],
			footerNodes: [
				el(
					"button",
					{
						class: "cms-btn cms-modal__action cms-btn--danger",
						type: "button",
						"data-close": "true",
					},
					["Close Modal"],
				),
			],
		});
	}

	function insertHtmlAtCursor(editor, html) {
		if (!editor) return;
		editor.focus();
		const ok = document.execCommand("insertHTML", false, html);
		if (ok) return;
		const selection = window.getSelection();
		if (!selection) return;
		let range = null;
		if (selection.rangeCount > 0) {
			range = selection.getRangeAt(0);
		} else {
			range = document.createRange();
			range.selectNodeContents(editor);
			range.collapse(false);
		}
		range.deleteContents();
		range.insertNode(document.createRange().createContextualFragment(html));
		selection.removeAllRanges();
		selection.addRange(range);
	}

	function findClosestCell() {
		const selection = window.getSelection();
		if (!selection || !selection.anchorNode) return null;
		let node = selection.anchorNode;
		if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
		return node?.closest ? node.closest("td,th") : null;
	}

	function addTableRowAfterCell() {
		const cell = findClosestCell();
		const row = cell?.closest("tr");
		if (!row) return;
		const table = row.closest("table");
		if (!table) return;
		const newRow = row.cloneNode(true);
		Array.from(newRow.children).forEach((c) => (c.textContent = ""));
		row.parentElement?.insertBefore(newRow, row.nextSibling);
	}

	function addTableColumnAfterCell() {
		const cell = findClosestCell();
		const row = cell?.closest("tr");
		if (!row) return;
		const index = Array.from(row.children).indexOf(cell);
		const table = row.closest("table");
		if (!table) return;
		const rows = table.querySelectorAll("tr");
		rows.forEach((r) => {
			const cells = r.querySelectorAll("th,td");
			const base = cells[index] || cells[cells.length - 1];
			const tag = base?.tagName?.toLowerCase() === "th" ? "th" : "td";
			const next = document.createElement(tag);
			next.textContent = "";
			if (base && base.parentElement) {
				base.parentElement.insertBefore(next, base.nextSibling);
			} else {
				r.appendChild(next);
			}
		});
	}

	function removeTableRowAtCell() {
		const cell = findClosestCell();
		const row = cell?.closest("tr");
		if (!row) return;
		const table = row.closest("table");
		if (!table) return;
		row.remove();
		if (!table.querySelector("tr")) table.remove();
	}

	function removeTableColumnAtCell() {
		const cell = findClosestCell();
		const row = cell?.closest("tr");
		if (!row) return;
		const table = row.closest("table");
		if (!table) return;
		const index = Array.from(row.children).indexOf(cell);
		const rows = Array.from(table.querySelectorAll("tr"));
		rows.forEach((r) => {
			const cells = Array.from(r.querySelectorAll("th,td"));
			if (!cells.length) return;
			const target = cells[index] || cells[cells.length - 1];
			target?.remove();
			if (!r.querySelector("th,td")) r.remove();
		});
		if (!table.querySelector("th,td")) table.remove();
	}

	function toggleBlockquote() {
		const selection = window.getSelection();
		if (!selection || !selection.anchorNode) {
			document.execCommand("formatBlock", false, "BLOCKQUOTE");
			return;
		}
		let node = selection.anchorNode;
		if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
		const quote = node?.closest ? node.closest("blockquote") : null;
		if (!quote) {
			document.execCommand("formatBlock", false, "BLOCKQUOTE");
			return;
		}
		const parent = quote.parentNode;
		if (!parent) return;
		const range =
			selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
		const frag = document.createDocumentFragment();
		while (quote.firstChild) frag.appendChild(quote.firstChild);
		parent.replaceChild(frag, quote);
		if (range) {
			selection.removeAllRanges();
			selection.addRange(range);
		}
	}

	async function fetchImageLibrary(path = "assets/img", collected = []) {
		const res = await fetch(`/api/repo/tree?path=${encodeURIComponent(path)}`, {
			headers: { Accept: "application/json" },
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data?.error || "Failed to load image list");
		const items = Array.isArray(data.items) ? data.items : [];
		for (const item of items) {
			if (item.type === "dir") {
				await fetchImageLibrary(item.path, collected);
			} else if (item.type === "file") {
				collected.push(item);
			}
		}
		return collected;
	}

	async function loadImageLibraryIntoSelect(select) {
		const images = await fetchImageLibrary();
		select.innerHTML = "";
		select.appendChild(
			el("option", { value: "" }, ["Select an existing image"]),
		);
		images
			.sort((a, b) => String(a.path).localeCompare(String(b.path)))
			.forEach((item) => {
				const label = String(item.path || "").replace(/^assets\/img\//, "");
				select.appendChild(
					el("option", { value: item.path }, [label || item.name]),
				);
			});
		return images;
	}

	const DOC_EXT_RE =
		/\.(pdf|doc|docx|xls|xlsx|csv|ppt|pptx|md|txt|rtf|zip|rar|7z)$/i;

	async function fetchDocLibrary(path = "assets/docs", collected = []) {
		const res = await fetch(`/api/repo/tree?path=${encodeURIComponent(path)}`, {
			headers: { Accept: "application/json" },
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data?.error || "Failed to load doc list");
		const items = Array.isArray(data.items) ? data.items : [];
		for (const item of items) {
			if (item.type === "dir") {
				await fetchDocLibrary(item.path, collected);
			} else if (item.type === "file") {
				collected.push(item);
			}
		}
		return collected;
	}

	async function loadDocLibraryIntoSelect(select) {
		const docs = await fetchDocLibrary();
		select.innerHTML = "";
		select.appendChild(el("option", { value: "" }, ["Select a document"]));
		docs
			.filter((item) => DOC_EXT_RE.test(String(item.path || "")))
			.sort((a, b) => String(a.path).localeCompare(String(b.path)))
			.forEach((item) => {
				const label = String(item.path || "").replace(/^assets\/docs\//, "");
				select.appendChild(
					el("option", { value: item.path }, [label || item.name]),
				);
			});
		return docs;
	}

	function buildRteToolbar() {
		const toolbarIcon = (name) =>
			el(
				"span",
				{ class: "material-icons cms-rte__icon", "aria-hidden": "true" },
				[name],
			);
		const buildToolbarGroup = (title, actions) =>
			el("div", { class: "cms-rte__toolbar-group" }, [
				el("div", { class: "cms-rte__toolbar-title" }, [
					el("span", { class: "cms-rte__toolbar-title-text" }, [title]),
					el("span", { class: "cms-rte__toolbar-title-line" }),
				]),
				el("div", { class: "cms-rte__toolbar-actions" }, actions),
			]);
		const toolbarDivider = () =>
			el("div", { class: "cms-rte__toolbar-divider", "aria-hidden": "true" });
		return el("div", { class: "cms-rte__toolbar" }, [
			buildToolbarGroup("Styling", [
				el(
					"button",
					{
						type: "button",
						"data-cmd": "bold",
						"data-tooltip": "Bold",
						"aria-label": "Bold",
					},
					[toolbarIcon("format_bold")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "italic",
						"data-tooltip": "Italic",
						"aria-label": "Italic",
					},
					[toolbarIcon("format_italic")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "underline",
						"data-tooltip": "Underline",
						"aria-label": "Underline",
					},
					[toolbarIcon("format_underlined")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "link",
						"data-tooltip": "Link",
						"aria-label": "Insert link",
					},
					[toolbarIcon("link")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "align-left",
						"data-tooltip": "Align left",
						"aria-label": "Align left",
					},
					[toolbarIcon("format_align_left")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "align-center",
						"data-tooltip": "Align center",
						"aria-label": "Align center",
					},
					[toolbarIcon("format_align_center")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "h2",
						"data-tooltip": "Header 2",
						"aria-label": "Header 2",
					},
					[toolbarIcon("filter_2")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "h3",
						"data-tooltip": "Header 3",
						"aria-label": "Header 3",
					},
					[toolbarIcon("filter_3")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "quote",
						"data-tooltip": "Blockquote",
						"aria-label": "Blockquote",
					},
					[toolbarIcon("format_quote")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "ul",
						"data-tooltip": "Bulleted list",
						"aria-label": "Bulleted list",
					},
					[toolbarIcon("format_list_bulleted")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "ol",
						"data-tooltip": "Numbered list",
						"aria-label": "Numbered list",
					},
					[toolbarIcon("format_list_numbered")],
				),
			]),
			toolbarDivider(),
			buildToolbarGroup("Table", [
				el(
					"button",
					{
						type: "button",
						"data-cmd": "table",
						"data-tooltip": "Table",
						"aria-label": "Table",
					},
					[toolbarIcon("grid_on")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "table-borderless",
						"data-tooltip": "Borderless table",
						"aria-label": "Borderless table",
					},
					[toolbarIcon("border_clear")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "table-row",
						"data-tooltip": "Add row",
						"aria-label": "Add row",
					},
					[toolbarIcon("call_to_action")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "table-col",
						"data-tooltip": "Add column",
						"aria-label": "Add column",
					},
					[toolbarIcon("chrome_reader_mode")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "table-row-remove",
						"data-tooltip": "Remove row",
						"aria-label": "Remove row",
					},
					[toolbarIcon("border_horizontal")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "table-col-remove",
						"data-tooltip": "Remove column",
						"aria-label": "Remove column",
					},
					[toolbarIcon("border_vertical")],
				),
			]),
			toolbarDivider(),
			buildToolbarGroup("Code", [
				el(
					"button",
					{
						type: "button",
						"data-cmd": "code",
						"data-tooltip": "Inline code",
						"aria-label": "Inline code",
					},
					[toolbarIcon("settings_ethernet")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "code-block",
						"data-tooltip": "Code block",
						"aria-label": "Code block",
					},
					[toolbarIcon("crop_square")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "code-wrap",
						"data-tooltip": "Wrap in code block",
						"aria-label": "Wrap in code block",
					},
					[toolbarIcon("wrap_text")],
				),
			]),
			toolbarDivider(),
			buildToolbarGroup("Tools", [
				el(
					"button",
					{
						type: "button",
						"data-cmd": "img",
						"data-tooltip": "Image",
						"aria-label": "Image",
					},
					[toolbarIcon("image")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "video",
						"data-tooltip": "Video",
						"aria-label": "Video",
					},
					[toolbarIcon("ondemand_video")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "accordion-simple",
						"data-tooltip": "Accordion (simple)",
						"aria-label": "Accordion (simple)",
					},
					[toolbarIcon("view_list")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "accordion-styled",
						"data-tooltip": "Accordion (styled)",
						"aria-label": "Accordion (styled)",
					},
					[toolbarIcon("dvr")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "doc",
						"data-tooltip": "Attach document",
						"aria-label": "Attach document",
					},
					[toolbarIcon("attach_file")],
				),
			]),
			toolbarDivider(),
			buildToolbarGroup("Mermaid charts", [
				el(
					"button",
					{
						type: "button",
						"data-cmd": "mermaid-flow",
						"data-tooltip": "Mermaid flowchart",
						"aria-label": "Mermaid flowchart",
					},
					[toolbarIcon("schema")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "mermaid-sequence",
						"data-tooltip": "Mermaid sequence diagram",
						"aria-label": "Mermaid sequence diagram",
					},
					[toolbarIcon("swap_horiz")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "mermaid-gantt",
						"data-tooltip": "Mermaid Gantt chart",
						"aria-label": "Mermaid Gantt chart",
					},
					[toolbarIcon("view_timeline")],
				),
				el(
					"button",
					{
						type: "button",
						"data-cmd": "mermaid-pie",
						"data-tooltip": "Mermaid pie chart",
						"aria-label": "Mermaid pie chart",
					},
					[toolbarIcon("pie_chart")],
				),
			]),
		]);
	}

	function createRteToolbarController(existingToolbar = null) {
		const toolbar = existingToolbar || buildRteToolbar();
		let activeHandler = null;
		let activeEditor = null;
		const allowedByEditor = new WeakMap();
		const toolbarButtons = () =>
			Array.from(toolbar.querySelectorAll("button[data-cmd]"));

		const updateToolbarState = () => {
			const allowed = activeEditor ? allowedByEditor.get(activeEditor) : null;
			toolbarButtons().forEach((btn) => {
				const cmd = btn.getAttribute("data-cmd") || "";
				const enabled = !allowed || allowed.has(cmd);
				btn.disabled = !enabled;
				btn.classList.toggle("is-disabled", !enabled);
			});
		};

		const setActive = (editor, handler) => {
			activeEditor = editor || null;
			activeHandler = typeof handler === "function" ? handler : null;
			updateToolbarState();
		};

		const registerEditor = (editor, handler, options = {}) => {
			if (!editor) return;
			if (options.allowedCommands) {
				allowedByEditor.set(editor, new Set(options.allowedCommands));
			} else {
				allowedByEditor.delete(editor);
			}
			const activate = () => setActive(editor, handler);
			editor.addEventListener("focus", activate);
			editor.addEventListener("click", activate);
			editor.addEventListener("mouseup", activate);
			editor.addEventListener("keyup", activate);
			if (!activeHandler) activate();
		};

		toolbar.addEventListener("click", (event) => {
			const btn = event.target.closest("button");
			if (!btn) return;
			const cmd = btn.getAttribute("data-cmd");
			if (!cmd) return;
			if (btn.disabled) return;
			if (activeHandler) activeHandler(cmd);
		});

		return {
			toolbar,
			registerEditor,
			setActiveHandler: (handler) => setActive(activeEditor, handler),
		};
	}

	function buildRteEditor({
		label,
		initialHtml,
		toolbarController,
		allowedCommands,
	} = {}) {
		const buildAccordionMarkup = ({ styled }) => {
			const baseId = `acc-${BUILD_TOKEN}-${makeLocalId()}`;
			const items = [
				{
					id: `${baseId}-1`,
					title: "Item 1",
					body: "<ul><li>Point A</li><li>Point B</li></ul>",
				},
				{
					id: `${baseId}-2`,
					title: "Item 2",
					body: "<ul><li>Thing 1</li><li>Thing 2</li></ul>",
				},
			];
			const tabs = items
				.map((item) =>
					[
						`<div class="tab">`,
						`\t<input type="checkbox" id="${escapeAttr(item.id)}" />`,
						`\t<label class="tab-label" for="${escapeAttr(item.id)}">${escapeHtml(item.title)}</label>`,
						`\t<div class="tab-content">`,
						`\t\t${item.body}`,
						`\t</div>`,
						`</div>`,
					].join("\n"),
				)
				.join("\n\n");
			if (!styled) return tabs;
			return [
				`<div class="flex-accordion-wrapper">`,
				`\t<div class="flex-accordion-box">`,
				`\t\t<h2>Accordion title</h2>`,
				`\t\t<p>Optional intro text...</p>`,
				`\t\t${tabs.replace(/\n/g, "\n\t\t")}`,
				`\t</div>`,
				`</div>`,
			].join("\n");
		};
		const toolbar = toolbarController
			? toolbarController.toolbar
			: buildRteToolbar();
		const editor = el("div", {
			class: "cms-rte",
			contenteditable: "true",
			"data-rte": "true",
		});
		editor.innerHTML = initialHtml || "";
		let lastRange = null;
		const saveSelection = () => {
			const selection = window.getSelection();
			if (!selection || selection.rangeCount === 0) return;
			const range = selection.getRangeAt(0);
			const container = range.commonAncestorContainer;
			if (!editor.contains(container)) return;
			lastRange = range.cloneRange();
		};
		const restoreSelection = () => {
			if (!lastRange) return false;
			const selection = window.getSelection();
			if (!selection) return false;
			selection.removeAllRanges();
			selection.addRange(lastRange);
			return true;
		};

		const TOOLBAR_TEXT_RE =
			/Auto\s*JS\s*JSON\s*HTML\s*CSS\s*Python\s*Markdown\s*Mermaid\s*YAML\s*Format/g;
		const CODE_LANG_OPTIONS = [
			{ value: "auto", label: "Auto" },
			{ value: "javascript", label: "JS" },
			{ value: "json", label: "JSON" },
			{ value: "html", label: "HTML" },
			{ value: "css", label: "CSS" },
			{ value: "python", label: "Python" },
			{ value: "markdown", label: "Markdown" },
			{ value: "mermaid", label: "Mermaid" },
			{ value: "yaml", label: "YAML" },
		];

		const stripToolbarText = (root) => {
			const walker = document.createTreeWalker(
				root,
				NodeFilter.SHOW_TEXT,
				null,
			);
			const toRemove = [];
			while (walker.nextNode()) {
				const node = walker.currentNode;
				if (!node?.textContent) continue;
				if (TOOLBAR_TEXT_RE.test(node.textContent)) {
					const cleaned = node.textContent.replace(TOOLBAR_TEXT_RE, "");
					if (cleaned.trim() === "") toRemove.push(node);
					else node.textContent = cleaned;
				}
			}
			toRemove.forEach((node) => node.remove());
		};

		stripToolbarText(editor);
		editor.addEventListener("keyup", saveSelection);
		editor.addEventListener("mouseup", saveSelection);
		editor.addEventListener("focus", saveSelection);
		editor.addEventListener("input", saveSelection);
		document.addEventListener("selectionchange", saveSelection);

		const updateCodeLanguage = (codeEl, lang) => {
			if (!codeEl) return;
			const clean = String(lang || "")
				.trim()
				.toLowerCase();
			codeEl.className = "";
			codeEl.removeAttribute("data-lang");
			if (clean && clean !== "auto") {
				codeEl.className = `language-${clean}`;
				codeEl.setAttribute("data-lang", clean);
			}
			codeEl.classList.add("nohighlight");
			codeEl.setAttribute("contenteditable", "true");
			codeEl.setAttribute("spellcheck", "false");
		};

		const ensureCodeToolbarWrap = (pre) => {
			if (!pre?.parentElement) return null;
			if (pre.parentElement.classList.contains("cms-code-block-wrap"))
				return pre.parentElement;
			const wrap = document.createElement("div");
			wrap.className = "cms-code-block-wrap";
			pre.parentElement.insertBefore(wrap, pre);
			wrap.appendChild(pre);
			return wrap;
		};

		const ensureCodeToolbarUi = (pre, codeEl) => {
			const wrap = ensureCodeToolbarWrap(pre);
			if (!wrap) return;
			let toolbar = wrap.querySelector(":scope > .cms-code-toolbar");
			if (!toolbar) {
				const select = document.createElement("select");
				select.className = "cms-code-toolbar__select";
				CODE_LANG_OPTIONS.forEach((opt) => {
					const option = document.createElement("option");
					option.value = opt.value;
					option.textContent = opt.label;
					select.appendChild(option);
				});
				const autoBtn = document.createElement("button");
				autoBtn.type = "button";
				autoBtn.className = "cms-code-toolbar__btn";
				autoBtn.textContent = "Auto";
				const applySelection = (value) => {
					if (value === "auto") {
						const detected =
							guessLanguageFromText(codeEl?.textContent) || "auto";
						if (detected && detected !== "auto") {
							updateCodeLanguage(codeEl, detected);
							select.value = detected;
							refreshMermaidPreviewButtons();
							scheduleMermaidPreview();
							return;
						}
						updateCodeLanguage(codeEl, "auto");
						select.value = "auto";
						refreshMermaidPreviewButtons();
						scheduleMermaidPreview();
						return;
					}
					updateCodeLanguage(codeEl, value);
					refreshMermaidPreviewButtons();
					scheduleMermaidPreview();
				};
				select.addEventListener("change", () => applySelection(select.value));
				autoBtn.addEventListener("click", (event) => {
					event.preventDefault();
					applySelection("auto");
				});
				const deleteBtn = document.createElement("button");
				deleteBtn.type = "button";
				deleteBtn.className =
					"cms-code-toolbar__btn cms-code-toolbar__btn--danger";
				deleteBtn.textContent = "Delete";
				deleteBtn.addEventListener("click", (event) => {
					event.preventDefault();
					openInlineDeleteConfirm({
						onConfirm: () => {
							wrap.remove();
						},
					});
				});
				toolbar = document.createElement("div");
				toolbar.className = "cms-code-toolbar";
				toolbar.appendChild(select);
				toolbar.appendChild(autoBtn);
				toolbar.appendChild(deleteBtn);
				wrap.appendChild(toolbar);
			}
			const select = toolbar.querySelector("select.cms-code-toolbar__select");
			if (select) {
				select.value = getLangFromCodeEl(codeEl) || "auto";
			}
			refreshMermaidPreviewButtons();
		};

		const ensureCodeToolbar = (pre) => {
			if (!pre) return;
			const codeEl = pre.querySelector("code");
			if (!codeEl) return;
			pre.removeAttribute("contenteditable");
			const textLang = getLangFromCodeEl(codeEl);
			const detected = textLang || guessLanguageFromText(codeEl.textContent);
			if (!textLang && detected && detected !== "auto") {
				updateCodeLanguage(codeEl, detected);
			}
			if (TOOLBAR_TEXT_RE.test(codeEl.textContent)) {
				codeEl.textContent = codeEl.textContent.replace(TOOLBAR_TEXT_RE, "");
			}
			pre.classList.add("cms-code-block");
			updateCodeLanguage(
				codeEl,
				getLangFromCodeEl(codeEl) || detected || "auto",
			);
			codeEl.removeAttribute("data-highlighted");
			codeEl.classList.remove("hljs");
			codeEl.textContent = codeEl.textContent || "";
			ensureCodeToolbarUi(pre, codeEl);
		};

		editor.querySelectorAll("pre").forEach((pre) => ensureCodeToolbar(pre));

		const codeObserver = new MutationObserver((mutations) => {
			mutations.forEach((mutation) => {
				mutation.addedNodes.forEach((node) => {
					if (!(node instanceof HTMLElement)) return;
					if (node.matches("pre")) ensureCodeToolbar(node);
					node
						.querySelectorAll?.("pre")
						.forEach((pre) => ensureCodeToolbar(pre));
				});
			});
		});
		codeObserver.observe(editor, { childList: true, subtree: true });

		const mermaidPreviewBody = el("div", {
			class: "cms-mermaid-preview__body",
		});
		const mermaidPreviewEmpty = el(
			"div",
			{ class: "cms-mermaid-preview__empty" },
			["Add a Mermaid code block to preview."],
		);
		const mermaidPreview = el(
			"div",
			{ class: "cms-mermaid-preview", hidden: true },
			[
				el("div", { class: "cms-mermaid-preview__header" }, [
					"Mermaid preview",
				]),
				mermaidPreviewEmpty,
				mermaidPreviewBody,
			],
		);
		const editorRow = el("div", { class: "cms-rte__editor-row is-solo" }, [
			editor,
			mermaidPreview,
		]);
		let mermaidPreviewTimer = null;
		let mermaidPreviewToken = 0;
		let mermaidLoadPromise = window.__CMS_MERMAID_PREVIEW_PROMISE || null;
		var mermaidPreviewHidden = false;

		const setMermaidPreviewVisible = (visible) => {
			mermaidPreview.hidden = !visible;
			editorRow.classList.toggle("is-solo", !visible);
			mermaidPreviewHidden = !visible;
			refreshMermaidPreviewButtons();
		};

		const toggleMermaidPreview = () => {
			const nextVisible = mermaidPreviewHidden;
			setMermaidPreviewVisible(nextVisible);
			if (nextVisible) scheduleMermaidPreview();
		};

			const normalizeMermaidTextForElk = (text) => {
				const raw = String(text || "").trim();
				if (!raw) return "";
				const decl = /(^|\n)(\s*)(flowchart|graph)(?:-elk)?\b/i.exec(raw);
				if (!decl) return raw;
				const declStart = decl.index + decl[1].length;
				const preamble = raw.slice(0, declStart);
				const hasRendererInit =
					/(^|\n)\s*%%\{init:\s*\{[\s\S]*?["']?flowchart["']?\s*:\s*\{[\s\S]*?defaultRenderer\s*:/i.test(
						raw,
					);
				const readWord = (key) => {
					const m = new RegExp(
						`["']?${key}["']?\\s*:\\s*["']?([A-Z0-9_-]+)["']?\\b`,
						"i",
					).exec(preamble);
					return m ? m[1] : undefined;
				};
				const layoutWord = (readWord("layout") || "").toLowerCase();
				let desiredRenderer = null;
				if (layoutWord === "elk") desiredRenderer = "elk";
				else if (
					layoutWord === "dagre" ||
					layoutWord === "dagre-wrapper" ||
					layoutWord === "dagre-d3"
				)
					desiredRenderer = "dagre-wrapper";
				else if (!hasRendererInit) desiredRenderer = "dagre-wrapper";
				if (!desiredRenderer) return raw;
				const readBool = (key) => {
					const m = new RegExp(
						`["']?${key}["']?\\s*:\\s*(true|false)\\b`,
						"i",
					).exec(preamble);
					if (!m) return undefined;
					return m[1].toLowerCase() === "true";
				};
				const elkConfig = {};
				if (desiredRenderer === "elk") {
					const mergeEdges = readBool("mergeEdges");
					const forceNodeModelOrder = readBool("forceNodeModelOrder");
					const nodePlacementStrategy = readWord("nodePlacementStrategy");
					const considerModelOrder = readWord("considerModelOrder");
					if (typeof mergeEdges === "boolean") elkConfig.mergeEdges = mergeEdges;
					if (typeof forceNodeModelOrder === "boolean")
						elkConfig.forceNodeModelOrder = forceNodeModelOrder;
					if (nodePlacementStrategy)
						elkConfig.nodePlacementStrategy = nodePlacementStrategy;
					if (considerModelOrder) elkConfig.considerModelOrder = considerModelOrder;
				}
				const initConfig = {
					flowchart: { defaultRenderer: desiredRenderer },
				};
				if (desiredRenderer === "elk" && Object.keys(elkConfig).length) {
					initConfig.elk = elkConfig;
				}
				const initDirective = `%%{init: ${JSON.stringify(initConfig)}}%%`;
				const hasDesiredRendererInit = new RegExp(
					`(^|\\n)\\s*%%\\{init:\\s*\\{[\\s\\S]*?defaultRenderer\\s*:\\s*["']?${desiredRenderer.replace(
						/[-/\\^$*+?.()|[\]{}]/g,
						"\\$&",
					)}["']?`,
					"i",
				).test(raw);
				const hasElkOptionsInit =
					desiredRenderer !== "elk"
						? true
						: /(^|\n)\s*%%\{init:\s*\{[\s\S]*?["']?elk["']?\s*:\s*\{[\s\S]*?(mergeEdges|nodePlacementStrategy|forceNodeModelOrder|considerModelOrder)\b/i.test(
								raw,
							);
				if (!hasDesiredRendererInit || !hasElkOptionsInit) {
					return `${raw.slice(0, declStart)}${initDirective}\n${raw.slice(declStart)}`;
				}
				return raw;
			};

			const installMermaidElkCompatForEditorPreview = () => {
				const mermaid = window.mermaid;
				if (!mermaid || mermaid.__cmsElkLayoutCompatInstalled) return;
				mermaid.__cmsElkLayoutCompatInstalled = true;
				const wrapTextArg = (fn, textIndex = 0) => {
					if (typeof fn !== "function") return fn;
					return function (...args) {
						if (args.length > textIndex) {
							args[textIndex] = normalizeMermaidTextForElk(args[textIndex]);
						}
						return fn.apply(this, args);
					};
				};
			mermaid.render = wrapTextArg(
				typeof mermaid.render === "function"
					? mermaid.render.bind(mermaid)
					: null,
				1,
			);
			mermaid.parse = wrapTextArg(
				typeof mermaid.parse === "function"
					? mermaid.parse.bind(mermaid)
					: null,
				0,
			);
			if (mermaid.mermaidAPI) {
				mermaid.mermaidAPI.render = wrapTextArg(
					typeof mermaid.mermaidAPI.render === "function"
						? mermaid.mermaidAPI.render.bind(mermaid.mermaidAPI)
						: null,
					1,
				);
				mermaid.mermaidAPI.parse = wrapTextArg(
					typeof mermaid.mermaidAPI.parse === "function"
						? mermaid.mermaidAPI.parse.bind(mermaid.mermaidAPI)
						: null,
					0,
				);
				mermaid.mermaidAPI.getDiagramFromText = wrapTextArg(
					typeof mermaid.mermaidAPI.getDiagramFromText === "function"
						? mermaid.mermaidAPI.getDiagramFromText.bind(mermaid.mermaidAPI)
						: null,
					0,
				);
			}
		};

		const getMermaidSources = () => {
			const blocks = Array.from(editor.querySelectorAll("pre code"));
			return blocks
				.map((codeEl) => ({
					codeEl,
					lang: getLangFromCodeEl(codeEl),
				}))
				.filter(({ lang }) => String(lang || "").toLowerCase() === "mermaid")
				.map(({ codeEl }) =>
					normalizeMermaidTextForElk(String(codeEl.textContent || "").trim()),
				);
		};

		const ensureMermaidReady = async () => {
			if (window.mermaid && window.mermaid.__cmsPreviewReady) return true;
			if (!window.mermaid) {
				if (!mermaidLoadPromise) {
					mermaidLoadPromise = new Promise((resolve) => {
						const script = document.createElement("script");
						script.src = `/assets/script/vendor/mermaid.min.js?v=${MERMAID_BUNDLE_VERSION}`;
						script.async = true;
						script.onload = () => resolve(true);
						script.onerror = () => resolve(false);
						document.head.appendChild(script);
					});
					window.__CMS_MERMAID_PREVIEW_PROMISE = mermaidLoadPromise;
				}
				await mermaidLoadPromise;
			}
			if (!window.mermaid) return false;
				window.mermaid.initialize({
					startOnLoad: false,
					theme: "neutral",
					suppressErrorRendering: true,
				});
			installMermaidWarningFilter();
			installMermaidElkCompatForEditorPreview();
			if (
				typeof window.mermaid.registerIconPacks === "function" &&
				!window.mermaid.__cmsPreviewIconsReady
			) {
				try {
					const emptyIconPack = { prefix: "logos", icons: {} };
					const loadIcons = async () => {
						try {
							const res = await fetch("/assets/icon-packs/logos.json");
							if (res.ok) return await res.json();
						} catch {
							return emptyIconPack;
						}
						return emptyIconPack;
					};
					const result = window.mermaid.registerIconPacks([
						{
							name: "logos",
							loader: loadIcons,
						},
					]);
					if (result && typeof result.then === "function") await result;
				} catch (err) {
					console.warn("Mermaid icon pack load failed:", err);
				}
				window.mermaid.__cmsPreviewIconsReady = true;
			}
			window.mermaid.__cmsPreviewReady = true;
			return true;
		};

		const renderMermaidPreview = async () => {
			const sources = getMermaidSources().filter(Boolean);
			if (!sources.length) {
				mermaidPreviewBody.innerHTML = "";
				mermaidPreviewEmpty.hidden = false;
				setMermaidPreviewVisible(false);
				return;
			}
			if (mermaidPreviewHidden) {
				mermaidPreviewEmpty.hidden = true;
				setMermaidPreviewVisible(false);
				return;
			}
			setMermaidPreviewVisible(true);
			mermaidPreviewEmpty.hidden = true;
			const ready = await ensureMermaidReady();
			if (!ready || !window.mermaid?.render) {
				mermaidPreviewBody.innerHTML =
					'<div class="cms-mermaid-preview__error">Mermaid is not available.</div>';
				return;
			}
			const token = (mermaidPreviewToken += 1);
			mermaidPreviewBody.innerHTML = "";
			for (let i = 0; i < sources.length; i += 1) {
				const text = sources[i];
				const target = document.createElement("div");
				target.className = "cms-mermaid-preview__diagram";
				mermaidPreviewBody.appendChild(target);
				const id = `cms-mermaid-preview-${BUILD_TOKEN}-${makeLocalId()}-${i}`;
				try {
					const result = await window.mermaid.render(id, text);
					if (token !== mermaidPreviewToken) return;
					const svg = typeof result === "string" ? result : result?.svg;
					target.innerHTML = svg || "";
					result?.bindFunctions?.(target);
				} catch (err) {
					target.innerHTML =
						'<div class="cms-mermaid-preview__error">Mermaid render failed.</div>';
				}
			}
		};

		const scheduleMermaidPreview = () => {
			if (mermaidPreviewTimer) clearTimeout(mermaidPreviewTimer);
			mermaidPreviewTimer = setTimeout(renderMermaidPreview, 250);
		};

		function refreshMermaidPreviewButtons() {
			editor
				.querySelectorAll(".cms-code-block-wrap")
				.forEach((wrap) => {
					const toolbar = wrap.querySelector(".cms-code-toolbar");
					const codeEl = wrap.querySelector("pre code");
					if (!toolbar || !codeEl) return;
					const lang = String(getLangFromCodeEl(codeEl) || "").toLowerCase();
					let previewBtn = toolbar.querySelector(
						".cms-code-toolbar__btn--mermaid-preview",
					);
					if (lang !== "mermaid") {
						if (previewBtn) previewBtn.hidden = true;
						return;
					}
					if (!previewBtn) {
						previewBtn = document.createElement("button");
						previewBtn.type = "button";
						previewBtn.className =
							"cms-code-toolbar__btn cms-code-toolbar__btn--mermaid-preview";
						previewBtn.addEventListener("click", (event) => {
							event.preventDefault();
							toggleMermaidPreview();
						});
						toolbar.appendChild(previewBtn);
					}
					previewBtn.hidden = false;
					previewBtn.textContent = mermaidPreviewHidden
						? "Show preview"
						: "Hide preview";
				});
		}

		editor.addEventListener("input", scheduleMermaidPreview);
		scheduleMermaidPreview();

		let activeImageTarget = null;
		let activeVideoTarget = null;
		let activeDocTarget = null;
		let modalCloseInterceptor = null;

		let currentInlineSize = "sml";
		let currentUploadFile = null;
		let currentUploadBase64 = "";
		let currentUploadMime = "";
		let currentUploadPath = "";
		let currentUploadExt = "";
		let setImageMode = null;

		const imgInput = el("input", {
			type: "text",
			class: "cms-field__input",
			placeholder: "/assets/img/...",
		});
		const imageModeSelect = el("select", { class: "cms-field__select" }, [
			el("option", { value: "existing" }, ["Use existing"]),
			el("option", { value: "upload" }, ["Upload new"]),
		]);
		imageModeSelect.value = "existing";
		const imageLibrarySelect = el("select", { class: "cms-field__select" }, [
			el("option", { value: "" }, ["Select an existing image"]),
		]);
		const imagePickBtn = el(
			"button",
			{
				class: "cms-btn cms-btn--primary cms-btn--inline",
				type: "button",
			},
			["Choose image"],
		);
		const uploadFileInput = el("input", {
			type: "file",
			class: "cms-field__input",
		});
		uploadFileInput.hidden = true;
		const uploadNameInput = el("input", {
			type: "text",
			class: "cms-field__input",
			placeholder: "Filename (e.g. hero.jpg or sub/hero.jpg)",
		});
		uploadNameInput.hidden = true;
		const uploadWarning = el(
			"div",
			{ class: "cms-modal__note cms-note--warning" },
			[
				"\u26a0 Please note: Uploaded images are only stored in local memory until comitted and could be lost \u26a0",
			],
		);
		uploadWarning.hidden = true;
		const getFileExtension = (name) => {
			const match = String(name || "")
				.trim()
				.match(/(\.[A-Za-z0-9]+)$/);
			return match ? match[1] : "";
		};
		const normalizeUploadName = (rawName) => {
			const raw = String(rawName || "").trim();
			if (!raw) {
				if (currentUploadExt)
					return { name: currentUploadExt, caret: 0, empty: true };
				return { name: "", caret: 0, empty: true };
			}
			if (!currentUploadExt) return { name: raw, caret: raw.length };
			const lowerRaw = raw.toLowerCase();
			const lowerExt = currentUploadExt.toLowerCase();
			let base = raw;
			if (lowerRaw.endsWith(lowerExt)) {
				base = raw.slice(0, -currentUploadExt.length);
			}
			if (base.endsWith(".")) base = base.slice(0, -1);
			return {
				name: `${base}${currentUploadExt}`,
				caret: base.length,
				empty: !base,
			};
		};
		const syncUploadName = (rawName, { normalize = false } = {}) => {
			const normalized = normalizeUploadName(rawName);
			if (!normalized.name) return;
			if (normalized.empty && currentUploadExt) {
				if (normalize && uploadNameInput) {
					uploadNameInput.value = currentUploadExt;
					if (document.activeElement === uploadNameInput) {
						uploadNameInput.setSelectionRange(0, 0);
					}
				}
				return;
			}
			const safePath = sanitizeImagePath(
				normalized.name,
				currentUploadFile?.name || "",
			);
			if (!safePath) return;
			const safeName = safePath.replace(/^assets\/img\//, "");
			if (normalize && uploadNameInput) {
				uploadNameInput.value = safeName;
				if (currentUploadExt && document.activeElement === uploadNameInput) {
					const caret = Math.max(0, safeName.length - currentUploadExt.length);
					uploadNameInput.setSelectionRange(caret, caret);
				}
			}
			imgInput.value = `/${safePath}`;
			if (currentUploadBase64) {
				if (currentUploadPath && currentUploadPath !== safePath) {
					state.assetUploads = (state.assetUploads || []).filter(
						(item) => item.path !== currentUploadPath,
					);
				}
				addAssetUpload({
					name: safeName,
					content: currentUploadBase64,
					path: safePath,
					mime: currentUploadMime || "",
				});
				currentUploadPath = safePath;
			}
			updateImagePreview();
		};
		const stageUpload = (file, filename) => {
			if (!file) return;
			const safePath = sanitizeImagePath(filename, file.name || "");
			if (!safePath) return;
			const safeName = safePath.replace(/^assets\/img\//, "");
			if (uploadNameInput) uploadNameInput.value = safeName;
			const reader = new FileReader();
			reader.onload = () => {
				const dataUrl = String(reader.result || "");
				const base64 = dataUrl.split(",")[1] || "";
				currentUploadBase64 = base64;
				currentUploadMime = file.type || "";
				syncUploadName(uploadNameInput?.value.trim() || safeName, {
					normalize: true,
				});
			};
			reader.readAsDataURL(file);
		};
		imagePickBtn.addEventListener("click", () => {
			uploadFileInput?.click();
		});
		uploadFileInput.addEventListener("change", () => {
			const file = uploadFileInput.files?.[0];
			if (!file) return;
			currentUploadFile = file;
			currentUploadExt = getFileExtension(file.name || "");
			if (uploadNameInput && !uploadNameInput.value.trim()) {
				uploadNameInput.value = file.name || "";
			}
			stageUpload(file, uploadNameInput?.value.trim() || "");
		});
		uploadNameInput.addEventListener("input", () => {
			syncUploadName(uploadNameInput.value.trim(), { normalize: true });
		});
		uploadNameInput.addEventListener("blur", () => {
			if (!currentUploadFile) return;
			if (currentUploadBase64) {
				syncUploadName(uploadNameInput.value.trim(), { normalize: true });
				return;
			}
			stageUpload(currentUploadFile, uploadNameInput.value.trim());
		});
		setImageMode = (mode) => {
			const useUpload = mode === "upload";
			if (imageLibrarySelect) imageLibrarySelect.hidden = useUpload;
			if (imagePickBtn) imagePickBtn.hidden = !useUpload;
			if (uploadNameInput) uploadNameInput.hidden = !useUpload;
			if (uploadNameLabel) uploadNameLabel.hidden = !useUpload;
			if (uploadNameRow) uploadNameRow.hidden = !useUpload;
			if (imgInput) {
				imgInput.disabled = useUpload;
				imgInput.classList.toggle("cms-field__input--muted", useUpload);
			}
			if (uploadWarning) uploadWarning.hidden = !useUpload;
			if (!useUpload && imageLibrarySelect) {
				loadImageLibraryIntoSelect(imageLibrarySelect)
					.then(() => {
						const local = getLocalAssetPath(imgInput.value || "");
						if (local) imageLibrarySelect.value = local;
					})
					.catch((err) => console.error(err));
			}
			updateImagePreview();
		};
		imageModeSelect.addEventListener("change", () => {
			setImageMode(imageModeSelect.value);
		});
		imageLibrarySelect.addEventListener("change", () => {
			const path = imageLibrarySelect.value;
			if (!path) return;
			const safePath = sanitizeImagePath(path, "");
			if (!safePath) return;
			imgInput.value = `/${safePath}`;
			updateImagePreview();
		});
		const imagePreviewImg = el("img", {
			class: "cms-image-preview__img cms-image-preview__img--block",
			alt: "Preview",
		});
		const imagePreviewWrap = el(
			"div",
			{
				class:
					"cms-image-preview cms-image-preview--inline content content--full",
			},
			[imagePreviewImg],
		);
		const overlayLayer = el("div", { class: "content-overlay" });
		const overlayTitlePreview = el("h3", { class: "content-title" });
		const overlayTextPreview = el("p", { class: "content-text" });
		const overlayDetails = el(
			"div",
			{ class: "content-details fadeIn-bottom" },
			[overlayTitlePreview, overlayTextPreview],
		);
		imagePreviewWrap.appendChild(overlayLayer);
		imagePreviewWrap.appendChild(overlayDetails);
		const updateImagePreview = () => {
			const raw = imgInput.value.trim();
			let src = raw ? normalizeImageSource(raw) : "";
			if (src && !src.startsWith("data:")) {
				const local = getLocalAssetPath(src);
				const cached = local ? getCachedAssetDataUrl(local) : "";
				if (cached) src = cached;
			}
			if (!src) {
				imagePreviewWrap.hidden = true;
				imagePreviewImg.removeAttribute("src");
				updateOverlayPreview();
				return;
			}
			imagePreviewWrap.hidden = false;
			imagePreviewImg.src = src;
			if (imageLibrarySelect && !imageLibrarySelect.hidden) {
				const local = getLocalAssetPath(raw);
				if (local) imageLibrarySelect.value = local;
			}
			updateOverlayPreview();
		};
		imgInput.addEventListener("input", updateImagePreview);
		imgInput.addEventListener("blur", () => {
			const normalized = normalizeImageSource(imgInput.value);
			if (normalized) imgInput.value = normalized;
			updateImagePreview();
		});
		const captionInput = el("input", {
			type: "text",
			class: "cms-field__input",
			placeholder: "Optional caption",
		});
		const overlayEnabledInput = el("input", {
			type: "checkbox",
			class: "cms-field__checkbox",
		});
		overlayEnabledInput.checked = true;
		const overlayTitleInput = el("input", {
			type: "text",
			class: "cms-field__input",
			placeholder: "Overlay title (optional)",
		});
		const overlayTextInput = el("input", {
			type: "text",
			class: "cms-field__input",
			placeholder: "Overlay text (optional)",
		});
		const lightboxInput = el("input", {
			type: "checkbox",
			class: "cms-field__checkbox",
		});
		lightboxInput.checked = true;
		const scaleSelect = el("select", { class: "cms-field__select" }, [
			el("option", { value: "auto" }, ["Auto"]),
			el("option", { value: "sm" }, ["Small"]),
			el("option", { value: "md" }, ["Medium"]),
			el("option", { value: "lg" }, ["Large"]),
			el("option", { value: "full" }, ["Full"]),
		]);
		const applyScalePreview = () => {
			const img = imagePreviewImg;
			if (!img) return;
			img.classList.remove(
				"cms-image-preview__img--sm",
				"cms-image-preview__img--md",
				"cms-image-preview__img--lg",
				"cms-image-preview__img--full",
			);
			const value = (scaleSelect.value || "").trim().toLowerCase();
			if (value && value !== "auto") {
				img.classList.add(`cms-image-preview__img--${value}`);
			}
		};
		scaleSelect.addEventListener("change", applyScalePreview);
		const updateOverlayPreview = () => {
			const enabled = overlayEnabledInput.checked;
			if (!enabled || imagePreviewWrap.hidden) {
				overlayLayer.hidden = true;
				overlayDetails.hidden = true;
				overlayTitlePreview.textContent = "";
				overlayTextPreview.textContent = "";
				return;
			}
			const title = overlayTitleInput.value.trim();
			const text = overlayTextInput.value.trim();
			const fallback =
				!title && !text && lightboxInput.checked ? "Click to view" : text;
			overlayLayer.hidden = false;
			overlayDetails.hidden = false;
			overlayTitlePreview.textContent = title;
			overlayTextPreview.textContent = fallback;
			overlayTitlePreview.hidden = !title;
			overlayTextPreview.hidden = !fallback;
		};
		lightboxInput.addEventListener("change", updateOverlayPreview);
		overlayTitleInput.addEventListener("input", updateOverlayPreview);
		overlayTextInput.addEventListener("input", updateOverlayPreview);
		updateImagePreview();

		const imageRow = el("div", { class: "cms-field__row" }, [
			imgInput,
			imageModeSelect,
			imageLibrarySelect,
			imagePickBtn,
			uploadFileInput,
		]);
		let uploadNameLabel = null;
		let uploadNameRow = null;
		let imageInput = imageRow;
		if (uploadNameInput) {
			uploadNameLabel = el("div", { class: "cms-field__label" }, ["Filename"]);
			uploadNameRow = el("div", { class: "cms-field__row" }, [uploadNameInput]);
			uploadNameRow.hidden = uploadNameInput.hidden;
			uploadNameLabel.hidden = uploadNameInput.hidden;
			imageInput = el("div", { class: "cms-field__stack" }, [
				imageRow,
				uploadNameLabel,
				uploadNameRow,
			]);
		}
		const overlayInputs = el("div", { class: "cms-field__stack" }, [
			overlayTitleInput,
			overlayTextInput,
		]);
		const overlayGroup = buildField({ label: "Overlay", input: overlayInputs });
		const displayRow = el("div", { class: "cms-field__row" }, [
			el("label", { class: "cms-field__toggle" }, [
				lightboxInput,
				el("span", { class: "cms-field__toggle-text" }, ["Lightbox"]),
			]),
			el("label", { class: "cms-field__toggle" }, [
				overlayEnabledInput,
				el("span", { class: "cms-field__toggle-text" }, ["Overlay"]),
			]),
		]);
		const displayField = buildField({ label: "Display", input: displayRow });
		const captionField = buildField({ label: "Caption", input: captionInput });
		const sizeField = buildField({ label: "Size", input: scaleSelect });
		const controlsWrap = el("div", { class: "cms-image-settings__controls" }, [
			displayField,
			captionField,
			sizeField,
			overlayGroup,
		]);
		const settingsRow = el("div", { class: "cms-image-settings" }, [
			el("div", { class: "cms-image-settings__preview" }, [imagePreviewWrap]),
			controlsWrap,
		]);
		const imageSaveBtn = el(
			"button",
			{ class: "cms-btn cms-btn--success", type: "button" },
			["Insert image"],
		);
		const imageDeleteBtn = el(
			"button",
			{ class: "cms-btn cms-btn--danger", type: "button" },
			["Delete"],
		);
		const imagePanel = el(
			"div",
			{ class: "cms-rte__panel cms-rte__panel--image" },
			[
				buildField({
					label: "Image source",
					input: imageInput,
					note: "Required for inline images.",
				}),
				uploadWarning,
				buildField({ label: "Image settings", input: settingsRow }),
				el("div", { class: "cms-rte__panel-actions" }, [
					imageDeleteBtn,
					imageSaveBtn,
				]),
			],
		);
		imagePanel.hidden = true;

		const videoInput = el("input", {
			type: "text",
			class: "cms-field__input",
			placeholder: "https://youtu.be/...",
		});
		const videoCaptionInput = el("input", {
			type: "text",
			class: "cms-field__input",
			placeholder: "Caption (required)",
		});
		const videoScaleSelect = el("select", { class: "cms-field__select" }, [
			el("option", { value: "auto" }, ["Auto"]),
			el("option", { value: "sm" }, ["Small"]),
			el("option", { value: "md" }, ["Medium"]),
			el("option", { value: "lg" }, ["Large"]),
			el("option", { value: "full" }, ["Full"]),
		]);
		const videoWarning = el(
			"div",
			{ class: "cms-modal__note cms-note--warning" },
			[
				"\u26a0 Videos must be YouTube links only. Uploading is disabled. \u26a0",
			],
		);
		const videoSourceRow = el("div", { class: "cms-field__row" }, [videoInput]);
		const videoPlaceholder = el("div", { class: "cms-video-placeholder" }, [
			"YouTube preview disabled",
		]);
		const videoPreviewCard = el(
			"div",
			{ class: "cms-video-preview content content--full" },
			[videoPlaceholder],
		);
		const videoSettingsRow = el("div", { class: "cms-image-settings" }, [
			el("div", { class: "cms-image-settings__preview" }, [videoPreviewCard]),
			el("div", { class: "cms-image-settings__controls" }, [
				buildField({
					label: "Caption",
					input: videoCaptionInput,
					note: "Required for inline videos.",
				}),
				buildField({ label: "Size", input: videoScaleSelect }),
			]),
		]);
		const videoSaveBtn = el(
			"button",
			{ class: "cms-btn cms-btn--success", type: "button" },
			["Insert video"],
		);
		const videoDeleteBtn = el(
			"button",
			{ class: "cms-btn cms-btn--danger", type: "button" },
			["Delete"],
		);
		const videoPanel = el(
			"div",
			{ class: "cms-rte__panel cms-rte__panel--video" },
			[
				buildField({
					label: "Video source",
					input: videoSourceRow,
					note: "YouTube links only.",
				}),
				videoWarning,
				buildField({ label: "Video settings", input: videoSettingsRow }),
				el("div", { class: "cms-rte__panel-actions" }, [
					videoDeleteBtn,
					videoSaveBtn,
				]),
			],
		);
		videoPanel.hidden = true;

		const docHrefInput = el("input", {
			type: "text",
			class: "cms-field__input",
			placeholder: "/assets/docs/...",
		});
		docHrefInput.disabled = true;
		docHrefInput.classList.add("cms-field__input--muted");
		const docLibrarySelect = el("select", { class: "cms-field__select" }, [
			el("option", { value: "" }, ["Select a document"]),
		]);
		const docTitleInput = el("input", {
			type: "text",
			class: "cms-field__input",
			placeholder: "Document title (required)",
		});
		const docDescInput = el("input", {
			type: "text",
			class: "cms-field__input",
			placeholder: "Optional description",
		});
		const docPreviewIcon = el(
			"span",
			{ class: "material-icons doc-card__type-icon", "aria-hidden": "true" },
			["insert_drive_file"],
		);
		const docPreviewTitle = el("div", { class: "doc-card__title" }, [
			"Document title",
		]);
		const docPreviewDesc = el("div", { class: "doc-card__desc" }, [
			"Document description.",
		]);
		const docPreviewText = el("div", { class: "doc-card__text" }, [
			docPreviewTitle,
			docPreviewDesc,
		]);
		const docPreviewOverlayLabel = el(
			"span",
			{ class: "doc-card__overlay-label" },
			["Open document"],
		);
		const docPreviewOverlay = el("div", { class: "doc-card__overlay" }, [
			el("div", { class: "doc-card__overlay-content" }, [
				el("span", { class: "material-icons", "aria-hidden": "true" }, [
					"open_in_new",
				]),
				docPreviewOverlayLabel,
			]),
		]);
		const docPreviewLink = el(
			"a",
			{
				class: "doc-card__link",
				href: "#",
				target: "_blank",
				rel: "noopener noreferrer",
				"data-doc-open": "true",
			},
			[docPreviewIcon, docPreviewText, docPreviewOverlay],
		);
		docPreviewLink.addEventListener("click", (event) => event.preventDefault());
		const docPreviewCard = el(
			"div",
			{ class: "doc-card doc-card--compact cms-doc-preview" },
			[docPreviewLink],
		);
		const docEmbedPreviewIcon = el(
			"span",
			{
				class: "material-icons cms-doc-embed__icon",
				"aria-hidden": "true",
			},
			["insert_drive_file"],
		);
		const docEmbedPreviewTitle = el(
			"div",
			{ class: "cms-doc-embed__title" },
			["Document embed"],
		);
		const docEmbedPreviewMeta = el(
			"div",
			{ class: "cms-doc-embed__meta" },
			["Inline iframe preview"],
		);
		const docEmbedPreviewText = el(
			"div",
			{ class: "cms-doc-embed__text" },
			[docEmbedPreviewTitle, docEmbedPreviewMeta],
		);
		const docPreviewEmbed = el(
			"div",
			{ class: "cms-doc-embed-preview" },
			[docEmbedPreviewIcon, docEmbedPreviewText],
		);
		docPreviewEmbed.hidden = true;
		const docPreviewWrap = el("div", { class: "cms-image-settings__preview" }, [
			docPreviewCard,
			docPreviewEmbed,
		]);
		const docLinkRow = el("div", { class: "cms-field__row" }, [
			docHrefInput,
			docLibrarySelect,
		]);
		const docDisplaySelect = el(
			"select",
			{ class: "cms-field__select" },
			[
				el("option", { value: "card" }, ["Doc card"]),
				el("option", { value: "embed" }, ["Inline embed"]),
			],
		);
		docDisplaySelect.value = "card";
		const docSettingsWrap = el(
			"div",
			{ class: "cms-image-settings__controls" },
			[
				buildField({
					label: "Document",
					input: docLinkRow,
					note: "Choose from /assets/docs.",
				}),
				buildField({ label: "Title", input: docTitleInput }),
				buildField({ label: "Description", input: docDescInput }),
				buildField({ label: "Display", input: docDisplaySelect }),
			],
		);
		const docSettingsRow = el("div", { class: "cms-image-settings" }, [
			docPreviewWrap,
			docSettingsWrap,
		]);
		const docSaveBtn = el(
			"button",
			{ class: "cms-btn cms-btn--success", type: "button" },
			["Insert document"],
		);
		const docDeleteBtn = el(
			"button",
			{ class: "cms-btn cms-btn--danger", type: "button" },
			["Delete"],
		);
		const docPanel = el(
			"div",
			{ class: "cms-rte__panel cms-rte__panel--doc" },
			[
				buildField({ label: "Document", input: docSettingsRow }),
				el("div", { class: "cms-rte__panel-actions" }, [
					docDeleteBtn,
					docSaveBtn,
				]),
			],
		);
		docPanel.hidden = true;

		const linkHrefInput = el("input", {
			type: "text",
			class: "cms-field__input",
			placeholder: "/path or https://example.com",
		});
		const linkTextInput = el("input", {
			type: "text",
			class: "cms-field__input",
			placeholder: "Link text",
		});
		const linkSaveBtn = el(
			"button",
			{ class: "cms-btn cms-btn--success", type: "button" },
			["Insert link"],
		);
		const linkRemoveBtn = el(
			"button",
			{ class: "cms-btn cms-btn--danger", type: "button" },
			["Remove link"],
		);
		const linkPanel = el(
			"div",
			{ class: "cms-rte__panel cms-rte__panel--link" },
			[
				buildField({
					label: "Link",
					input: el("div", { class: "cms-field__stack" }, [
						linkHrefInput,
						linkTextInput,
					]),
					note: "Use /relative paths or https:// URLs.",
				}),
				el("div", { class: "cms-rte__panel-actions" }, [
					linkRemoveBtn,
					linkSaveBtn,
				]),
			],
		);
		linkPanel.hidden = true;
		let activeLinkTarget = null;

		const getLinkFromSelection = () => {
			const selection = window.getSelection();
			if (!selection || selection.rangeCount === 0) return null;
			let node = selection.getRangeAt(0).commonAncestorContainer;
			if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
			const link = node?.closest ? node.closest("a") : null;
			if (link && editor.contains(link)) return link;
			return null;
		};

		const closeLinkPanel = () => {
			linkPanel.hidden = true;
			activeLinkTarget = null;
			linkHrefInput.value = "";
			linkTextInput.value = "";
			linkHrefInput.classList.remove("cms-field__input--invalid");
			linkSaveBtn.textContent = "Insert link";
			linkRemoveBtn.disabled = true;
			if (!imagePanel.hidden || !videoPanel.hidden || !docPanel.hidden) return;
			detachModalCloseInterceptor();
			updateExitButtonLabel();
		};

		const openLinkPanel = ({ targetLink = null } = {}) => {
			saveSelection();
			if (!imagePanel.hidden) closeImagePanel();
			if (!videoPanel.hidden) closeVideoPanel();
			if (!docPanel.hidden) closeDocPanel();

			const selection = window.getSelection();
			const selectedText =
				selection && !selection.isCollapsed ? selection.toString() : "";
			const link = targetLink || getLinkFromSelection();
			activeLinkTarget = link;
			linkHrefInput.value = link?.getAttribute("href") || "";
			linkTextInput.value =
				link?.textContent?.trim() || selectedText || "";
			linkSaveBtn.textContent = link ? "Update link" : "Insert link";
			linkRemoveBtn.disabled = !link;
			linkHrefInput.classList.remove("cms-field__input--invalid");
			linkPanel.hidden = false;
			attachModalCloseInterceptor();
			updateExitButtonLabel();
			linkPanel.scrollIntoView({ block: "center", behavior: "smooth" });
		};

		const normalizeDocHref = (value) => {
			return normalizeDocPath(value);
		};

		const getDocExtFromHref = (value) => {
			const raw = String(value || "").trim();
			if (!raw) return "";
			const clean = raw.split("?")[0].split("#")[0];
			const parts = clean.split(".");
			return parts.length > 1 ? parts.pop().toLowerCase() : "";
		};

		const resolveDocIcon = (ext) => {
			const map = [
				{ exts: ["pdf"], icon: "picture_as_pdf" },
				{ exts: ["doc", "docx"], icon: "description" },
				{ exts: ["xls", "xlsx", "csv"], icon: "table_chart" },
				{ exts: ["ppt", "pptx"], icon: "slideshow" },
				{ exts: ["md", "txt", "rtf"], icon: "code" },
				{ exts: ["zip", "rar", "7z"], icon: "archive" },
			];
			for (const entry of map) {
				if (entry.exts.includes(ext)) return entry.icon;
			}
			return "insert_drive_file";
		};

		const updateDocPreview = () => {
			const title = docTitleInput.value.trim();
			const desc = docDescInput.value.trim();
			const href = normalizeDocHref(docHrefInput.value.trim());
			const safeHref = sanitizeHref(href);
			const isEmbed = docDisplaySelect.value === "embed";
			docPreviewTitle.textContent = title || "Document title";
			docPreviewDesc.textContent = desc || "Document description.";
			docPreviewLink.setAttribute("href", safeHref || "#");
			const ext = getDocExtFromHref(safeHref);
			const icon = resolveDocIcon(ext);
			docPreviewIcon.textContent = icon;
			docPreviewCard.dataset.docExt = ext || "";
			docPreviewOverlayLabel.textContent =
				ext === "pdf" ? "Open PDF" : "Open document";
			docPreviewCard.hidden = isEmbed;
			docPreviewEmbed.hidden = !isEmbed;
			docEmbedPreviewIcon.textContent = icon;
			docEmbedPreviewTitle.textContent = title || "Document embed";
			docEmbedPreviewMeta.textContent =
				desc || safeHref || "Inline iframe preview";
			docPreviewEmbed.dataset.docExt = ext || "";
			docTitleInput.placeholder = isEmbed
				? "Document title (optional)"
				: "Document title (required)";
			docSaveBtn.textContent = activeDocTarget
				? isEmbed
					? "Update embed"
					: "Update document"
				: isEmbed
					? "Insert embed"
					: "Insert document";
		};

		docLibrarySelect.addEventListener("change", () => {
			const path = docLibrarySelect.value;
			docLibrarySelect.classList.remove("cms-field__input--invalid");
			if (!path) return;
			docHrefInput.value = `/${path}`;
			updateDocPreview();
		});
		docTitleInput.addEventListener("input", () => {
			docTitleInput.classList.remove("cms-field__input--invalid");
			updateDocPreview();
		});
		docDescInput.addEventListener("input", updateDocPreview);
		docDisplaySelect.addEventListener("change", () => {
			docTitleInput.classList.remove("cms-field__input--invalid");
			updateDocPreview();
		});
		updateDocPreview();

		const syncOverlayState = () => {
			const enabled = overlayEnabledInput.checked;
			overlayTitleInput.disabled = !enabled;
			overlayTextInput.disabled = !enabled;
			if (overlayGroup) overlayGroup.hidden = !enabled;
			updateOverlayPreview();
		};
		syncOverlayState();
		overlayEnabledInput.addEventListener("change", syncOverlayState);
		setImageMode(imageModeSelect.value);

		const updateVideoPreview = () => {
			const raw = videoInput.value.trim();
			videoPlaceholder.textContent = raw
				? "YouTube preview disabled"
				: "No video selected";
		};
		videoInput.addEventListener("input", () => {
			videoInput.classList.remove("cms-field__input--invalid");
			videoCaptionInput.classList.remove("cms-field__input--invalid");
			updateVideoPreview();
		});
		videoInput.addEventListener("blur", () => {
			const normalized = normalizeVideoSource(videoInput.value);
			if (normalized) videoInput.value = normalized;
			updateVideoPreview();
		});
		videoCaptionInput.addEventListener("input", () => {
			videoCaptionInput.classList.remove("cms-field__input--invalid");
		});

		const toolbarNodes = toolbarController ? [] : [toolbar];
		const wrap = el("div", { class: "cms-rte__field" }, [
			el("div", { class: "cms-rte__label" }, [label]),
			...toolbarNodes,
			editorRow,
			imagePanel,
			videoPanel,
			docPanel,
			linkPanel,
		]);

		const attachModalCloseInterceptor = () => {
			const root = qs("#cms-modal");
			if (!root || modalCloseInterceptor) return;
			modalCloseInterceptor = (event) => {
				if (
					imagePanel.hidden &&
					videoPanel.hidden &&
					docPanel.hidden &&
					linkPanel.hidden
				)
					return;
				event.preventDefault();
				event.stopImmediatePropagation();
				const assetTarget = !imagePanel.hidden
					? activeImageTarget
					: !videoPanel.hidden
						? activeVideoTarget
						: !docPanel.hidden
							? activeDocTarget
							: activeLinkTarget;
				if (!imagePanel.hidden) closeImagePanel();
				if (!videoPanel.hidden) closeVideoPanel();
				if (!docPanel.hidden) closeDocPanel();
				if (!linkPanel.hidden) closeLinkPanel();
				if (assetTarget && assetTarget.scrollIntoView) {
					queueMicrotask(() => {
						assetTarget.scrollIntoView({
							block: "center",
							behavior: "smooth",
						});
					});
				}
			};
			root.querySelectorAll("[data-close='true']").forEach((btn) => {
				btn.addEventListener("click", modalCloseInterceptor, true);
			});
		};

		const detachModalCloseInterceptor = () => {
			const root = qs("#cms-modal");
			if (!root || !modalCloseInterceptor) return;
			root.querySelectorAll("[data-close='true']").forEach((btn) => {
				btn.removeEventListener("click", modalCloseInterceptor, true);
			});
			modalCloseInterceptor = null;
		};

		const openInlineDeleteConfirm = ({ onConfirm }) => {
			const root = qs("#cms-modal");
			const hadModal = Boolean(root && root.classList.contains("is-open"));
			if (hadModal && root) {
				const existing = root.querySelector(".cms-modal__confirm");
				if (existing) existing.remove();
				let overlay = null;
				const closeConfirm = () => {
					if (overlay) overlay.remove();
				};
				const cancel = el(
					"button",
					{
						class: "cms-btn cms-btn--move cms-modal__action",
						type: "button",
					},
					["Cancel"],
				);
				const confirm = el(
					"button",
					{
						class: "cms-btn cms-modal__action cms-btn--danger",
						type: "button",
					},
					["Delete"],
				);
				cancel.addEventListener("click", (event) => {
					event.preventDefault();
					closeConfirm();
				});
				confirm.addEventListener("click", (event) => {
					event.preventDefault();
					closeConfirm();
					if (typeof onConfirm === "function") onConfirm();
				});
				const panel = el("div", { class: "cms-modal__confirm-panel" }, [
					el("h3", { class: "cms-modal__confirm-title" }, ["Delete item"]),
					el("p", { class: "cms-modal__text" }, [
						"Delete this item? Unsaved changes will be lost if you continue.",
					]),
					el("div", { class: "cms-modal__confirm-actions" }, [cancel, confirm]),
				]);
				overlay = el("div", { class: "cms-modal__confirm" }, [panel]);
				overlay.addEventListener("click", (event) => {
					if (event.target !== overlay) return;
					closeConfirm();
				});
				root.appendChild(overlay);
				return;
			}

			detachModalCloseInterceptor();

			const cancel = el(
				"button",
				{
					class: "cms-btn cms-btn--move cms-modal__action",
					type: "button",
					"data-close": "true",
				},
				["Cancel"],
			);
			const confirm = el(
				"button",
				{
					class: "cms-btn cms-modal__action cms-btn--danger",
					type: "button",
				},
				["Delete"],
			);
			confirm.addEventListener("click", () => {
				closeModal();
				if (typeof onConfirm === "function") onConfirm();
			});

			openModal({
				title: "Delete media",
				bodyNodes: [
					el("p", { class: "cms-modal__text" }, [
						"Delete this item? Unsaved changes will be lost if you continue.",
					]),
				],
				footerNodes: [cancel, confirm],
				onClose: closeModal,
			});
		};

		const renderInlineImageStub = (stub) => {
			if (!(stub instanceof HTMLElement)) return;
			const rawSrc = stub.getAttribute("data-img") || "";
			const imgSrc = rawSrc ? normalizeImageSource(rawSrc) : "";
			const caption = stub.getAttribute("data-caption") || "";
			const lightbox =
				normalizeBool(stub.getAttribute("data-lightbox"), "false") === "true";
			const overlayEnabled = stub.getAttribute("data-overlay") !== "false";
			const overlayTitle = stub.getAttribute("data-overlay-title") || "";
			const overlayText = stub.getAttribute("data-overlay-text") || "";
			const scale = (stub.getAttribute("data-scale") || "")
				.trim()
				.toLowerCase();
			const size = (stub.getAttribute("data-size") || "sml")
				.trim()
				.toLowerCase();
			const sizeClass =
				size === "lrg" ? "lrg-img-text-div-img" : "img-text-div-img";

			let previewSrc = imgSrc;
			if (previewSrc && !previewSrc.startsWith("data:")) {
				const local = getLocalAssetPath(previewSrc);
				const cached = local ? getCachedAssetDataUrl(local) : "";
				if (cached) previewSrc = cached;
			}

			stub.classList.remove(
				"img-text-div-img",
				"lrg-img-text-div-img",
				"img-scale-sm",
				"img-scale-md",
				"img-scale-lg",
				"img-scale-full",
			);
			stub.classList.add("img-stub", sizeClass);
			if (scale && scale !== "auto") stub.classList.add(`img-scale-${scale}`);

			stub.innerHTML = "";
			const content = el("div", { class: "content content--full" }, []);
			if (previewSrc) {
				const img = document.createElement("img");
				img.className = "content-image";
				img.src = previewSrc;
				img.alt = caption || overlayTitle || "Image";

				let titleText = (overlayTitle || "").trim();
				let bodyText = (overlayText || "").trim();
				if (overlayEnabled && !titleText && !bodyText && lightbox) {
					bodyText = "Click to view";
				}
				if (overlayEnabled) {
					const overlay = el("div", { class: "content-overlay" });
					const details = el(
						"div",
						{ class: "content-details fadeIn-bottom" },
						[],
					);
					if (titleText) {
						const h3 = document.createElement("h3");
						h3.className = "content-title";
						h3.textContent = titleText;
						details.appendChild(h3);
					}
					if (bodyText) {
						const p = document.createElement("p");
						p.className = "content-text";
						p.textContent = bodyText;
						details.appendChild(p);
					}
					content.appendChild(overlay);
					content.appendChild(img);
					if (titleText || bodyText) content.appendChild(details);
				} else {
					content.appendChild(img);
				}
			}
			stub.appendChild(content);
			if (caption) {
				stub.appendChild(el("p", { class: "cms-inline-caption" }, [caption]));
			}

			const editBtn = el(
				"button",
				{
					type: "button",
					class: "cms-block__btn cms-block__btn--edit cms-inline-action",
				},
				[buildPenIcon(), "Edit"],
			);
			editBtn.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				openImagePanel({ targetStub: stub });
			});
			const deleteBtn = el(
				"button",
				{
					type: "button",
					class: "cms-block__btn cms-block__btn--danger cms-inline-action",
				},
				[buildTrashIcon(), "Delete"],
			);
			deleteBtn.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				openInlineDeleteConfirm({
					onConfirm: () => {
						if (activeImageTarget === stub) closeImagePanel();
						stub.remove();
					},
				});
			});
			const actions = el("div", { class: "cms-inline-actions" }, [
				editBtn,
				deleteBtn,
			]);
			stub.appendChild(actions);
		};

		const renderInlineImageStubs = () => {
			editor.querySelectorAll(".img-stub").forEach((stub) => {
				renderInlineImageStub(stub);
			});
		};

		const renderInlineVideoStub = (stub) => {
			if (!(stub instanceof HTMLElement)) return;
			const rawSrc = stub.getAttribute("data-video") || "";
			const caption = stub.getAttribute("data-caption") || "";
			const videoSrc = rawSrc ? normalizeVideoSource(rawSrc) : "";
			const scale = (stub.getAttribute("data-scale") || "")
				.trim()
				.toLowerCase();

			stub.classList.remove("img-text-div-img", "lrg-img-text-div-img");
			stub.classList.add("video-stub", "img-text-div-img");
			stub.classList.remove(
				"img-scale-sm",
				"img-scale-md",
				"img-scale-lg",
				"img-scale-full",
			);
			if (scale && scale !== "auto") stub.classList.add(`img-scale-${scale}`);
			stub.innerHTML = "";

			const content = el("div", { class: "content content--full" }, []);
			const placeholder = el("div", { class: "cms-video-placeholder" }, [
				videoSrc ? "YouTube preview disabled" : "No video selected",
			]);
			content.appendChild(placeholder);
			stub.appendChild(content);

			if (caption) {
				stub.appendChild(el("p", { class: "cms-inline-caption" }, [caption]));
			}

			const editBtn = el(
				"button",
				{
					type: "button",
					class: "cms-block__btn cms-block__btn--edit cms-inline-action",
				},
				[buildPenIcon(), "Edit"],
			);
			editBtn.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				openVideoPanel({ targetStub: stub });
			});
			const deleteBtn = el(
				"button",
				{
					type: "button",
					class: "cms-block__btn cms-block__btn--danger cms-inline-action",
				},
				[buildTrashIcon(), "Delete"],
			);
			deleteBtn.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				openInlineDeleteConfirm({
					onConfirm: () => {
						if (activeVideoTarget === stub) closeVideoPanel();
						stub.remove();
					},
				});
			});
			const actions = el("div", { class: "cms-inline-actions" }, [
				editBtn,
				deleteBtn,
			]);
			stub.appendChild(actions);
		};

		const renderInlineVideoStubs = () => {
			editor.querySelectorAll(".video-stub").forEach((stub) => {
				renderInlineVideoStub(stub);
			});
		};

		const renderInlineDocEmbeds = () => {
			editor.querySelectorAll(".doc-embed").forEach((stub) => {
				if (!(stub instanceof HTMLElement)) return;
				const attrs = {
					href: stub.getAttribute("data-doc") || "",
					title: stub.getAttribute("data-title") || "",
					desc: stub.getAttribute("data-desc") || "",
				};
				renderDocEmbedStub(stub, attrs);
			});
		};

		const renderDocCardActions = () => {
			editor.querySelectorAll(".doc-card").forEach((card) => {
				if (!(card instanceof HTMLElement)) return;
				if (card.classList.contains("cms-doc-preview")) return;
				if (card.querySelector(":scope > .cms-inline-actions")) return;
				const editBtn = el(
					"button",
					{
						type: "button",
						class: "cms-block__btn cms-block__btn--edit cms-inline-action",
					},
					[buildPenIcon(), "Edit"],
				);
				editBtn.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					openDocPanel({ targetDoc: card });
				});
				const deleteBtn = el(
					"button",
					{
						type: "button",
						class: "cms-block__btn cms-block__btn--danger cms-inline-action",
					},
					[buildTrashIcon(), "Delete"],
				);
				deleteBtn.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					openInlineDeleteConfirm({
						onConfirm: () => {
							if (activeDocTarget === card) closeDocPanel();
							card.remove();
						},
					});
				});
				const actions = el("div", { class: "cms-inline-actions" }, [
					editBtn,
					deleteBtn,
				]);
				card.appendChild(actions);
			});
		};

		const renderTableActions = () => {
			editor.querySelectorAll("table").forEach((table) => {
				if (!(table instanceof HTMLElement)) return;
				if (table.closest(".cms-table-wrap")) return;
				const wrap = document.createElement("div");
				wrap.className = "cms-table-wrap";
				table.parentElement?.insertBefore(wrap, table);
				wrap.appendChild(table);
			});
			editor.querySelectorAll(".cms-table-wrap").forEach((wrap) => {
				if (!(wrap instanceof HTMLElement)) return;
				if (wrap.querySelector(":scope > .cms-inline-actions")) return;
				const deleteBtn = el(
					"button",
					{
						type: "button",
						class: "cms-block__btn cms-block__btn--danger cms-inline-action",
					},
					[buildTrashIcon(), "Delete"],
				);
				deleteBtn.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					openInlineDeleteConfirm({
						onConfirm: () => {
							wrap.remove();
						},
					});
				});
				const actions = el("div", { class: "cms-inline-actions" }, [deleteBtn]);
				wrap.appendChild(actions);
			});
		};

		const getAccordionGroup = (tab) => {
			if (!(tab instanceof HTMLElement)) return { container: null, tabs: [] };
			const styledBox = tab.closest(".flex-accordion-box");
			if (styledBox) {
				return {
					container: styledBox,
					tabs: Array.from(styledBox.querySelectorAll(".tab")),
					type: "styled",
				};
			}
			const parent = tab.parentElement;
			if (!parent) return { container: null, tabs: [] };
			let start = tab;
			while (
				start.previousElementSibling &&
				start.previousElementSibling.classList.contains("tab")
			) {
				start = start.previousElementSibling;
			}
			const tabs = [];
			let node = start;
			while (node && node.classList.contains("tab")) {
				tabs.push(node);
				node = node.nextElementSibling;
			}
			return { container: parent, tabs, type: "simple" };
		};

		const getNextAccordionId = (tabs) => {
			let prefix = `acc-${BUILD_TOKEN}-${makeLocalId()}`;
			let maxIndex = 0;
			tabs.forEach((tab) => {
				const id = tab.querySelector("input[type=checkbox]")?.id || "";
				const match = id.match(/^(.*)-(\d+)$/);
				if (match) {
					prefix = match[1];
					const num = Number.parseInt(match[2], 10);
					if (!Number.isNaN(num)) maxIndex = Math.max(maxIndex, num);
				}
			});
			let nextIndex = maxIndex + 1;
			let nextId = `${prefix}-${nextIndex}`;
			const escapeId = (value) =>
				typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value;
			while (editor.querySelector(`#${escapeId(nextId)}`)) {
				nextIndex += 1;
				nextId = `${prefix}-${nextIndex}`;
			}
			return { id: nextId, index: nextIndex };
		};

		const buildAccordionTab = ({ id, title, bodyHtml }) => {
			const input = el("input", { type: "checkbox", id });
			const label = el("label", { class: "tab-label", for: id }, [title]);
			const content = el("div", { class: "tab-content", html: bodyHtml });
			return el("div", { class: "tab" }, [input, label, content]);
		};

		const updateAccordionActionState = (tabs) => {
			const disableRemove = tabs.length <= 1;
			tabs.forEach((tab) => {
				const btn = tab.querySelector(".cms-accordion-btn--remove");
				if (!btn) return;
				btn.disabled = disableRemove;
				btn.classList.toggle("is-disabled", disableRemove);
			});
		};

		const normalizeAccordionIds = () => {
			const used = new Set();
			const escapeId = (value) =>
				typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value;
			editor.querySelectorAll(".tab").forEach((tab, idx) => {
				const input = tab.querySelector("input[type=checkbox]");
				const label = tab.querySelector(".tab-label");
				if (!input || !label) return;
				let base = input.id || `acc-${BUILD_TOKEN}-${makeLocalId()}`;
				base = base.replace(/^cms-edit-/, "");
				let nextId = `cms-edit-${BUILD_TOKEN}-${base}-${idx}`;
				let bump = 0;
				while (
					used.has(nextId) ||
					editor.querySelector(`#${escapeId(nextId)}`)
				) {
					bump += 1;
					nextId = `cms-edit-${BUILD_TOKEN}-${base}-${idx}-${bump}`;
				}
				input.id = nextId;
				label.setAttribute("for", nextId);
				used.add(nextId);
			});
		};

		const attachAccordionActions = (tab) => {
			if (!(tab instanceof HTMLElement)) return;
			if (tab.querySelector(".cms-accordion-actions")) return;
			tab.classList.add("cms-accordion-item");
			const icon = (name) =>
				el(
					"span",
					{
						class: "material-icons cms-accordion__icon",
						"aria-hidden": "true",
					},
					[name],
				);
			const addBtn = el(
				"button",
				{
					type: "button",
					class: "cms-block__btn cms-block__btn--move cms-accordion-btn",
					"data-tooltip": "Add row",
					"aria-label": "Add row",
				},
				[icon("add")],
			);
			const removeBtn = el(
				"button",
				{
					type: "button",
					class:
						"cms-block__btn cms-block__btn--edit cms-accordion-btn cms-accordion-btn--remove",
					"data-tooltip": "Remove row",
					"aria-label": "Remove row",
				},
				[icon("remove")],
			);
			const deleteBtn = el(
				"button",
				{
					type: "button",
					class: "cms-block__btn cms-block__btn--danger cms-accordion-btn",
					"data-tooltip": "Delete accordion",
					"aria-label": "Delete accordion",
				},
				[buildTrashIcon()],
			);
			addBtn.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				const group = getAccordionGroup(tab);
				if (!group.container) return;
				const next = getNextAccordionId(group.tabs);
				const newTab = buildAccordionTab({
					id: next.id,
					title: `Item ${next.index}`,
					bodyHtml: "<ul><li>Point A</li><li>Point B</li></ul>",
				});
				tab.after(newTab);
				attachAccordionActions(newTab);
				updateAccordionActionState(getAccordionGroup(newTab).tabs);
			});
			removeBtn.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				const group = getAccordionGroup(tab);
				if (!group.container || group.tabs.length <= 1) return;
				tab.remove();
				updateAccordionActionState(group.tabs.filter((t) => t !== tab));
			});
			deleteBtn.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				const group = getAccordionGroup(tab);
				if (!group.container) return;
				openInlineDeleteConfirm({
					onConfirm: () => {
						const wrapper = tab.closest(".flex-accordion-wrapper");
						if (wrapper) {
							wrapper.remove();
							return;
						}
						if (group.type === "styled") {
							group.container.remove();
							return;
						}
						group.tabs.forEach((item) => item.remove());
					},
				});
			});
			const actions = el("div", { class: "cms-accordion-actions" }, [
				addBtn,
				removeBtn,
				deleteBtn,
			]);
			tab.appendChild(actions);
			updateAccordionActionState(getAccordionGroup(tab).tabs);
		};

		const renderAccordionActions = () => {
			normalizeAccordionIds();
			editor.querySelectorAll(".tab").forEach((tab) => {
				attachAccordionActions(tab);
			});
			editor.querySelectorAll(".flex-accordion-wrapper").forEach((wrapper) => {
				if (!(wrapper instanceof HTMLElement)) return;
				if (wrapper.querySelector(":scope > .cms-inline-actions")) return;
				wrapper.classList.add("cms-accordion-group");
				const deleteBtn = el(
					"button",
					{
						type: "button",
						class: "cms-block__btn cms-block__btn--danger cms-inline-action",
						"data-tooltip": "Delete accordion",
						"aria-label": "Delete accordion",
					},
					[buildTrashIcon(), "Delete"],
				);
				deleteBtn.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					openInlineDeleteConfirm({
						onConfirm: () => {
							wrapper.remove();
						},
					});
				});
				const actions = el("div", { class: "cms-inline-actions" }, [deleteBtn]);
				wrapper.appendChild(actions);
			});
		};

		const buildDocCardHtml = (attrs) => {
			const title = escapeHtml(attrs.title || "Document");
			const desc = attrs.desc ? escapeHtml(attrs.desc) : "";
			const href = escapeAttr(attrs.href || "");
			const ext = getDocExtFromHref(attrs.href || "");
			const icon = resolveDocIcon(ext);
			const overlayLabel = ext === "pdf" ? "Open PDF" : "Open document";
			return [
				`<div class="doc-card doc-card--compact" data-doc-ext="${escapeAttr(
					ext,
				)}">`,
				`<a class="doc-card__link" href="${href}" target="_blank" rel="noopener noreferrer" data-doc-open>`,
				`<span class="material-icons doc-card__type-icon" aria-hidden="true">${escapeHtml(
					icon,
				)}</span>`,
				`<div class="doc-card__text">`,
				`<div class="doc-card__title">${title}</div>`,
				desc ? `<div class="doc-card__desc">${desc}</div>` : "",
				`</div>`,
				`<div class="doc-card__overlay">`,
				`<div class="doc-card__overlay-content">`,
				`<span class="material-icons" aria-hidden="true">open_in_new</span>`,
				`<span class="doc-card__overlay-label">${overlayLabel}</span>`,
				`</div>`,
				`</div>`,
				`</a>`,
				`</div>`,
			]
				.filter(Boolean)
				.join("");
		};

		const buildDocEmbedHtml = (attrs) =>
			serializeDocEmbedStub({
				doc: attrs.href || "",
				title: attrs.title || "",
				desc: attrs.desc || "",
			});

		const renderDocCard = (target, attrs) => {
			if (!(target instanceof HTMLElement)) return;
			target.className = "doc-card doc-card--compact";
			target.innerHTML = "";
			const ext = getDocExtFromHref(attrs.href || "");
			const icon = resolveDocIcon(ext);
			const overlayLabel = ext === "pdf" ? "Open PDF" : "Open document";
			target.dataset.docExt = ext || "";
			const link = el(
				"a",
				{
					class: "doc-card__link",
					href: attrs.href || "#",
					target: "_blank",
					rel: "noopener noreferrer",
					"data-doc-open": "true",
				},
				[
					el(
						"span",
						{
							class: "material-icons doc-card__type-icon",
							"aria-hidden": "true",
						},
						[icon],
					),
					el("div", { class: "doc-card__text" }, [
						el("div", { class: "doc-card__title" }, [
							attrs.title || "Document",
						]),
						el("div", { class: "doc-card__desc" }, [attrs.desc || ""]),
					]),
					el("div", { class: "doc-card__overlay" }, [
						el("div", { class: "doc-card__overlay-content" }, [
							el("span", { class: "material-icons", "aria-hidden": "true" }, [
								"open_in_new",
							]),
							el("span", { class: "doc-card__overlay-label" }, [overlayLabel]),
						]),
					]),
				],
			);
			link.addEventListener("click", (event) => event.preventDefault());
			target.appendChild(link);
		};

		const renderDocEmbedStub = (target, attrs) => {
			if (!(target instanceof HTMLElement)) return;
			target.className = "doc-embed";
			target.innerHTML = "";
			target.setAttribute("data-doc", attrs.href || "");
			target.setAttribute("data-title", attrs.title || "");
			target.setAttribute("data-desc", attrs.desc || "");
			const ext = getDocExtFromHref(attrs.href || "");
			const icon = resolveDocIcon(ext);
			target.dataset.docExt = ext || "";
			const title = attrs.title || "Document embed";
			const meta = attrs.desc || attrs.href || "Inline iframe preview";
			const placeholder = el("div", { class: "cms-doc-embed__placeholder" }, [
				el(
					"span",
					{
						class: "material-icons cms-doc-embed__icon",
						"aria-hidden": "true",
					},
					[icon],
				),
				el("div", { class: "cms-doc-embed__text" }, [
					el("div", { class: "cms-doc-embed__title" }, [title]),
					el("div", { class: "cms-doc-embed__meta" }, [meta]),
				]),
			]);
			target.appendChild(placeholder);
			const editBtn = el(
				"button",
				{
					type: "button",
					class: "cms-block__btn cms-block__btn--edit cms-inline-action",
				},
				[buildPenIcon(), "Edit"],
			);
			editBtn.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				openDocPanel({ targetDoc: target });
			});
			const deleteBtn = el(
				"button",
				{
					type: "button",
					class: "cms-block__btn cms-block__btn--danger cms-inline-action",
				},
				[buildTrashIcon(), "Delete"],
			);
			deleteBtn.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				openInlineDeleteConfirm({
					onConfirm: () => {
						if (activeDocTarget === target) closeDocPanel();
						target.remove();
					},
				});
			});
			const actions = el("div", { class: "cms-inline-actions" }, [
				editBtn,
				deleteBtn,
			]);
			target.appendChild(actions);
		};

		const updateExitButtonLabel = () => {
			const footer = qs("#cms-modal-footer");
			if (!footer) return;
			const closeBtn = footer.querySelector("[data-close='true']");
			if (!closeBtn) return;
			const assetEditing =
				!imagePanel.hidden ||
				!videoPanel.hidden ||
				!docPanel.hidden ||
				!linkPanel.hidden;
			closeBtn.textContent = assetEditing
				? "Stop Editing Asset"
				: "Stop Editing Block";
		};

		const openImagePanel = ({ targetStub = null } = {}) => {
			if (!videoPanel.hidden) closeVideoPanel();
			if (!docPanel.hidden) closeDocPanel();
			if (!linkPanel.hidden) closeLinkPanel();
			activeImageTarget = targetStub;
			currentUploadFile = null;
			currentUploadBase64 = "";
			currentUploadMime = "";
			currentUploadPath = "";
			currentUploadExt = "";
			const attrs = targetStub
				? {
						img: targetStub.getAttribute("data-img") || "",
						caption: targetStub.getAttribute("data-caption") || "",
						lightbox: targetStub.getAttribute("data-lightbox") || "false",
						overlay: targetStub.getAttribute("data-overlay") || "",
						overlayTitle: targetStub.getAttribute("data-overlay-title") || "",
						overlayText: targetStub.getAttribute("data-overlay-text") || "",
						size: targetStub.getAttribute("data-size") || "sml",
						scale: targetStub.getAttribute("data-scale") || "auto",
					}
				: null;
			const localPath = attrs ? getLocalAssetPath(attrs.img) : "";
			const uploadItem =
				localPath &&
				(state.assetUploads || []).find((item) => item.path === localPath);
			if (attrs) {
				imgInput.value = attrs.img;
				captionInput.value = attrs.caption;
				lightboxInput.checked =
					normalizeBool(attrs.lightbox, "false") === "true";
				overlayEnabledInput.checked = attrs.overlay !== "false";
				overlayTitleInput.value = attrs.overlayTitle;
				overlayTextInput.value = attrs.overlayText;
				currentInlineSize = attrs.size || "sml";
				scaleSelect.value = attrs.scale || "auto";
			} else {
				imgInput.value = "";
				captionInput.value = "";
				lightboxInput.checked = true;
				overlayEnabledInput.checked = true;
				overlayTitleInput.value = "";
				overlayTextInput.value = "";
				currentInlineSize = "sml";
				scaleSelect.value = "auto";
			}
			syncOverlayState();
			applyScalePreview();
			if (uploadItem) {
				imageModeSelect.value = "upload";
				currentUploadBase64 = uploadItem.content || "";
				currentUploadMime = uploadItem.mime || "";
				currentUploadPath = uploadItem.path || "";
				currentUploadExt = getFileExtension(uploadItem.path || "");
				if (uploadNameInput) {
					uploadNameInput.value = uploadItem.path.replace(/^assets\/img\//, "");
				}
			} else {
				imageModeSelect.value = "existing";
				if (uploadNameInput) uploadNameInput.value = "";
			}
			if (setImageMode) setImageMode(imageModeSelect.value);
			imageSaveBtn.textContent = targetStub ? "Update image" : "Insert image";
			imageDeleteBtn.disabled = !targetStub;
			imagePanel.hidden = false;
			attachModalCloseInterceptor();
			updateExitButtonLabel();
			loadImageLibraryIntoSelect(imageLibrarySelect).catch((err) =>
				console.error(err),
			);
			imagePanel.scrollIntoView({ block: "center", behavior: "smooth" });
		};

		const closeImagePanel = () => {
			activeImageTarget = null;
			imagePanel.hidden = true;
			if (!videoPanel.hidden || !docPanel.hidden || !linkPanel.hidden) return;
			detachModalCloseInterceptor();
			updateExitButtonLabel();
		};

		imageSaveBtn.addEventListener("click", () => {
			const src = normalizeImageSource(imgInput.value.trim());
			if (!src) return;
			const attrs = {
				img: src,
				caption: captionInput.value.trim(),
				lightbox: lightboxInput.checked ? "true" : "false",
				overlayEnabled: overlayEnabledInput.checked,
				overlayTitle: overlayEnabledInput.checked
					? overlayTitleInput.value.trim()
					: "",
				overlayText: overlayEnabledInput.checked
					? overlayTextInput.value.trim()
					: "",
				size: currentInlineSize || "sml",
				scale: scaleSelect.value === "auto" ? "" : scaleSelect.value,
			};
			if (activeImageTarget) {
				activeImageTarget.setAttribute("data-img", attrs.img);
				activeImageTarget.setAttribute("data-caption", attrs.caption || "");
				activeImageTarget.setAttribute("data-lightbox", attrs.lightbox);
				if (attrs.overlayEnabled) {
					activeImageTarget.removeAttribute("data-overlay");
				} else {
					activeImageTarget.setAttribute("data-overlay", "false");
				}
				activeImageTarget.setAttribute(
					"data-overlay-title",
					attrs.overlayTitle || "",
				);
				activeImageTarget.setAttribute(
					"data-overlay-text",
					attrs.overlayText || "",
				);
				if (attrs.size) {
					activeImageTarget.setAttribute("data-size", attrs.size);
				} else {
					activeImageTarget.removeAttribute("data-size");
				}
				if (attrs.scale) {
					activeImageTarget.setAttribute("data-scale", attrs.scale);
				} else {
					activeImageTarget.removeAttribute("data-scale");
				}
				renderInlineImageStub(activeImageTarget);
			} else {
				const html = serializeImgStub(attrs);
				restoreSelection();
				insertHtmlAtCursor(editor, html);
				queueMicrotask(() => {
					renderInlineImageStubs();
				});
			}
			closeImagePanel();
		});

		imageDeleteBtn.addEventListener("click", () => {
			if (!activeImageTarget) return;
			openInlineDeleteConfirm({
				onConfirm: () => {
					if (activeImageTarget) activeImageTarget.remove();
					closeImagePanel();
				},
			});
		});

		const openVideoPanel = ({ targetStub = null } = {}) => {
			if (!imagePanel.hidden) closeImagePanel();
			if (!docPanel.hidden) closeDocPanel();
			if (!linkPanel.hidden) closeLinkPanel();
			activeVideoTarget = targetStub;
			const attrs = targetStub
				? {
						video: targetStub.getAttribute("data-video") || "",
						caption: targetStub.getAttribute("data-caption") || "",
						scale: targetStub.getAttribute("data-scale") || "auto",
					}
				: null;
			if (attrs) {
				videoInput.value = attrs.video;
				videoCaptionInput.value = attrs.caption;
				videoScaleSelect.value = attrs.scale || "auto";
			} else {
				videoInput.value = "";
				videoCaptionInput.value = "";
				videoScaleSelect.value = "auto";
			}
			videoInput.classList.remove("cms-field__input--invalid");
			videoCaptionInput.classList.remove("cms-field__input--invalid");
			updateVideoPreview();
			videoSaveBtn.textContent = targetStub ? "Update video" : "Insert video";
			videoDeleteBtn.disabled = !targetStub;
			videoPanel.hidden = false;
			attachModalCloseInterceptor();
			updateExitButtonLabel();
			videoPanel.scrollIntoView({ block: "center", behavior: "smooth" });
		};

		const closeVideoPanel = () => {
			activeVideoTarget = null;
			videoPanel.hidden = true;
			if (!imagePanel.hidden || !docPanel.hidden || !linkPanel.hidden) return;
			detachModalCloseInterceptor();
			updateExitButtonLabel();
		};

		videoSaveBtn.addEventListener("click", () => {
			const raw = videoInput.value.trim();
			const src = normalizeVideoSource(raw);
			const caption = videoCaptionInput.value.trim();
			if (!src) {
				videoInput.classList.add("cms-field__input--invalid");
				videoInput.focus();
				return;
			}
			if (!caption) {
				videoCaptionInput.classList.add("cms-field__input--invalid");
				videoCaptionInput.focus();
				return;
			}
			const attrs = {
				video: src,
				caption,
				scale: videoScaleSelect.value === "auto" ? "" : videoScaleSelect.value,
			};
			if (activeVideoTarget) {
				activeVideoTarget.setAttribute("data-video", attrs.video);
				activeVideoTarget.setAttribute("data-caption", attrs.caption);
				if (attrs.scale) {
					activeVideoTarget.setAttribute("data-scale", attrs.scale);
				} else {
					activeVideoTarget.removeAttribute("data-scale");
				}
				renderInlineVideoStub(activeVideoTarget);
			} else {
				const html = serializeVideoStub(attrs);
				restoreSelection();
				insertHtmlAtCursor(editor, html);
				queueMicrotask(() => {
					renderInlineVideoStubs();
				});
			}
			closeVideoPanel();
		});

		videoDeleteBtn.addEventListener("click", () => {
			if (!activeVideoTarget) return;
			openInlineDeleteConfirm({
				onConfirm: () => {
					if (activeVideoTarget) activeVideoTarget.remove();
					closeVideoPanel();
				},
			});
		});

		const openDocPanel = ({ targetDoc = null } = {}) => {
			if (!imagePanel.hidden) closeImagePanel();
			if (!videoPanel.hidden) closeVideoPanel();
			if (!linkPanel.hidden) closeLinkPanel();
			activeDocTarget = targetDoc;
			const isEmbed = targetDoc?.classList?.contains("doc-embed");
			const link = targetDoc?.querySelector(".doc-card__link") || null;
			const titleEl = targetDoc?.querySelector(".doc-card__title") || null;
			const descEl = targetDoc?.querySelector(".doc-card__desc") || null;
			if (targetDoc && isEmbed) {
				docDisplaySelect.value = "embed";
				docHrefInput.value = targetDoc.getAttribute("data-doc") || "";
				docTitleInput.value = targetDoc.getAttribute("data-title") || "";
				docDescInput.value = targetDoc.getAttribute("data-desc") || "";
			} else if (targetDoc) {
				docDisplaySelect.value = "card";
				docHrefInput.value = link?.getAttribute("href") || "";
				docTitleInput.value = titleEl?.textContent?.trim() || "";
				docDescInput.value = descEl?.textContent?.trim() || "";
			} else {
				docDisplaySelect.value = "card";
				docHrefInput.value = "";
				docTitleInput.value = "";
				docDescInput.value = "";
			}
			docHrefInput.classList.remove("cms-field__input--invalid");
			docTitleInput.classList.remove("cms-field__input--invalid");
			updateDocPreview();
			docLibrarySelect.value = "";
			docDeleteBtn.disabled = !targetDoc;
			docPanel.hidden = false;
			attachModalCloseInterceptor();
			updateExitButtonLabel();
			loadDocLibraryIntoSelect(docLibrarySelect)
				.then(() => {
					const current = docHrefInput.value.trim().replace(/^\/+/, "");
					if (current) docLibrarySelect.value = current;
				})
				.catch((err) => console.error(err));
			docPanel.scrollIntoView({ block: "center", behavior: "smooth" });
		};

		const closeDocPanel = () => {
			activeDocTarget = null;
			docPanel.hidden = true;
			if (!imagePanel.hidden || !videoPanel.hidden || !linkPanel.hidden)
				return;
			detachModalCloseInterceptor();
			updateExitButtonLabel();
		};

		docSaveBtn.addEventListener("click", () => {
			const href = normalizeDocHref(docHrefInput.value.trim());
			const safeHref = sanitizeHref(href);
			const title = docTitleInput.value.trim();
			const desc = docDescInput.value.trim();
			const wantsEmbed = docDisplaySelect.value === "embed";
			if (!safeHref) {
				docLibrarySelect.classList.add("cms-field__input--invalid");
				docLibrarySelect.focus();
				return;
			}
			if (!wantsEmbed && !title) {
				docTitleInput.classList.add("cms-field__input--invalid");
				docTitleInput.focus();
				return;
			}
			const attrs = { href: safeHref, title, desc };
			if (activeDocTarget) {
				const isEmbedTarget =
					activeDocTarget?.classList?.contains("doc-embed");
				if (wantsEmbed && isEmbedTarget) {
					renderDocEmbedStub(activeDocTarget, attrs);
				} else if (!wantsEmbed && !isEmbedTarget) {
					renderDocCard(activeDocTarget, attrs);
				} else {
					const html = wantsEmbed
						? buildDocEmbedHtml(attrs)
						: buildDocCardHtml(attrs);
					const wrap = document.createElement("div");
					wrap.innerHTML = html;
					const next = wrap.firstElementChild;
					if (next) {
						activeDocTarget.replaceWith(next);
						activeDocTarget = next;
						if (wantsEmbed) renderDocEmbedStub(next, attrs);
						else renderDocCard(next, attrs);
					}
				}
			} else {
				const html = wantsEmbed
					? buildDocEmbedHtml(attrs)
					: buildDocCardHtml(attrs);
				restoreSelection();
				insertHtmlAtCursor(editor, html);
			}
			queueMicrotask(() => {
				renderDocCardActions();
				renderInlineDocEmbeds();
			});
			closeDocPanel();
		});

		docDeleteBtn.addEventListener("click", () => {
			if (!activeDocTarget) return;
			openInlineDeleteConfirm({
				onConfirm: () => {
					if (activeDocTarget) activeDocTarget.remove();
					closeDocPanel();
				},
			});
		});

		linkHrefInput.addEventListener("input", () => {
			linkHrefInput.classList.remove("cms-field__input--invalid");
		});

		linkSaveBtn.addEventListener("click", () => {
			const href = sanitizeHref(linkHrefInput.value.trim());
			if (!href) {
				linkHrefInput.classList.add("cms-field__input--invalid");
				linkHrefInput.focus();
				return;
			}
			const rawText = linkTextInput.value.trim();
			const isExternal = /^https:\/\//i.test(href);
			const applyLinkAttrs = (link, { replaceText = false, text = "" } = {}) => {
				if (!link) return;
				link.setAttribute("href", href);
				if (isExternal) {
					link.setAttribute("target", "_blank");
					link.setAttribute("rel", "noopener noreferrer");
				} else {
					link.removeAttribute("target");
					link.removeAttribute("rel");
				}
				if (replaceText && text) link.textContent = text;
			};
			if (activeLinkTarget) {
				const existingText = activeLinkTarget.textContent?.trim() || "";
				const fallbackText = rawText || existingText || href;
				const replaceText = Boolean(rawText) || !existingText;
				applyLinkAttrs(activeLinkTarget, {
					replaceText,
					text: fallbackText,
				});
				closeLinkPanel();
				return;
			}
			restoreSelection();
			const selectionAfter = window.getSelection();
			const selectedText =
				selectionAfter && !selectionAfter.isCollapsed
					? selectionAfter.toString()
					: "";
			const hasSelection = selectionAfter && !selectionAfter.isCollapsed;
			if (hasSelection && !rawText) {
				document.execCommand("createLink", false, href);
				const link = getLinkFromSelection();
				applyLinkAttrs(link);
				closeLinkPanel();
				return;
			}
			const fallbackText = rawText || selectedText || href;
			const attrs = [
				`href="${escapeAttr(href)}"`,
				isExternal
					? ' target="_blank" rel="noopener noreferrer"'
					: "",
			]
				.filter(Boolean)
				.join("");
			const html = `<a ${attrs}>${escapeHtml(fallbackText)}</a>`;
			insertHtmlAtCursor(editor, html);
			closeLinkPanel();
		});

		linkRemoveBtn.addEventListener("click", () => {
			if (!activeLinkTarget) return;
			const parent = activeLinkTarget.parentNode;
			if (!parent) return;
			const frag = document.createDocumentFragment();
			while (activeLinkTarget.firstChild) {
				frag.appendChild(activeLinkTarget.firstChild);
			}
			parent.replaceChild(frag, activeLinkTarget);
			closeLinkPanel();
		});

		const allowedSet = Array.isArray(allowedCommands)
			? new Set(allowedCommands)
			: null;
		const runCommand = (cmd) => {
			if (!cmd) return;
			if (allowedSet && !allowedSet.has(cmd)) return;
			restoreSelection();
			editor.focus();
			if (cmd === "bold") document.execCommand("bold");
			else if (cmd === "italic") document.execCommand("italic");
			else if (cmd === "underline") document.execCommand("underline");
			else if (cmd === "align-left") document.execCommand("justifyLeft");
			else if (cmd === "align-center") document.execCommand("justifyCenter");
			else if (cmd === "h2") document.execCommand("formatBlock", false, "H2");
			else if (cmd === "h3") document.execCommand("formatBlock", false, "H3");
			else if (cmd === "quote") toggleBlockquote();
			else if (cmd === "link") openLinkPanel();
			else if (cmd === "ul") document.execCommand("insertUnorderedList");
			else if (cmd === "ol") document.execCommand("insertOrderedList");
			else if (cmd === "table") {
				const tableHtml = [
					"<table>",
					"\t<thead>",
					"\t\t<tr><th>Header</th><th>Header</th></tr>",
					"\t</thead>",
					"\t<tbody>",
					"\t\t<tr><td>Cell</td><td>Cell</td></tr>",
					"\t</tbody>",
					"</table>",
				].join("\n");
				insertHtmlAtCursor(editor, tableHtml);
				queueMicrotask(() => renderTableActions());
			} else if (cmd === "table-borderless") {
				const selection = window.getSelection();
				let node = selection?.anchorNode || null;
				if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
				const table = node?.closest ? node.closest("table") : null;
				if (table) {
					table.classList.add("table-borderless");
					table.querySelector("thead")?.remove();
					table.querySelectorAll("th").forEach((th) => {
						const td = document.createElement("td");
						td.innerHTML = th.innerHTML;
						th.replaceWith(td);
					});
					queueMicrotask(() => renderTableActions());
				} else {
					const tableHtml = [
						'<table class="table-borderless">',
						"\t<tbody>",
						"\t\t<tr><td>Cell</td><td>Cell</td></tr>",
						"\t</tbody>",
						"</table>",
					].join("\n");
					insertHtmlAtCursor(editor, tableHtml);
					queueMicrotask(() => renderTableActions());
				}
			} else if (cmd === "table-row") {
				addTableRowAfterCell();
			} else if (cmd === "table-col") {
				addTableColumnAfterCell();
			} else if (cmd === "table-row-remove") {
				removeTableRowAtCell();
			} else if (cmd === "table-col-remove") {
				removeTableColumnAtCell();
			} else if (cmd === "code") {
				const selection = window.getSelection();
				if (!selection || selection.rangeCount === 0) return;
				const range = selection.getRangeAt(0);
				if (range.collapsed) return;
				let node = range.commonAncestorContainer;
				if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
				const existingCode = node?.closest ? node.closest("code") : null;
				if (existingCode) {
					const textNode = document.createTextNode(
						existingCode.textContent || "",
					);
					existingCode.replaceWith(textNode);
					selection.removeAllRanges();
					const newRange = document.createRange();
					newRange.selectNodeContents(textNode);
					selection.addRange(newRange);
					return;
				}
				const code = document.createElement("code");
				code.textContent = range.toString();
				range.deleteContents();
				range.insertNode(code);
				selection.removeAllRanges();
				const newRange = document.createRange();
				newRange.selectNodeContents(code);
				selection.addRange(newRange);
			} else if (cmd === "code-block") {
				const selection = window.getSelection();
				if (!selection || selection.rangeCount === 0) return;
				const range = selection.getRangeAt(0);
				let node = range.commonAncestorContainer;
				if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
				const existingPre = node?.closest ? node.closest("pre") : null;
				if (existingPre) return;
				const initialText = range.collapsed ? "" : selection.toString();
				const pre = document.createElement("pre");
				const code = document.createElement("code");
				const detected = guessLanguageFromText(initialText) || "auto";
				updateCodeLanguage(code, detected);
				code.textContent = initialText;
				pre.appendChild(code);
				if (!range.collapsed) range.deleteContents();
				range.insertNode(pre);
				ensureCodeToolbar(pre);
				const nextRange = document.createRange();
				nextRange.selectNodeContents(code);
				nextRange.collapse(false);
				selection.removeAllRanges();
				selection.addRange(nextRange);
			} else if (cmd === "code-wrap") {
				const selection = window.getSelection();
				if (!selection || selection.rangeCount === 0) return;
				const range = selection.getRangeAt(0);
				if (range.collapsed) return;
				let node = range.commonAncestorContainer;
				if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
				if (node?.closest && node.closest("pre, code")) return;
				const pre = document.createElement("pre");
				const code = document.createElement("code");
				const raw = selection.toString();
				updateCodeLanguage(code, "auto");
				code.textContent = raw;
				pre.appendChild(code);
				range.deleteContents();
				range.insertNode(pre);
				ensureCodeToolbar(pre);
				const nextRange = document.createRange();
				nextRange.selectNodeContents(code);
				nextRange.collapse(false);
				selection.removeAllRanges();
				selection.addRange(nextRange);
			} else if (cmd === "img") {
				openImagePanel();
			} else if (cmd === "video") {
				openVideoPanel();
			} else if (cmd === "accordion-simple") {
				const html = buildAccordionMarkup({ styled: false });
				insertHtmlAtCursor(editor, html);
				queueMicrotask(() => renderAccordionActions());
			} else if (cmd === "accordion-styled") {
				const html = buildAccordionMarkup({ styled: true });
				insertHtmlAtCursor(editor, html);
				queueMicrotask(() => renderAccordionActions());
			} else if (cmd === "doc") {
				openDocPanel();
			} else if (cmd.startsWith("mermaid-")) {
				const templates = {
					"mermaid-flow": [
						'<pre><code class="language-mermaid">',
						"flowchart LR",
						'  A[Start] --> B{Decision}',
						"  B -->|Yes| C[Next step]",
						"  B -->|No| D[Retry]",
						'  click C "#section-id" "Jump to section"',
						'</code></pre>',
					],
					"mermaid-sequence": [
						'<pre><code class="language-mermaid">',
						"sequenceDiagram",
						"  participant User",
						"  participant Admin",
						"  participant GitHub",
						"  User->>Admin: Edit content",
						"  Admin->>GitHub: Create PR",
						"  GitHub-->>User: Merge approved",
						"  %% Link example (flowcharts only): click NodeId \"#section-id\"",
						'</code></pre>',
					],
					"mermaid-gantt": [
						'<pre><code class="language-mermaid">',
						"gantt",
						"  title Release cadence",
						"  dateFormat  YYYY-MM-DD",
						"  section Dev",
						"  Build: a1, 2026-02-01, 5d",
						"  Review: after a1, 3d",
						"  section Prod",
						"  Deploy: 2026-02-10, 1d",
						"  %% Link example (flowcharts only): click NodeId \"#section-id\"",
						"</code></pre>",
					],
					"mermaid-pie": [
						'<pre><code class="language-mermaid">',
						"pie title Case Study Mix",
						'  "Development" : 5',
						'  "Engineering Management" : 3',
						'  "Commercial" : 2',
						'  "Business Winning" : 2',
						"  %% Link example (flowcharts only): click NodeId \"#section-id\"",
						"</code></pre>",
					],
				};
				const mermaidHtml = (templates[cmd] || templates["mermaid-flow"]).join(
					"\n",
				);
				insertHtmlAtCursor(editor, mermaidHtml);
				queueMicrotask(() => {
					const selection = window.getSelection();
					let node = selection?.anchorNode || null;
					if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
					const pre = node?.closest ? node.closest("pre") : null;
					if (pre) ensureCodeToolbar(pre);
					scheduleMermaidPreview();
				});
			}
		};
		if (toolbarController) {
			toolbarController.registerEditor(editor, runCommand, {
				allowedCommands,
			});
		} else {
			toolbar.addEventListener("click", (event) => {
				const btn = event.target.closest("button");
				if (!btn) return;
				const cmd = btn.getAttribute("data-cmd");
				runCommand(cmd);
			});
		}
		editor.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				const selection = window.getSelection();
				if (!selection || !selection.anchorNode) return;
				let node = selection.anchorNode;
				if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
				const preBlock = node?.closest ? node.closest("pre") : null;
				if (!preBlock) return;
				const codeEl = preBlock.querySelector("code");
				if (event.shiftKey && codeEl) {
					const caret = getCaretOffsetInCode(codeEl);
					const content = codeEl.textContent || "";
					if (caret !== null && caret >= content.length) {
						event.preventDefault();
						insertParagraphAfterPre(preBlock);
						return;
					}
				}
				event.preventDefault();
				if (insertPlainTextIntoCode(preBlock, "\n")) {
					scheduleMermaidPreview();
				}
				return;
			}
			if (event.key !== "Tab") return;
			const selection = window.getSelection();
			if (!selection || !selection.anchorNode) return;
			let node = selection.anchorNode;
			if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
			const preBlock = node?.closest ? node.closest("pre") : null;
			if (preBlock) return;
			const li = node?.closest ? node.closest("li") : null;
			if (!li) return;
			event.preventDefault();
			if (event.shiftKey) document.execCommand("outdent");
			else document.execCommand("indent");
		});
		const getSelectionPreBlock = () => {
			const selection = window.getSelection();
			if (!selection || selection.rangeCount === 0) return null;
			let node = selection.getRangeAt(0).commonAncestorContainer;
			if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
			return node?.closest ? node.closest("pre") : null;
		};

		const getCaretOffsetInCode = (code) => {
			const selection = window.getSelection();
			if (!selection || selection.rangeCount === 0) return null;
			const range = selection.getRangeAt(0);
			if (!code.contains(range.commonAncestorContainer)) return null;
			const caretRange = range.cloneRange();
			caretRange.selectNodeContents(code);
			caretRange.setEnd(range.endContainer, range.endOffset);
			return caretRange.toString().length;
		};

		const setCaretInCode = (code, offset) => {
			const selection = window.getSelection();
			if (!selection) return false;
			if (!code.firstChild) {
				code.appendChild(document.createTextNode(""));
			}
			const walker = document.createTreeWalker(
				code,
				NodeFilter.SHOW_TEXT,
				null,
			);
			let remaining = Math.max(0, offset);
			let node = walker.nextNode();
			while (node) {
				const len = node.nodeValue ? node.nodeValue.length : 0;
				if (remaining <= len) {
					const range = document.createRange();
					range.setStart(node, remaining);
					range.collapse(true);
					selection.removeAllRanges();
					selection.addRange(range);
					return true;
				}
				remaining -= len;
				node = walker.nextNode();
			}
			const last = code.lastChild;
			if (!last) return false;
			const range = document.createRange();
			range.selectNodeContents(last);
			range.collapse(false);
			selection.removeAllRanges();
			selection.addRange(range);
			return true;
		};

		const insertPlainTextIntoCode = (target, text) => {
			const code =
				target?.closest?.("code") || target?.querySelector?.("code") || null;
			if (!code) return false;
			const selection = window.getSelection();
			if (!selection || selection.rangeCount === 0) return false;
			const range = selection.getRangeAt(0);
			if (!code.contains(range.commonAncestorContainer)) {
				range.selectNodeContents(code);
				range.collapse(false);
			}
			const start = getCaretOffsetInCode(code);
			const end = (() => {
				const endRange = range.cloneRange();
				endRange.selectNodeContents(code);
				endRange.setEnd(range.endContainer, range.endOffset);
				return endRange.toString().length;
			})();
			const safeStart = Math.max(0, start ?? 0);
			const safeEnd = Math.max(safeStart, end ?? safeStart);
			const content = code.textContent || "";
			const next = `${content.slice(0, safeStart)}${text}${content.slice(
				safeEnd,
			)}`;
			code.textContent = next;
			setCaretInCode(code, safeStart + text.length);
			return true;
		};

		const insertParagraphAfterPre = (pre) => {
			const wrap = pre?.closest?.(".cms-code-block-wrap") || pre;
			if (!wrap?.parentElement) return false;
			const p = document.createElement("p");
			p.appendChild(document.createElement("br"));
			wrap.insertAdjacentElement("afterend", p);
			const range = document.createRange();
			range.setStart(p, 0);
			range.collapse(true);
			const selection = window.getSelection();
			if (selection) {
				selection.removeAllRanges();
				selection.addRange(range);
			}
			return true;
		};

		editor.addEventListener(
			"paste",
			(event) => {
				const target = event.target instanceof Element ? event.target : null;
				const codeBlock = getSelectionPreBlock() || target?.closest("pre");
				if (!codeBlock) return;
				const text = event.clipboardData?.getData("text/plain");
				if (!text) return;
				event.preventDefault();
				insertPlainTextIntoCode(codeBlock, text);
			},
			true,
		);
		editor.addEventListener(
			"beforeinput",
			(event) => {
				const inputType = event.inputType || "";
				if (inputType === "insertFromPaste") {
					const target = event.target instanceof Element ? event.target : null;
					const codeBlock = getSelectionPreBlock() || target?.closest("pre");
					if (!codeBlock) return;
					const text = event.data || "";
					if (!text) return;
					event.preventDefault();
					insertPlainTextIntoCode(codeBlock, text);
					return;
				}
				if (inputType === "insertParagraph" || inputType === "insertLineBreak") {
					const target = event.target instanceof Element ? event.target : null;
					const codeBlock = getSelectionPreBlock() || target?.closest("pre");
					if (!codeBlock) return;
					event.preventDefault();
					if (insertPlainTextIntoCode(codeBlock, "\n")) {
						scheduleMermaidPreview();
					}
				}
			},
			true,
		);
		editor.addEventListener("click", (event) => {
			const target = event.target instanceof Element ? event.target : null;
			const pre = target?.closest("pre");
			if (!pre) return;
			const code = pre.querySelector("code");
			if (code) {
				code.setAttribute("contenteditable", "true");
			}
		});
		editor.addEventListener("click", (event) => {
			const stub = event.target.closest(".img-stub");
			if (stub && editor.contains(stub)) {
				openImagePanel({ targetStub: stub });
			}
		});
		editor.addEventListener("click", (event) => {
			const stub = event.target.closest(".video-stub");
			if (stub && editor.contains(stub)) {
				openVideoPanel({ targetStub: stub });
			}
		});
		editor.addEventListener("click", (event) => {
			const card = event.target.closest(".doc-card");
			if (card && editor.contains(card)) {
				event.preventDefault();
				event.stopPropagation();
				openDocPanel({ targetDoc: card });
			}
		});
		editor.addEventListener("click", (event) => {
			const embed = event.target.closest(".doc-embed");
			if (embed && editor.contains(embed)) {
				event.preventDefault();
				event.stopPropagation();
				openDocPanel({ targetDoc: embed });
			}
		});
		editor.addEventListener("click", (event) => {
			const target = event.target instanceof Element ? event.target : null;
			const link = target?.closest("a");
			if (!link || !editor.contains(link)) return;
			if (link.closest(".doc-card")) return;
			event.preventDefault();
			event.stopPropagation();
			openLinkPanel({ targetLink: link });
		});
		renderInlineImageStubs();
		renderInlineVideoStubs();
		renderInlineDocEmbeds();
		renderDocCardActions();
		renderTableActions();
		renderAccordionActions();
		return {
			wrap,
			editor,
		};
	}

	function stripEditEntriesForBase(localBlocks, anchor) {
		const key = anchorKey(anchor);
		return normalizeLocalBlocks(localBlocks).filter((item) => {
			if (item.action === "mark" && anchorKey(item.anchor) === key)
				return false;
			if (item.action === "remove" && anchorKey(item.anchor) === key)
				return false;
			if (
				item.action === "insert" &&
				item.kind === "edited" &&
				(item.baseId === anchor.id || anchorKey(item.anchor) === key)
			)
				return false;
			return true;
		});
	}

	function buildField({ label, input, note }) {
		const nodes = [el("div", { class: "cms-field__label" }, [label]), input];
		if (note) nodes.push(el("div", { class: "cms-field__note" }, [note]));
		return el("div", { class: "cms-field" }, nodes);
	}

	function buildHeadingField({ label, input, align, note }) {
		const row = el(
			"div",
			{ class: "cms-field__row cms-field__row--heading" },
			[input, align].filter(Boolean),
		);
		return buildField({ label, input: row, note });
	}

	function buildAlignSelect(value, fallback = "left", anchorValue = "") {
		const wrap = el("div", {
			class: "cms-align-toggle",
			role: "group",
			"aria-label": "Heading alignment",
		});
		const alignValue = normalizeHeadingAlign(value, fallback);
		const anchorId = String(anchorValue || "").trim();
		const buildBtn = (align, icon, label) => {
			const btn = el(
				"button",
				{
					type: "button",
					class: "cms-align-toggle__btn",
					"data-align": align,
					"aria-label": label,
					"data-tooltip": label,
				},
				[el("span", { class: "material-icons", "aria-hidden": "true" }, [icon])],
			);
			btn.addEventListener("click", (event) => {
				event.preventDefault();
				wrap.value = align;
			});
			return btn;
		};
		const leftBtn = buildBtn("left", "format_align_left", "Align left");
		const centerBtn = buildBtn("center", "format_align_center", "Align center");
		const anchorBtn = el(
			"button",
			{
				type: "button",
				class: "cms-align-toggle__btn",
				"aria-label": "Anchor link",
				"data-tooltip": "Anchor link",
			},
			[el("span", { class: "material-icons", "aria-hidden": "true" }, ["link"])],
		);
		anchorBtn.addEventListener("click", (event) => {
			event.preventDefault();
			wrap.anchorEnabled = !wrap.anchorEnabled;
		});
		wrap.appendChild(leftBtn);
		wrap.appendChild(centerBtn);
		wrap.appendChild(anchorBtn);

		const setValue = (next) => {
			const normalized = normalizeHeadingAlign(next, fallback);
			wrap.dataset.value = normalized;
			leftBtn.classList.toggle("is-active", normalized === "left");
			centerBtn.classList.toggle("is-active", normalized === "center");
		};
		const setAnchorEnabled = (next) => {
			const enabled = Boolean(next);
			wrap.dataset.anchorEnabled = enabled ? "true" : "false";
			anchorBtn.classList.toggle("is-active", enabled);
			anchorBtn.setAttribute("aria-pressed", enabled ? "true" : "false");
		};
		Object.defineProperty(wrap, "value", {
			get() {
				return wrap.dataset.value || fallback;
			},
			set(next) {
				setValue(next);
			},
		});
		Object.defineProperty(wrap, "anchor", {
			get() {
				return wrap.dataset.anchor || "";
			},
			set(next) {
				wrap.dataset.anchor = String(next || "");
			},
		});
		Object.defineProperty(wrap, "anchorEnabled", {
			get() {
				return wrap.dataset.anchorEnabled === "true";
			},
			set(next) {
				setAnchorEnabled(next);
			},
		});
		setValue(alignValue);
		wrap.anchor = anchorId;
		setAnchorEnabled(Boolean(anchorId));
		return wrap;
	}

	function buildBlockNoopSignature(html) {
		const doc = new DOMParser().parseFromString(
			`<div id="__wrap__">${String(html || "")}</div>`,
			"text/html",
		);
		const wrap = doc.querySelector("#__wrap__");
		if (!wrap) return "";
		const stripHighlightMarkup = (root) => {
			root.querySelectorAll("[data-cms-preview]").forEach((el) => el.remove());
			root.querySelectorAll("pre code").forEach((code) => {
				code.classList.remove("hljs");
				code.removeAttribute("data-highlighted");
				code.textContent = code.textContent || "";
			});
			root.querySelectorAll("span").forEach((span) => {
				const cls = span.getAttribute("class") || "";
				const isHljs = cls
					.split(/\s+/)
					.some((c) => c === "hljs" || c.startsWith("hljs-"));
				if (!isHljs) return;
				span.replaceWith(document.createTextNode(span.textContent || ""));
			});
		};
		const normalizeNode = (node, inPre) => {
			if (node.nodeType === Node.TEXT_NODE) {
				if (inPre) return;
				const cleaned = String(node.textContent || "")
					.replace(/\s+/g, " ")
					.trim();
				if (!cleaned) {
					node.remove();
					return;
				}
				node.textContent = cleaned;
				return;
			}
			if (node.nodeType !== Node.ELEMENT_NODE) return;
			const tag = (node.tagName || "").toLowerCase();
			const nextInPre = inPre || tag === "pre" || tag === "code";
			if (node.classList?.contains("hljs")) node.classList.remove("hljs");
			if (node.hasAttribute?.("data-highlighted"))
				node.removeAttribute("data-highlighted");
			if (tag === "code") {
				node.classList?.remove("hljs");
				node.removeAttribute?.("data-highlighted");
			}
			if (node.classList && node.classList.length) {
				Array.from(node.classList).forEach((cls) => {
					if (cls.startsWith("cms-")) node.classList.remove(cls);
				});
			}
			if (node.hasAttribute("data-cms-id")) node.removeAttribute("data-cms-id");
			Array.from(node.childNodes).forEach((child) =>
				normalizeNode(child, nextInPre),
			);
			const attrs = Array.from(node.attributes).sort((a, b) =>
				a.name.localeCompare(b.name),
			);
			attrs.forEach((attr) => node.removeAttribute(attr.name));
			attrs.forEach((attr) => node.setAttribute(attr.name, attr.value));
		};

		const parts = [];
		Array.from(wrap.childNodes).forEach((child) => {
			if (child.nodeType === Node.ELEMENT_NODE) {
				const clone = child.cloneNode(true);
				stripHighlightMarkup(clone);
				normalizeNode(clone, false);
				parts.push(clone.outerHTML);
				return;
			}
			if (child.nodeType === Node.TEXT_NODE) {
				const text = String(child.textContent || "")
					.replace(/\s+/g, " ")
					.trim();
				if (text) parts.push(`#text:${text}`);
			}
		});
		return parts.join("\n");
	}

	function getBlockRootElement(wrapper) {
		if (!(wrapper instanceof HTMLElement)) return null;
		return Array.from(wrapper.children).find(
			(child) =>
				!child.classList.contains("cms-block__controls") &&
				!child.classList.contains("cms-block__badge") &&
				!child.classList.contains("cms-block__overlay"),
		);
	}

	function applyBlockHtmlUpdate({
		origin,
		localId,
		anchorBase,
		currentLocal,
		updatedHtml,
	}) {
		if (!updatedHtml) return;
		const local = normalizeLocalBlocks(currentLocal || []);
		if (origin === "local" && localId) {
			const nextLocal = local.map((item) =>
				item.id === localId
					? { ...item, html: updatedHtml, kind: "edited" }
					: item,
			);
			updateLocalBlocksAndRender(state.path, nextLocal);
			return;
		}
		if (origin === "base" && anchorBase?.id) {
			const anchor = {
				id: anchorBase.id,
				sig: anchorBase.sig,
				occ: anchorBase.occ,
			};
			const cleaned = stripEditEntriesForBase(local, anchor);
			const editedInsert = {
				id: makeLocalId(),
				html: updatedHtml,
				anchor,
				placement: "after",
				status: "staged",
				kind: "edited",
				action: "insert",
				baseId: anchor.id,
				sourceKey: `id:${anchor.id}`,
			};
			const removeBase = {
				id: makeLocalId(),
				html: "",
				anchor,
				placement: "after",
				status: "staged",
				kind: "edited",
				action: "remove",
				baseId: anchor.id,
			};
			updateLocalBlocksAndRender(state.path, [
				...cleaned,
				removeBase,
				editedInsert,
			]);
		}
	}

	function openGridLimitWarning(limit) {
		const closeBtn = el(
			"button",
			{
				class: "cms-btn cms-modal__action",
				type: "button",
				"data-close": "true",
			},
			["Close"],
		);
		const warning = el("div", { class: "cms-modal__note cms-note--warning" }, [
			`\u26a0 Max of ${limit} items per row. Remove one to add another. \u26a0`,
		]);
		openModal({
			title: "Limit reached",
			bodyNodes: [warning],
			footerNodes: [closeBtn],
		});
	}

	function confirmDeleteItem(onConfirm) {
		const root = qs("#cms-modal");
		const hadModal = Boolean(root && root.classList.contains("is-open"));
		if (hadModal && root) {
			const existing = root.querySelector(".cms-modal__confirm");
			if (existing) existing.remove();
			let overlay = null;
			const closeConfirm = () => {
				if (overlay) overlay.remove();
			};
			const cancel = el(
				"button",
				{
					class: "cms-btn cms-btn--move cms-modal__action",
					type: "button",
				},
				["Cancel"],
			);
			const confirm = el(
				"button",
				{
					class: "cms-btn cms-btn--danger cms-modal__action",
					type: "button",
				},
				["Delete"],
			);
			cancel.addEventListener("click", (event) => {
				event.preventDefault();
				closeConfirm();
			});
			confirm.addEventListener("click", (event) => {
				event.preventDefault();
				closeConfirm();
				if (typeof onConfirm === "function") onConfirm();
			});
			const panel = el("div", { class: "cms-modal__confirm-panel" }, [
				el("h3", { class: "cms-modal__confirm-title" }, ["Delete item"]),
				el("p", { class: "cms-modal__text" }, [
					"Delete this item? Unsaved changes will be lost if you continue.",
				]),
				el("div", { class: "cms-modal__confirm-actions" }, [cancel, confirm]),
			]);
			overlay = el("div", { class: "cms-modal__confirm" }, [panel]);
			overlay.addEventListener("click", (event) => {
				if (event.target !== overlay) return;
				closeConfirm();
			});
			root.appendChild(overlay);
			return;
		}

		const cancel = el(
			"button",
			{
				class: "cms-btn cms-btn--move cms-modal__action",
				type: "button",
				"data-close": "true",
			},
			["Cancel"],
		);
		const confirm = el(
			"button",
			{
				class: "cms-btn cms-btn--danger cms-modal__action",
				type: "button",
			},
			["Delete"],
		);
		confirm.addEventListener("click", () => {
			closeModal();
			if (typeof onConfirm === "function") onConfirm();
		});
		openModal({
			title: "Delete item",
			bodyNodes: [
				el("p", { class: "cms-modal__text" }, [
					"Delete this item? Unsaved changes will be lost if you continue.",
				]),
			],
			footerNodes: [cancel, confirm],
		});
	}

	function openGridItemModal({
		type,
		item = {},
		isNew = false,
		onSave,
		onDelete,
		scrollTarget = null,
	}) {
		const isHover = type === "hover";
		const itemLabel = isHover ? "card" : "image";
		const imgInput = el("input", {
			type: "text",
			class: "cms-field__input",
			value: item.src || "",
			placeholder: "/assets/img/...",
		});
		const altInput = el("input", {
			type: "text",
			class: "cms-field__input",
			value: item.alt || "",
			placeholder: "Alt text (optional)",
		});
		const overlayTitleInput = el("input", {
			type: "text",
			class: "cms-field__input",
			value: item.overlayTitle || "",
			placeholder: "Overlay title (optional)",
		});
		const overlayTextInput = el("input", {
			type: "text",
			class: "cms-field__input",
			value: item.overlayText || "",
			placeholder: "Overlay text (optional)",
		});
		const lightboxInput = el("input", {
			type: "checkbox",
			class: "cms-field__checkbox",
		});
		lightboxInput.checked = Boolean(item.lightbox);
		const imageModeSelect = el("select", { class: "cms-field__select" }, [
			el("option", { value: "existing" }, ["Use existing"]),
			el("option", { value: "upload" }, ["Upload new"]),
		]);
		imageModeSelect.value = "existing";
		const imageLibrarySelect = el("select", { class: "cms-field__select" }, [
			el("option", { value: "" }, ["Select an existing image"]),
		]);
		const imagePickBtn = el(
			"button",
			{
				class: "cms-btn cms-btn--primary cms-btn--inline",
				type: "button",
			},
			["Choose image"],
		);
		const uploadFileInput = el("input", {
			type: "file",
			class: "cms-field__input",
		});
		uploadFileInput.hidden = true;
		const uploadNameInput = el("input", {
			type: "text",
			class: "cms-field__input",
			placeholder: "Filename (e.g. hero.jpg or sub/hero.jpg)",
		});
		uploadNameInput.hidden = true;
		const uploadWarning = el(
			"div",
			{ class: "cms-modal__note cms-note--warning" },
			[
				"\u26a0 Please note: Uploaded images are only stored in local memory until comitted and could be lost \u26a0",
			],
		);
		uploadWarning.hidden = true;
		let currentUploadFile = null;
		let currentUploadBase64 = "";
		let currentUploadMime = "";
		let currentUploadPath = "";
		let currentUploadExt = "";
		const getFileExtension = (name) => {
			const match = String(name || "")
				.trim()
				.match(/(\.[A-Za-z0-9]+)$/);
			return match ? match[1] : "";
		};
		const normalizeUploadName = (rawName) => {
			const raw = String(rawName || "").trim();
			if (!raw) {
				if (currentUploadExt)
					return { name: currentUploadExt, caret: 0, empty: true };
				return { name: "", caret: 0, empty: true };
			}
			if (!currentUploadExt) return { name: raw, caret: raw.length };
			const lowerRaw = raw.toLowerCase();
			const lowerExt = currentUploadExt.toLowerCase();
			let base = raw;
			if (lowerRaw.endsWith(lowerExt)) {
				base = raw.slice(0, -currentUploadExt.length);
			}
			if (base.endsWith(".")) base = base.slice(0, -1);
			return {
				name: `${base}${currentUploadExt}`,
				caret: base.length,
				empty: !base,
			};
		};
		const syncUploadName = (rawName, { normalize = false } = {}) => {
			const normalized = normalizeUploadName(rawName);
			if (!normalized.name) return;
			if (normalized.empty && currentUploadExt) {
				if (normalize && uploadNameInput) {
					uploadNameInput.value = currentUploadExt;
					if (document.activeElement === uploadNameInput) {
						uploadNameInput.setSelectionRange(0, 0);
					}
				}
				return;
			}
			const safePath = sanitizeImagePath(
				normalized.name,
				currentUploadFile?.name || "",
			);
			if (!safePath) return;
			const safeName = safePath.replace(/^assets\/img\//, "");
			if (normalize && uploadNameInput) {
				uploadNameInput.value = safeName;
				if (currentUploadExt && document.activeElement === uploadNameInput) {
					const caret = Math.max(0, safeName.length - currentUploadExt.length);
					uploadNameInput.setSelectionRange(caret, caret);
				}
			}
			imgInput.value = `/${safePath}`;
			if (currentUploadBase64) {
				if (currentUploadPath && currentUploadPath !== safePath) {
					state.assetUploads = (state.assetUploads || []).filter(
						(item) => item.path !== currentUploadPath,
					);
				}
				addAssetUpload({
					name: safeName,
					content: currentUploadBase64,
					path: safePath,
					mime: currentUploadMime || "",
				});
				currentUploadPath = safePath;
			}
			updateImagePreview();
		};
		const stageUpload = (file, filename) => {
			if (!file) return;
			const safePath = sanitizeImagePath(filename, file.name || "");
			if (!safePath) return;
			const safeName = safePath.replace(/^assets\/img\//, "");
			if (uploadNameInput) uploadNameInput.value = safeName;
			const reader = new FileReader();
			reader.onload = () => {
				const dataUrl = String(reader.result || "");
				const base64 = dataUrl.split(",")[1] || "";
				currentUploadBase64 = base64;
				currentUploadMime = file.type || "";
				syncUploadName(uploadNameInput?.value.trim() || safeName, {
					normalize: true,
				});
			};
			reader.readAsDataURL(file);
		};
		imagePickBtn.addEventListener("click", () => {
			uploadFileInput?.click();
		});
		uploadFileInput.addEventListener("change", () => {
			const file = uploadFileInput.files?.[0];
			if (!file) return;
			currentUploadFile = file;
			currentUploadExt = getFileExtension(file.name || "");
			if (uploadNameInput && !uploadNameInput.value.trim()) {
				uploadNameInput.value = file.name || "";
			}
			stageUpload(file, uploadNameInput?.value.trim() || "");
		});
		uploadNameInput.addEventListener("input", () => {
			syncUploadName(uploadNameInput.value.trim(), { normalize: true });
		});
		uploadNameInput.addEventListener("blur", () => {
			if (!currentUploadFile) return;
			if (currentUploadBase64) {
				syncUploadName(uploadNameInput.value.trim(), { normalize: true });
				return;
			}
			stageUpload(currentUploadFile, uploadNameInput.value.trim());
		});
		const imagePreviewImg = el("img", {
			class: "cms-image-preview__img cms-image-preview__img--block",
			alt: "Preview",
		});
		const imagePreviewWrap = el(
			"div",
			{
				class:
					"cms-image-preview cms-image-preview--inline content content--full",
			},
			[imagePreviewImg],
		);
		const overlayLayer = el("div", { class: "content-overlay" });
		const overlayTitlePreview = el("h3", { class: "content-title" });
		const overlayTextPreview = el("p", { class: "content-text" });
		const overlayDetails = el(
			"div",
			{ class: "content-details fadeIn-bottom" },
			[overlayTitlePreview, overlayTextPreview],
		);
		imagePreviewWrap.appendChild(overlayLayer);
		imagePreviewWrap.appendChild(overlayDetails);
		const updateOverlayPreview = () => {
			if (!isHover || imagePreviewWrap.hidden) {
				overlayLayer.hidden = true;
				overlayDetails.hidden = true;
				return;
			}
			const title = overlayTitleInput.value.trim();
			const text = overlayTextInput.value.trim();
			const fallback =
				!title && !text && lightboxInput.checked ? "Click to view" : text;
			const show = Boolean(title || fallback);
			overlayLayer.hidden = !show;
			overlayDetails.hidden = !show;
			overlayTitlePreview.textContent = title;
			overlayTextPreview.textContent = fallback;
			overlayTitlePreview.hidden = !title;
			overlayTextPreview.hidden = !fallback;
		};
		const updateImagePreview = () => {
			const raw = imgInput.value.trim();
			let src = raw ? normalizeImageSource(raw) : "";
			if (src && !src.startsWith("data:")) {
				const local = getLocalAssetPath(src);
				const cached = local ? getCachedAssetDataUrl(local) : "";
				if (cached) src = cached;
			}
			if (!src) {
				imagePreviewWrap.hidden = true;
				imagePreviewImg.removeAttribute("src");
				updateOverlayPreview();
				return;
			}
			imagePreviewWrap.hidden = false;
			imagePreviewImg.src = src;
			if (imageLibrarySelect && !imageLibrarySelect.hidden) {
				const local = getLocalAssetPath(raw);
				if (local) imageLibrarySelect.value = local;
			}
			updateOverlayPreview();
		};
		const setImageMode = (mode) => {
			const useUpload = mode === "upload";
			imageLibrarySelect.hidden = useUpload;
			imagePickBtn.hidden = !useUpload;
			uploadNameInput.hidden = !useUpload;
			if (uploadNameLabel) uploadNameLabel.hidden = !useUpload;
			if (uploadNameRow) uploadNameRow.hidden = !useUpload;
			if (imgInput) {
				imgInput.disabled = useUpload;
				imgInput.classList.toggle("cms-field__input--muted", useUpload);
			}
			uploadWarning.hidden = !useUpload;
			if (!useUpload) {
				loadImageLibraryIntoSelect(imageLibrarySelect)
					.then(() => {
						const local = getLocalAssetPath(imgInput.value || "");
						if (local) imageLibrarySelect.value = local;
					})
					.catch((err) => console.error(err));
			}
			updateImagePreview();
		};
		imageModeSelect.addEventListener("change", () => {
			setImageMode(imageModeSelect.value);
		});
		imageLibrarySelect.addEventListener("change", () => {
			const path = imageLibrarySelect.value;
			if (!path) return;
			const safePath = sanitizeImagePath(path, "");
			if (!safePath) return;
			imgInput.value = `/${safePath}`;
			updateImagePreview();
		});
		imgInput.addEventListener("input", updateImagePreview);
		imgInput.addEventListener("input", () => {
			imgInput.classList.remove("cms-field__input--invalid");
		});
		imgInput.addEventListener("blur", () => {
			const normalized = normalizeImageSource(imgInput.value);
			if (normalized) imgInput.value = normalized;
			updateImagePreview();
		});
		lightboxInput.addEventListener("change", updateOverlayPreview);
		if (isHover) {
			overlayTitleInput.addEventListener("input", updateOverlayPreview);
			overlayTextInput.addEventListener("input", updateOverlayPreview);
		}

		const localPath = getLocalAssetPath(item.src || "");
		const uploadItem =
			localPath &&
			(state.assetUploads || []).find((entry) => entry.path === localPath);
		if (uploadItem) {
			imageModeSelect.value = "upload";
			currentUploadBase64 = uploadItem.content || "";
			currentUploadMime = uploadItem.mime || "";
			currentUploadPath = uploadItem.path || "";
			currentUploadExt = getFileExtension(uploadItem.path || "");
			uploadNameInput.value = uploadItem.path.replace(/^assets\/img\//, "");
		}

		let uploadNameLabel = null;
		let uploadNameRow = null;
		const imageRow = el("div", { class: "cms-field__row" }, [
			imgInput,
			imageModeSelect,
			imageLibrarySelect,
			imagePickBtn,
			uploadFileInput,
		]);
		let imageInput = imageRow;
		if (uploadNameInput) {
			uploadNameLabel = el("div", { class: "cms-field__label" }, ["Filename"]);
			uploadNameRow = el("div", { class: "cms-field__row" }, [uploadNameInput]);
			uploadNameRow.hidden = uploadNameInput.hidden;
			uploadNameLabel.hidden = uploadNameInput.hidden;
			imageInput = el("div", { class: "cms-field__stack" }, [
				imageRow,
				uploadNameLabel,
				uploadNameRow,
			]);
		}

		const displayRow = el("div", { class: "cms-field__row" }, [
			el("label", { class: "cms-field__toggle" }, [
				lightboxInput,
				el("span", { class: "cms-field__toggle-text" }, ["Lightbox"]),
			]),
		]);
		const displayField = buildField({ label: "Display", input: displayRow });
		const controls = [
			displayField,
			buildField({ label: "Alt text", input: altInput }),
		];
		if (isHover) {
			const overlayInputs = el("div", { class: "cms-field__stack" }, [
				overlayTitleInput,
				overlayTextInput,
			]);
			controls.push(buildField({ label: "Overlay", input: overlayInputs }));
		}
		const controlsWrap = el(
			"div",
			{ class: "cms-image-settings__controls" },
			controls,
		);
		const settingsRow = el("div", { class: "cms-image-settings" }, [
			el("div", { class: "cms-image-settings__preview" }, [imagePreviewWrap]),
			controlsWrap,
		]);

		const cancelBtn = el(
			"button",
			{
				class: "cms-btn cms-modal__action",
				type: "button",
				"data-close": "true",
			},
			["Cancel"],
		);
		const saveBtn = el(
			"button",
			{
				class: "cms-btn cms-btn--success cms-modal__action",
				type: "button",
			},
			[isNew ? `Add ${itemLabel}` : `Update ${itemLabel}`],
		);
		const deleteBtn = el(
			"button",
			{
				class: "cms-btn cms-btn--danger cms-modal__action",
				type: "button",
			},
			["Delete"],
		);

		saveBtn.addEventListener("click", () => {
			const src = normalizeImageSource(imgInput.value.trim());
			if (!src) {
				imgInput.classList.add("cms-field__input--invalid");
				imgInput.focus();
				return;
			}
			const alt = altInput.value.trim();
			const lightbox = lightboxInput.checked;
			const overlayTitle = isHover ? overlayTitleInput.value.trim() : "";
			let overlayText = isHover ? overlayTextInput.value.trim() : "";
			if (isHover && !overlayTitle && !overlayText && lightbox) {
				overlayText = "Click to view";
			}
			const payload = {
				src,
				alt,
				lightbox,
				overlayTitle,
				overlayText,
			};
			if (typeof onSave === "function") onSave(payload);
			closeModal();
		});

		if (onDelete) {
			deleteBtn.addEventListener("click", () => {
				confirmDeleteItem(() => {
					onDelete();
				});
			});
		}

		setImageMode(imageModeSelect.value);
		loadImageLibraryIntoSelect(imageLibrarySelect).catch((err) =>
			console.error(err),
		);
		updateImagePreview();

		openModal({
			title: isNew ? `Add ${itemLabel}` : `Edit ${itemLabel}`,
			bodyNodes: [
				buildField({ label: "Image source", input: imageInput }),
				uploadWarning,
				buildField({ label: "Image settings", input: settingsRow }),
			],
			footerNodes: onDelete
				? [cancelBtn, deleteBtn, saveBtn]
				: [cancelBtn, saveBtn],
			scrollTarget,
		});
	}

	function attachGridRowControls({
		wrapper,
		type,
		origin,
		localId,
		anchorBase,
	}) {
		if (!(wrapper instanceof HTMLElement)) return;
		const root = getBlockRootElement(wrapper);
		if (!root) return;
		const isHover = type === "hoverCardRow";
		const isSquare = type === "squareGridRow";
		if (!isHover && !isSquare) return;
		const buildAction = (iconName, label, className = "") =>
			el(
				"button",
				{
					type: "button",
					class: ["cms-grid-action", className].filter(Boolean).join(" "),
					title: label,
					"aria-label": label,
				},
				[
					el(
						"span",
						{ class: "material-icons cms-grid__icon", "aria-hidden": "true" },
						[iconName],
					),
				],
			);
		const maxCards = 5;
		const updateCards = (updateFn) => {
			const blockRoot = getBlockRootElement(wrapper);
			if (!blockRoot) return;
			const parsed = parseMainBlockNode(blockRoot);
			if (
				!parsed ||
				(parsed.type !== "hoverCardRow" && parsed.type !== "squareGridRow")
			)
				return;
			const nextModel = updateFn(parsed);
			if (!nextModel) return;
			const updatedHtml = serializeMainBlocks([nextModel], {
				path: state.path,
			}).trim();
			if (!updatedHtml) return;
			if (origin === "base" && anchorBase?.id) {
				const baseBlocks = buildBaseBlocksWithOcc(state.originalHtml || "");
				const baseBlock = baseBlocks.find((b) => b.id === anchorBase.id);
				const baseSig = buildBlockNoopSignature(baseBlock?.html || "");
				const updatedSig = buildBlockNoopSignature(updatedHtml);
				if (baseSig && updatedSig && baseSig === updatedSig) return;
			}
			const baseHtml = state.originalHtml || "";
			const currentLocal = getHydratedLocalBlocks(
				baseHtml,
				state.dirtyPages[state.path]?.localBlocks || [],
			);
			applyBlockHtmlUpdate({
				origin,
				localId,
				anchorBase,
				currentLocal,
				updatedHtml,
			});
		};

		if (isHover) {
			const cards = Array.from(root.querySelectorAll(".content.box.box-img"));
			const buildInsertButton = (insertIndex) => {
				const btn = el(
					"button",
					{
						type: "button",
						class: "cms-divider-btn cms-grid-insert",
						title: "Add card",
						"aria-label": "Add card",
					},
					[
						el("span", { class: "cms-divider-line", "aria-hidden": "true" }),
						el("span", { class: "cms-divider-plus", "aria-hidden": "true" }, [
							"＋",
						]),
						el("span", { class: "cms-divider-line", "aria-hidden": "true" }),
					],
				);
				btn.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					const parsed = parseMainBlockNode(getBlockRootElement(wrapper));
					const currentCount = parsed?.cards?.length || 0;
					if (currentCount >= maxCards) {
						openGridLimitWarning(maxCards);
						return;
					}
					openGridItemModal({
						type: "hover",
						item: { lightbox: true },
						isNew: true,
						scrollTarget: root,
						onSave: (next) => {
							updateCards((model) => {
								const nextCards = [...(model.cards || [])];
								nextCards.splice(insertIndex, 0, {
									src: next.src,
									alt: next.alt,
									lightbox: next.lightbox,
									overlayTitle: next.overlayTitle,
									overlayText: next.overlayText,
								});
								return { ...model, cards: nextCards };
							});
						},
					});
				});
				return btn;
			};
			const renderInsertButtons = () => {
				root.querySelectorAll(".cms-grid-insert").forEach((node) =>
					node.remove(),
				);
				const currentCards = Array.from(
					root.querySelectorAll(".content.box.box-img"),
				);
				for (let i = 0; i <= currentCards.length; i += 1) {
					const btn = buildInsertButton(i);
					if (i >= currentCards.length) {
						root.appendChild(btn);
					} else {
						root.insertBefore(btn, currentCards[i]);
					}
				}
			};
			cards.forEach((card, idx) => {
				if (!(card instanceof HTMLElement)) return;
				card.classList.add("cms-grid-card");
				if (card.querySelector(".cms-grid-actions")) return;
				const actions = el("div", { class: "cms-grid-actions" }, []);
				const editBtn = buildAction(
					"edit",
					"Edit card",
					"cms-grid-action--edit",
				);
				const leftBtn = buildAction(
					"chevron_left",
					"Move left",
					"cms-grid-action--move",
				);
				const rightBtn = buildAction(
					"chevron_right",
					"Move right",
					"cms-grid-action--move",
				);
				const deleteBtn = buildAction(
					"delete",
					"Delete card",
					"cms-grid-action--danger",
				);

				editBtn.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					const parsed = parseMainBlockNode(getBlockRootElement(wrapper));
					const current = parsed?.cards?.[idx] || {};
					openGridItemModal({
						type: "hover",
						item: current,
						isNew: false,
						scrollTarget: card,
						onSave: (next) => {
							updateCards((model) => {
								const nextCards = [...(model.cards || [])];
								nextCards[idx] = {
									src: next.src,
									alt: next.alt,
									lightbox: next.lightbox,
									overlayTitle: next.overlayTitle,
									overlayText: next.overlayText,
								};
								return { ...model, cards: nextCards };
							});
						},
						onDelete: () => {
							updateCards((model) => {
								const nextCards = [...(model.cards || [])];
								nextCards.splice(idx, 1);
								return { ...model, cards: nextCards };
							});
						},
					});
				});
				leftBtn.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					updateCards((model) => {
						const nextCards = [...(model.cards || [])];
						if (idx <= 0 || idx >= nextCards.length) return model;
						const [moving] = nextCards.splice(idx, 1);
						nextCards.splice(idx - 1, 0, moving);
						return { ...model, cards: nextCards };
					});
				});
				rightBtn.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					updateCards((model) => {
						const nextCards = [...(model.cards || [])];
						if (idx < 0 || idx >= nextCards.length - 1) return model;
						const [moving] = nextCards.splice(idx, 1);
						nextCards.splice(idx + 1, 0, moving);
						return { ...model, cards: nextCards };
					});
				});
				deleteBtn.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					confirmDeleteItem(() => {
						updateCards((model) => {
							const nextCards = [...(model.cards || [])];
							nextCards.splice(idx, 1);
							return { ...model, cards: nextCards };
						});
					});
				});

				actions.appendChild(editBtn);
				actions.appendChild(leftBtn);
				actions.appendChild(rightBtn);
				actions.appendChild(deleteBtn);
				card.appendChild(actions);
			});
			renderInsertButtons();
			return;
		}

		if (isSquare) {
			const items = Array.from(root.querySelectorAll(".box"));
			const buildInsertButton = (insertIndex) => {
				const btn = el(
					"button",
					{
						type: "button",
						class: "cms-divider-btn cms-grid-insert",
						title: "Add image",
						"aria-label": "Add image",
					},
					[
						el("span", { class: "cms-divider-line", "aria-hidden": "true" }),
						el("span", { class: "cms-divider-plus", "aria-hidden": "true" }, [
							"＋",
						]),
						el("span", { class: "cms-divider-line", "aria-hidden": "true" }),
					],
				);
				btn.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					const parsed = parseMainBlockNode(getBlockRootElement(wrapper));
					const currentCount = parsed?.items?.length || 0;
					if (currentCount >= maxCards) {
						openGridLimitWarning(maxCards);
						return;
					}
					openGridItemModal({
						type: "square",
						item: { lightbox: true },
						isNew: true,
						scrollTarget: root,
						onSave: (next) => {
							updateCards((model) => {
								const nextItems = [...(model.items || [])];
								nextItems.splice(insertIndex, 0, {
									src: next.src,
									alt: next.alt,
									lightbox: next.lightbox,
								});
								return { ...model, items: nextItems };
							});
						},
					});
				});
				return btn;
			};
			const renderInsertButtons = () => {
				root.querySelectorAll(".cms-grid-insert").forEach((node) =>
					node.remove(),
				);
				const currentItems = Array.from(root.querySelectorAll(".box"));
				for (let i = 0; i <= currentItems.length; i += 1) {
					const btn = buildInsertButton(i);
					if (i >= currentItems.length) {
						root.appendChild(btn);
					} else {
						root.insertBefore(btn, currentItems[i]);
					}
				}
			};
			items.forEach((box, idx) => {
				if (!(box instanceof HTMLElement)) return;
				box.classList.add("cms-grid-card", "cms-grid-card--square");
				if (box.querySelector(".cms-grid-actions")) return;
				const actions = el("div", { class: "cms-grid-actions" }, []);
				const editBtn = buildAction(
					"edit",
					"Edit image",
					"cms-grid-action--edit",
				);
				const leftBtn = buildAction(
					"chevron_left",
					"Move left",
					"cms-grid-action--move",
				);
				const rightBtn = buildAction(
					"chevron_right",
					"Move right",
					"cms-grid-action--move",
				);
				const deleteBtn = buildAction(
					"delete",
					"Delete image",
					"cms-grid-action--danger",
				);

				editBtn.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					const parsed = parseMainBlockNode(getBlockRootElement(wrapper));
					const current = parsed?.items?.[idx] || {};
					openGridItemModal({
						type: "square",
						item: current,
						isNew: false,
						scrollTarget: box,
						onSave: (next) => {
							updateCards((model) => {
								const nextItems = [...(model.items || [])];
								nextItems[idx] = {
									src: next.src,
									alt: next.alt,
									lightbox: next.lightbox,
								};
								return { ...model, items: nextItems };
							});
						},
						onDelete: () => {
							updateCards((model) => {
								const nextItems = [...(model.items || [])];
								nextItems.splice(idx, 1);
								return { ...model, items: nextItems };
							});
						},
					});
				});
				leftBtn.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					updateCards((model) => {
						const nextItems = [...(model.items || [])];
						if (idx <= 0 || idx >= nextItems.length) return model;
						const [moving] = nextItems.splice(idx, 1);
						nextItems.splice(idx - 1, 0, moving);
						return { ...model, items: nextItems };
					});
				});
				rightBtn.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					updateCards((model) => {
						const nextItems = [...(model.items || [])];
						if (idx < 0 || idx >= nextItems.length - 1) return model;
						const [moving] = nextItems.splice(idx, 1);
						nextItems.splice(idx + 1, 0, moving);
						return { ...model, items: nextItems };
					});
				});
				deleteBtn.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					confirmDeleteItem(() => {
						updateCards((model) => {
							const nextItems = [...(model.items || [])];
							nextItems.splice(idx, 1);
							return { ...model, items: nextItems };
						});
					});
				});

				actions.appendChild(editBtn);
				actions.appendChild(leftBtn);
				actions.appendChild(rightBtn);
				actions.appendChild(deleteBtn);
				box.appendChild(actions);
			});
			renderInsertButtons();
		}
	}

	function openBlockEditor({
		blockHtml,
		origin,
		localId,
		anchorBase,
		currentLocal,
	}) {
		const doc = new DOMParser().parseFromString(
			`<div id="__wrap__">${String(blockHtml || "")}</div>`,
			"text/html",
		);
		const node = doc.querySelector("#__wrap__")?.firstElementChild;
		if (!node) return;
		const parsed = parseMainBlockNode(node);
		const blockId = parsed.cmsId || anchorBase?.id || parsed.baseId || "";
		const ctx = {
			path: state.path,
			blockId,
			blockIdShort: hashText(String(blockId || "block")).slice(0, 4),
		};
		const buildNoopSignature = (html) => {
			const doc = new DOMParser().parseFromString(
				`<div id="__wrap__">${String(html || "")}</div>`,
				"text/html",
			);
			const wrap = doc.querySelector("#__wrap__");
			if (!wrap) return "";
			const stripHighlightMarkup = (root) => {
				root.querySelectorAll("[data-cms-preview]").forEach((el) => el.remove());
				root.querySelectorAll("pre code").forEach((code) => {
					code.classList.remove("hljs");
					code.removeAttribute("data-highlighted");
					code.textContent = code.textContent || "";
				});
				root.querySelectorAll("span").forEach((span) => {
					const cls = span.getAttribute("class") || "";
					const isHljs = cls
						.split(/\s+/)
						.some((c) => c === "hljs" || c.startsWith("hljs-"));
					if (!isHljs) return;
					span.replaceWith(document.createTextNode(span.textContent || ""));
				});
			};
			const normalizeNode = (node, inPre) => {
				if (node.nodeType === Node.TEXT_NODE) {
					if (inPre) return;
					const cleaned = String(node.textContent || "")
						.replace(/\s+/g, " ")
						.trim();
					if (!cleaned) {
						node.remove();
						return;
					}
					node.textContent = cleaned;
					return;
				}
				if (node.nodeType !== Node.ELEMENT_NODE) return;
				const tag = (node.tagName || "").toLowerCase();
				const nextInPre = inPre || tag === "pre" || tag === "code";
				if (node.classList?.contains("hljs")) node.classList.remove("hljs");
				if (node.hasAttribute?.("data-highlighted"))
					node.removeAttribute("data-highlighted");
				if (tag === "code") {
					node.classList?.remove("hljs");
					node.removeAttribute?.("data-highlighted");
				}
				if (node.classList && node.classList.length) {
					Array.from(node.classList).forEach((cls) => {
						if (cls.startsWith("cms-")) node.classList.remove(cls);
					});
				}
				if (node.hasAttribute("data-cms-id")) {
					node.removeAttribute("data-cms-id");
				}
				Array.from(node.childNodes).forEach((child) =>
					normalizeNode(child, nextInPre),
				);
				const attrs = Array.from(node.attributes).sort((a, b) =>
					a.name.localeCompare(b.name),
				);
				attrs.forEach((attr) => node.removeAttribute(attr.name));
				attrs.forEach((attr) => node.setAttribute(attr.name, attr.value));
			};

			const parts = [];
			Array.from(wrap.childNodes).forEach((child) => {
				if (child.nodeType === Node.ELEMENT_NODE) {
					const clone = child.cloneNode(true);
					stripHighlightMarkup(clone);
					normalizeNode(clone, false);
					parts.push(clone.outerHTML);
					return;
				}
				if (child.nodeType === Node.TEXT_NODE) {
					const text = String(child.textContent || "")
						.replace(/\s+/g, " ")
						.trim();
					if (text) parts.push(`#text:${text}`);
				}
			});
			return parts.join("\n");
		};
		const baseCanonicalHtml = (() => {
			try {
				return serializeMainBlocks([parsed], { path: state.path }).trim();
			} catch (err) {
				console.warn("[cms-portal] base canonical failed", err);
				return "";
			}
		})();
		const baseSig = buildNoopSignature(baseCanonicalHtml || blockHtml || "");
		const escapeSelector = (value) => {
			if (!value) return "";
			if (window.CSS && typeof window.CSS.escape === "function")
				return window.CSS.escape(value);
			return String(value).replace(/["\\]/g, "\\$&");
		};
		const scrollToEditedBlock = () => {
			const root = qs("#cms-portal");
			if (!root) return;
			let target = null;
			if (blockId) {
				const safeId = escapeSelector(blockId);
				target =
					root.querySelector(`[data-cms-id="${safeId}"]`) ||
					root.querySelector(`.cms-block[data-base-id="${safeId}"]`);
			}
			if (!target && anchorBase?.sig) {
				const safeSig = escapeSelector(anchorBase.sig);
				target = root.querySelector(`.cms-block[data-base-sig="${safeSig}"]`);
			}
			if (!target) return;
			const block = target.classList.contains("cms-block")
				? target
				: target.closest(".cms-block") || target;
			block.scrollIntoView({ block: "center", behavior: "smooth" });
		};
		const handleExitEdit = () => {
			closeModal();
			queueMicrotask(() => scrollToEditedBlock());
		};
		let getEditorChangeState = async () => false;
		const bindModalCloseHandler = (closeHandler) => {
			const root = qs("#cms-modal");
			if (!root) return;
			root.querySelectorAll("[data-close='true']").forEach((btn) => {
				btn.addEventListener(
					"click",
					() => {
						closeHandler();
					},
					{ once: true },
				);
			});
		};
		const openExitConfirm = async () => {
			const root = qs("#cms-modal");
			if (!root) return;
			const existing = root.querySelector(".cms-modal__confirm");
			if (existing) return;
			const hasChanges = await getEditorChangeState().catch(() => true);
			if (!hasChanges) {
				handleExitEdit();
				return;
			}
			let overlay = null;
			const closeConfirm = () => {
				if (overlay) overlay.remove();
			};
			const cancel = el(
				"button",
				{
					class: "cms-btn cms-btn--move cms-modal__action",
					type: "button",
				},
				["Cancel"],
			);
			const saveBtn = root.querySelector('[data-action="save-block"]');
			const saveClose = saveBtn
				? el(
						"button",
						{
							class: "cms-btn cms-modal__action cms-btn--success",
							type: "button",
						},
						["Save and Close"],
					)
				: null;
			const confirm = el(
				"button",
				{
					class: "cms-btn cms-modal__action cms-btn--danger",
					type: "button",
				},
				["Exit"],
			);
			cancel.addEventListener("click", (event) => {
				event.preventDefault();
				closeConfirm();
				bindModalCloseHandler(openExitConfirm);
			});
			if (saveClose) {
				saveClose.addEventListener("click", (event) => {
					event.preventDefault();
					closeConfirm();
					bindModalCloseHandler(openExitConfirm);
					saveBtn.click();
				});
			}
			confirm.addEventListener("click", (event) => {
				event.preventDefault();
				closeConfirm();
				handleExitEdit();
			});
			const warning = el(
				"div",
				{ class: "cms-modal__note cms-note--warning" },
				[
					"\u26a0 You have unsaved changes. Are you sure you want to exit? \u26a0",
				],
			);
			const panel = el("div", { class: "cms-modal__confirm-panel" }, [
				el("h3", { class: "cms-modal__confirm-title" }, ["Exit editor"]),
				warning,
				el("div", { class: "cms-modal__confirm-actions" }, [
					cancel,
					...(saveClose ? [saveClose] : []),
					confirm,
				]),
			]);
			overlay = el("div", { class: "cms-modal__confirm" }, [panel]);
			overlay.addEventListener("click", (event) => {
				if (event.target !== overlay) return;
				closeConfirm();
				bindModalCloseHandler(openExitConfirm);
			});
			root.appendChild(overlay);
		};

		if (parsed.type === "hoverCardRow" || parsed.type === "squareGridRow") {
			openModal({
				title: "Edit block",
				bodyNodes: [
					el("p", { class: "cms-modal__text" }, [
						"Editor for this block type is coming next.",
					]),
				],
				footerNodes: [
					el(
						"button",
						{
							class: "cms-btn cms-modal__action cms-btn--danger",
							type: "button",
							"data-close": "true",
						},
						["Stop Editing Block"],
					),
				],
				onClose: openExitConfirm,
			});
			return;
		}

		if (parsed.type === "legacy") {
			openModal({
				title: "Edit block",
				bodyNodes: [
					el("p", { class: "cms-modal__text" }, [
						"This block isn't editable yet (legacy markup).",
					]),
				],
				footerNodes: [
					el(
						"button",
						{
							class: "cms-btn cms-modal__action cms-btn--danger",
							type: "button",
							"data-close": "true",
						},
						["Stop Editing Block"],
					),
				],
				onClose: openExitConfirm,
			});
			return;
		}

		let editors = [];
		let settings = {};
		let toolbarController = null;
		const ensureToolbar = () => {
			if (!toolbarController)
				toolbarController = createRteToolbarController();
			return toolbarController;
		};
		const toolbarHost = () =>
			toolbarController
				? el("div", { class: "cms-rte__toolbar-host" }, [
						toolbarController.toolbar,
					])
				: null;
		if (parsed.type === "portfolioGrid") {
			const normalized = normalizePortfolioGrid(parsed);
			const titleInput = el("input", {
				type: "text",
				class: "cms-field__input",
				value: normalized.title || "",
				placeholder: "Portfolio header",
			});
			const titleAlignSelect = buildAlignSelect(
				normalized.titleAlign || "center",
				"center",
				normalized.titleAnchor || "",
			);
			const introHtml = (() => {
				const raw = String(normalized.intro || "").trim();
				if (!raw) return "";
				if (/<[a-z][\s\S]*>/i.test(raw)) return raw;
				return `<p>${escapeHtml(raw)}</p>`;
			})();
			const introEditor = buildRteEditor({
				label: "Intro",
				initialHtml: introHtml,
				toolbarController: ensureToolbar(),
			});
			introEditor.wrap.classList.add("cms-rte__field--intro");
			introEditor.wrap.classList.add("cms-rte__field--light");
			const maxVisibleInput = el("input", {
				type: "text",
				class: "cms-field__input",
				value: normalized.maxVisible > 0 ? String(normalized.maxVisible) : "*",
				placeholder: "3",
			});
			const showSearchInput = el("input", {
				type: "checkbox",
				class: "cms-field__checkbox",
			});
			showSearchInput.checked = normalized.showSearch !== false;
			const showTypesInput = el("input", {
				type: "checkbox",
				class: "cms-field__checkbox",
			});
			showTypesInput.checked = normalized.showTypeFilters !== false;
			const showTagsInput = el("input", {
				type: "checkbox",
				class: "cms-field__checkbox",
			});
			showTagsInput.checked = normalized.showTagFilters !== false;
			const showLinksInput = el("input", {
				type: "checkbox",
				class: "cms-field__checkbox",
			});
			showLinksInput.checked = normalized.showLinkFilters !== false;

			const toggleRow = el("div", { class: "cms-field__row" }, [
				el("label", { class: "cms-field__toggle" }, [
					showSearchInput,
					el("span", { class: "cms-field__toggle-text" }, ["Search"]),
				]),
				el("label", { class: "cms-field__toggle" }, [
					showTypesInput,
					el("span", { class: "cms-field__toggle-text" }, ["Categories"]),
				]),
				el("label", { class: "cms-field__toggle" }, [
					showTagsInput,
					el("span", { class: "cms-field__toggle-text" }, ["Tags"]),
				]),
				el("label", { class: "cms-field__toggle" }, [
					showLinksInput,
					el("span", { class: "cms-field__toggle-text" }, ["Links"]),
				]),
			]);

			const cardsWrap = el("div", {
				class: "cms-modal__subgroup cms-portfolio-cards",
			});
			const portfolioCards = [];
			const typeOptions = new Set();
			(normalized.cards || []).forEach((card) => {
				const label = normalizePortfolioTypeLabel(card.type);
				if (label) typeOptions.add(label);
			});
			const getTypeList = () =>
				Array.from(typeOptions).sort((a, b) => a.localeCompare(b));
			let imageLibraryPromise = null;
			const getImageLibrary = () => {
				if (!imageLibraryPromise)
					imageLibraryPromise = fetchImageLibrary().catch((err) => {
						console.error(err);
						return [];
					});
				return imageLibraryPromise;
			};
			const populateImageSelect = (select) => {
				if (!select) return;
				getImageLibrary().then((images) => {
					select.innerHTML = "";
					select.appendChild(
						el("option", { value: "" }, ["Select an image"]),
					);
					images
						.sort((a, b) => String(a.path).localeCompare(String(b.path)))
						.forEach((item) => {
							const label = String(item.path || "").replace(
								/^assets\/img\//,
								"",
							);
							select.appendChild(
								el("option", { value: item.path }, [label || item.name]),
							);
						});
				});
			};
			const typeManagerInput = el("textarea", {
				class: "cms-field__input cms-field__textarea",
				placeholder: "Work, Academic, Personal",
			});
			const typeManagerApply = el(
				"button",
				{
					type: "button",
					class: "cms-btn cms-btn--success cms-btn--inline",
				},
				["Apply"],
			);
			const typeManagerCancel = el(
				"button",
				{
					type: "button",
					class: "cms-btn cms-btn--move cms-btn--inline",
				},
				["Cancel"],
			);
			const typeManagerWrap = el(
				"div",
				{ class: "cms-portfolio-type-manager" },
				[
					el("div", { class: "cms-modal__group-title" }, ["Manage categories"]),
					typeManagerInput,
					el("div", { class: "cms-field__note" }, [
						"Comma-separated list used by the category dropdown.",
					]),
					el("div", { class: "cms-field__row" }, [
						typeManagerCancel,
						typeManagerApply,
					]),
				],
			);
			typeManagerWrap.hidden = true;
			const openTypeManager = () => {
				typeManagerInput.value = getTypeList().join(", ");
				typeManagerWrap.hidden = false;
			};
			const closeTypeManager = () => {
				typeManagerWrap.hidden = true;
			};
			typeManagerCancel.addEventListener("click", (event) => {
				event.preventDefault();
				closeTypeManager();
			});
			typeManagerApply.addEventListener("click", (event) => {
				event.preventDefault();
				const next = typeManagerInput.value
					.split(",")
					.map((item) => String(item || "").trim())
					.filter(Boolean);
				typeOptions.clear();
				next.forEach((item) => typeOptions.add(item));
				syncTypeSelects();
				closeTypeManager();
			});
			const syncCards = () => {
				cardsWrap.innerHTML = "";
				portfolioCards.forEach((item, idx) => {
					item.titleEl.textContent = `Card ${idx + 1}`;
					item.upBtn.disabled = idx === 0;
					item.downBtn.disabled = idx === portfolioCards.length - 1;
					cardsWrap.appendChild(item.wrap);
				});
			};
			const buildCard = (data) => {
				const titleEl = el("div", { class: "cms-modal__group-title" }, [
					"Card",
				]);
				const titleInput = el("input", {
					type: "text",
					class: "cms-field__input cms-field__input--title",
					value: data.title || "",
					placeholder: "Project title",
				});
				const typeSelect = el("select", { class: "cms-field__select" }, [
					el("option", { value: "" }, ["Select category"]),
				]);
				const typeInput = el("input", {
					type: "text",
					class: "cms-field__input cms-field__input--category",
					value: data.type || "",
					placeholder: "New category",
				});
				const typeAddBtn = el(
					"button",
					{
						type: "button",
						class: "cms-btn cms-btn--success cms-btn--inline",
						"data-tooltip": "Add to category list",
						"aria-label": "Add category to list",
					},
					["Add"],
				);
				const typeInfoBtn = el(
					"button",
					{
						type: "button",
						class: "cms-btn cms-btn--info cms-btn--inline",
						"data-tooltip": "Manage category list (comma separated)",
						"aria-label": "Manage category list",
					},
					["i"],
				);
				const typeRow = el("div", { class: "cms-portfolio-type-row" }, [
					titleInput,
					typeSelect,
					typeInput,
					typeAddBtn,
					typeInfoBtn,
				]);
				const startInput = el("input", {
					type: "text",
					class: "cms-field__input",
					value: data.start || "",
					placeholder: "Start (MM-YYYY)",
				});
				const endInput = el("input", {
					type: "text",
					class: "cms-field__input",
					value: data.end || "",
					placeholder: "End (MM-YYYY or present)",
				});
				const summaryRaw = String(data.summary || "").trim();
				const summaryHtml = summaryRaw
					? /<[a-z][\s\S]*>/i.test(summaryRaw)
						? summaryRaw
						: `<p>${escapeHtml(summaryRaw).replace(/\n/g, "<br />")}</p>`
					: "";
				const summaryEditor = buildRteEditor({
					label: "Summary",
					initialHtml: summaryHtml,
					toolbarController: ensureToolbar(),
					allowedCommands: ["bold", "italic", "underline", "link", "ul", "ol"],
				});
				summaryEditor.wrap.classList.add("cms-portfolio-summary");
				const tagsInput = el("input", {
					type: "text",
					class: "cms-field__input",
					value: (data.tags || []).join(", "),
					placeholder: "Tags (comma separated)",
				});
				const siteInput = el("input", {
					type: "text",
					class: "cms-field__input",
					value: data.links?.site || "",
					placeholder: "Website link",
				});
				const githubInput = el("input", {
					type: "text",
					class: "cms-field__input",
					value: data.links?.github || "",
					placeholder: "GitHub link",
				});
				const youtubeInput = el("input", {
					type: "text",
					class: "cms-field__input",
					value: data.links?.youtube || "",
					placeholder: "YouTube link",
				});
				const facebookInput = el("input", {
					type: "text",
					class: "cms-field__input",
					value: data.links?.facebook || "",
					placeholder: "Facebook/social link",
				});

				const galleryToggle = el("input", {
					type: "checkbox",
					class: "cms-field__checkbox",
				});
				const galleryItems = Array.isArray(data.gallery)
					? data.gallery.slice()
					: [];
				galleryToggle.checked = galleryItems.length > 0;
				const galleryInput = el("input", {
					type: "text",
					class: "cms-field__input",
					placeholder: "/assets/img/...",
				});
				const galleryModeSelect = el("select", { class: "cms-field__select" }, [
					el("option", { value: "existing" }, ["Use existing"]),
					el("option", { value: "upload" }, ["Upload new"]),
				]);
				galleryModeSelect.value = "existing";
				const gallerySelect = el("select", { class: "cms-field__select" }, [
					el("option", { value: "" }, ["Select an image"]),
				]);
				const galleryPickBtn = el(
					"button",
					{
						type: "button",
						class: "cms-btn cms-btn--primary cms-btn--inline",
					},
					["Choose image"],
				);
				const galleryFileInput = el("input", {
					type: "file",
					class: "cms-field__input",
				});
				galleryFileInput.hidden = true;
				const galleryNameInput = el("input", {
					type: "text",
					class: "cms-field__input",
					placeholder: "Filename (e.g. hero.jpg or sub/hero.jpg)",
				});
				galleryNameInput.hidden = true;
				const galleryWarning = el(
					"div",
					{ class: "cms-modal__note cms-note--warning" },
					[
						"\u26a0 Please note: Uploaded images are only stored in local memory until comitted and could be lost \u26a0",
					],
				);
				galleryWarning.hidden = true;
				let galleryUploadFile = null;
				let galleryUploadBase64 = "";
				let galleryUploadMime = "";
				let galleryUploadPath = "";
				let galleryUploadExt = "";
				const getFileExtension = (name) => {
					const match = String(name || "")
						.trim()
						.match(/(\.[A-Za-z0-9]+)$/);
					return match ? match[1] : "";
				};
				const normalizeUploadName = (rawName) => {
					const raw = String(rawName || "").trim();
					if (!raw) {
						if (galleryUploadExt)
							return { name: galleryUploadExt, caret: 0, empty: true };
						return { name: "", caret: 0, empty: true };
					}
					if (!galleryUploadExt) return { name: raw, caret: raw.length };
					const lowerRaw = raw.toLowerCase();
					const lowerExt = galleryUploadExt.toLowerCase();
					let base = raw;
					if (lowerRaw.endsWith(lowerExt)) {
						base = raw.slice(0, -galleryUploadExt.length);
					}
					if (base.endsWith(".")) base = base.slice(0, -1);
					return {
						name: `${base}${galleryUploadExt}`,
						caret: base.length,
						empty: !base,
					};
				};
				const syncUploadName = (rawName, { normalize = false } = {}) => {
					const normalized = normalizeUploadName(rawName);
					if (!normalized.name) return;
					if (normalized.empty && galleryUploadExt) {
						if (normalize && galleryNameInput) {
							galleryNameInput.value = galleryUploadExt;
							if (document.activeElement === galleryNameInput) {
								galleryNameInput.setSelectionRange(0, 0);
							}
						}
						return;
					}
					const safePath = sanitizeImagePath(
						normalized.name,
						galleryUploadFile?.name || "",
					);
					if (!safePath) return;
					const safeName = safePath.replace(/^assets\/img\//, "");
					if (normalize && galleryNameInput) {
						galleryNameInput.value = safeName;
						if (galleryUploadExt && document.activeElement === galleryNameInput) {
							const caret = Math.max(
								0,
								safeName.length - galleryUploadExt.length,
							);
							galleryNameInput.setSelectionRange(caret, caret);
						}
					}
					galleryInput.value = `/${safePath}`;
					if (galleryUploadBase64) {
						if (galleryUploadPath && galleryUploadPath !== safePath) {
							state.assetUploads = (state.assetUploads || []).filter(
								(item) => item.path !== galleryUploadPath,
							);
						}
						addAssetUpload({
							name: safeName,
							content: galleryUploadBase64,
							path: safePath,
							mime: galleryUploadMime || "",
						});
						galleryUploadPath = safePath;
					}
				};
				const stageUpload = (file, filename) => {
					if (!file) return;
					const safePath = sanitizeImagePath(filename, file.name || "");
					if (!safePath) return;
					const safeName = safePath.replace(/^assets\/img\//, "");
					if (galleryNameInput) galleryNameInput.value = safeName;
					const reader = new FileReader();
					reader.onload = () => {
						const dataUrl = String(reader.result || "");
						const base64 = dataUrl.split(",")[1] || "";
						galleryUploadBase64 = base64;
						galleryUploadMime = file.type || "";
						syncUploadName(galleryNameInput?.value.trim() || safeName, {
							normalize: true,
						});
					};
					reader.readAsDataURL(file);
				};
				galleryPickBtn.addEventListener("click", () => {
					galleryFileInput?.click();
				});
				galleryFileInput.addEventListener("change", () => {
					const file = galleryFileInput.files?.[0];
					if (!file) return;
					galleryUploadFile = file;
					galleryUploadExt = getFileExtension(file.name || "");
					if (galleryNameInput && !galleryNameInput.value.trim()) {
						galleryNameInput.value = file.name || "";
					}
					stageUpload(file, galleryNameInput?.value.trim() || "");
				});
				galleryNameInput.addEventListener("input", () => {
					syncUploadName(galleryNameInput.value.trim(), { normalize: true });
				});
				galleryNameInput.addEventListener("blur", () => {
					if (!galleryUploadFile) return;
					if (galleryUploadBase64) {
						syncUploadName(galleryNameInput.value.trim(), { normalize: true });
						return;
					}
					stageUpload(galleryUploadFile, galleryNameInput.value.trim());
				});
				const setGalleryMode = (mode) => {
					const useUpload = mode === "upload";
					gallerySelect.hidden = useUpload;
					galleryPickBtn.hidden = !useUpload;
					galleryNameInput.hidden = !useUpload;
					if (galleryNameLabel) galleryNameLabel.hidden = !useUpload;
					if (galleryNameRow) galleryNameRow.hidden = !useUpload;
					if (galleryInput) {
						galleryInput.disabled = useUpload;
						galleryInput.classList.toggle("cms-field__input--muted", useUpload);
					}
					galleryWarning.hidden = !useUpload;
					if (!useUpload) {
						loadImageLibraryIntoSelect(gallerySelect)
							.then(() => {
								const local = getLocalAssetPath(galleryInput.value || "");
								if (local) gallerySelect.value = local;
							})
							.catch((err) => console.error(err));
					}
				};
				galleryModeSelect.addEventListener("change", () => {
					setGalleryMode(galleryModeSelect.value);
				});
				gallerySelect.addEventListener("change", () => {
					const path = gallerySelect.value;
					if (!path) return;
					const safePath = sanitizeImagePath(path, "");
					if (!safePath) return;
					galleryInput.value = `/${safePath}`;
				});
				const galleryAddBtn = el(
					"button",
					{
						type: "button",
						class: "cms-btn cms-btn--success cms-btn--inline",
					},
					["Add image"],
				);
				const galleryList = el("div", {
					class: "cms-portfolio-gallery__list",
				});
				const renderGallery = () => {
					galleryList.innerHTML = "";
					galleryItems.forEach((src, idx) => {
						const label = String(src || "")
							.replace(/^\/?assets\/img\//, "")
							.trim();
						const thumb = el("img", {
							class: "cms-portfolio-gallery__thumb",
							src: src,
							alt: label || "Gallery image",
						});
						const text = el("div", { class: "cms-portfolio-gallery__label" }, [
							label || src,
						]);
						const removeBtn = el(
							"button",
							{
								type: "button",
								class: "cms-btn cms-btn--danger cms-btn--inline",
							},
							["Remove"],
						);
						removeBtn.addEventListener("click", () => {
							galleryItems.splice(idx, 1);
							renderGallery();
						});
						const row = el(
							"div",
							{ class: "cms-portfolio-gallery__item" },
							[thumb, text, removeBtn],
						);
						galleryList.appendChild(row);
					});
				};
				renderGallery();
				galleryAddBtn.addEventListener("click", () => {
					const raw = galleryInput.value.trim();
					const safePath = sanitizeImagePath(raw, "");
					if (!safePath) return;
					const src = `/${safePath}`;
					if (!galleryItems.includes(src)) galleryItems.push(src);
					galleryInput.value = src;
					galleryToggle.checked = true;
					syncGalleryVisibility();
					renderGallery();
				});
				let galleryNameLabel = null;
				let galleryNameRow = null;
				const galleryRow = el("div", { class: "cms-field__row" }, [
					galleryInput,
					galleryModeSelect,
					gallerySelect,
					galleryPickBtn,
					galleryFileInput,
				]);
				let galleryInputStack = galleryRow;
				if (galleryNameInput) {
					galleryNameLabel = el("div", { class: "cms-field__label" }, [
						"Filename",
					]);
					galleryNameRow = el("div", { class: "cms-field__row" }, [
						galleryNameInput,
					]);
					galleryNameRow.hidden = galleryNameInput.hidden;
					galleryNameLabel.hidden = galleryNameInput.hidden;
					galleryInputStack = el("div", { class: "cms-field__stack" }, [
						galleryRow,
						galleryNameLabel,
						galleryNameRow,
					]);
				}
				const galleryWrap = el(
					"div",
					{ class: "cms-portfolio-gallery" },
					[galleryInputStack, galleryWarning, galleryAddBtn, galleryList],
				);
				const syncGalleryVisibility = () => {
					galleryWrap.hidden = !galleryToggle.checked;
				};
				syncGalleryVisibility();
				galleryToggle.addEventListener("change", syncGalleryVisibility);
				setGalleryMode(galleryModeSelect.value);
				populateImageSelect(gallerySelect);

				const upBtn = el(
					"button",
					{ type: "button", class: "cms-btn cms-btn--move" },
					["Move up"],
				);
				const downBtn = el(
					"button",
					{ type: "button", class: "cms-btn cms-btn--move" },
					["Move down"],
				);
				const removeBtn = el(
					"button",
					{ type: "button", class: "cms-btn cms-btn--danger" },
					["Remove card"],
				);
				const actions = el(
					"div",
					{ class: "cms-portfolio-card__actions" },
					[upBtn, downBtn, removeBtn],
				);
				const wrap = el(
					"div",
					{ class: "cms-modal__group cms-modal__group--settings" },
					[
						titleEl,
						buildField({
							label: "Title / Category",
							input: typeRow,
						}),
						buildField({
							label: "Dates",
							input: el("div", { class: "cms-field__row" }, [
								startInput,
								endInput,
							]),
							note: "Use MM-YYYY (e.g. 03-2024) or 'on-going'.",
						}),
						summaryEditor.wrap,
						buildField({ label: "Tags", input: tagsInput }),
						buildField({
							label: "Links",
							input: el("div", { class: "cms-field__stack" }, [
								el("div", { class: "cms-field__row" }, [
									siteInput,
									githubInput,
								]),
								el("div", { class: "cms-field__row" }, [
									youtubeInput,
									facebookInput,
								]),
							]),
						}),
						buildField({
							label: "Gallery",
							input: el("div", { class: "cms-field__stack" }, [
								el("label", { class: "cms-field__toggle" }, [
									galleryToggle,
									el("span", { class: "cms-field__toggle-text" }, [
										"Enable image gallery",
									]),
								]),
								galleryWrap,
							]),
							note: "Gallery images are pulled from /assets/img.",
						}),
						actions,
					],
				);
				const item = {
					wrap,
					titleEl,
					titleInput,
					typeSelect,
					typeInput,
					startInput,
					endInput,
					summaryEditor,
					tagsInput,
					siteInput,
					githubInput,
					youtubeInput,
					facebookInput,
					galleryItems,
					galleryToggle,
					upBtn,
					downBtn,
					removeBtn,
				};
				typeSelect.addEventListener("change", () => {
					if (typeSelect.value) typeInput.value = typeSelect.value;
				});
				typeAddBtn.addEventListener("click", () => {
					const raw = typeInput.value.trim();
					if (!raw) return;
					typeOptions.add(raw);
					syncTypeSelects();
					typeSelect.value = raw;
				});
				typeInfoBtn.addEventListener("click", (event) => {
					event.preventDefault();
					openTypeManager();
				});
				upBtn.addEventListener("click", () => {
					const index = portfolioCards.indexOf(item);
					if (index <= 0) return;
					const prev = portfolioCards[index - 1];
					portfolioCards[index - 1] = item;
					portfolioCards[index] = prev;
					syncCards();
				});
				downBtn.addEventListener("click", () => {
					const index = portfolioCards.indexOf(item);
					if (index < 0 || index >= portfolioCards.length - 1) return;
					const next = portfolioCards[index + 1];
					portfolioCards[index + 1] = item;
					portfolioCards[index] = next;
					syncCards();
				});
				removeBtn.addEventListener("click", () => {
					const index = portfolioCards.indexOf(item);
					if (index < 0) return;
					portfolioCards.splice(index, 1);
					syncCards();
				});
				return item;
			};

			(normalized.cards.length ? normalized.cards : [normalizePortfolioCard({})])
				.forEach((card) => {
					portfolioCards.push(buildCard(card));
				});
			const syncTypeSelects = () => {
				const list = getTypeList();
				portfolioCards.forEach((item) => {
					const select = item.typeSelect;
					if (!select) return;
					const current = select.value || item.typeInput?.value || "";
					select.innerHTML = "";
					select.appendChild(el("option", { value: "" }, ["Select type"]));
					list.forEach((type) => {
						select.appendChild(el("option", { value: type }, [type]));
					});
					if (current) select.value = current;
				});
			};
			syncTypeSelects();
			syncCards();

			const addCardBtn = el(
				"button",
				{
					type: "button",
					class: "cms-btn cms-btn--primary",
					"data-tooltip": "Add a new portfolio card",
					"aria-label": "Add a new portfolio card",
				},
				["Add card"],
			);
			addCardBtn.addEventListener("click", () => {
				portfolioCards.push(buildCard(normalizePortfolioCard({})));
				syncTypeSelects();
				syncCards();
			});
			const sharedToolbar = toolbarHost();
			const topField = buildField({
				label: "How many items do you want showing?",
				input: maxVisibleInput,
				note: "Displays the number of cards specified when no filters are active. Use * for all. Sorts based on most recent.",
			});
			const filtersField = buildField({
				label: "Filters",
				input: toggleRow,
			});

			openModal({
				title: "Edit block",
				bodyNodes: [
					buildHeadingField({
						label: "Header",
						input: titleInput,
						align: titleAlignSelect,
						note: "Saved as an H2 heading.",
					}),
					...(sharedToolbar ? [sharedToolbar] : []),
					introEditor.wrap,
					el("div", { class: "cms-portfolio-controls" }, [
						topField,
						filtersField,
					]),
					typeManagerWrap,
					el("div", { class: "cms-modal__group cms-modal__group--settings" }, [
						el("div", { class: "cms-modal__group-title" }, ["Cards"]),
						cardsWrap,
						addCardBtn,
					]),
				],
				footerNodes: [
					el(
						"button",
						{
							class: "cms-btn cms-modal__action cms-btn--danger",
							type: "button",
							"data-close": "true",
						},
						["Stop Editing Block"],
					),
					el(
						"button",
						{
							class: "cms-btn cms-modal__action cms-btn--success",
							type: "button",
							"data-action": "save-block",
						},
						["Save"],
					),
				],
				pruneAssets: true,
				onClose: openExitConfirm,
			});

			settings = {
				portfolioTitleInput: titleInput,
				portfolioTitleAlignSelect: titleAlignSelect,
				portfolioTitleAlignDefault: normalized.titleAlign || "",
				portfolioIntroEditor: introEditor,
				portfolioMaxInput: maxVisibleInput,
				portfolioShowSearch: showSearchInput,
				portfolioShowTypes: showTypesInput,
				portfolioShowTags: showTagsInput,
				portfolioShowLinks: showLinksInput,
				portfolioCards,
			};
		} else if (parsed.type === "styledAccordion") {
			const titleInput = el("input", {
				type: "text",
				class: "cms-field__input",
				value: parsed.title || "",
				placeholder: "Accordion title",
			});
			const titleAlignSelect = buildAlignSelect(
				parsed.titleAlign,
				"left",
				parsed.titleAnchor || "",
			);
			const introHtml = (() => {
				const raw = String(parsed.intro || "").trim();
				if (!raw) return "";
				if (/<[a-z][\s\S]*>/i.test(raw)) return raw;
				return `<p>${escapeHtml(raw)}</p>`;
			})();
			const introEditor = buildRteEditor({
				label: "Intro",
				initialHtml: introHtml,
				toolbarController: ensureToolbar(),
			});
			introEditor.wrap.classList.add("cms-rte__field--intro");
			introEditor.wrap.classList.add("cms-rte__field--light");
			const itemsWrap = el("div", { class: "cms-modal__subgroup" }, []);
			const accordionItems = [];
			const syncItems = () => {
				itemsWrap.innerHTML = "";
				accordionItems.forEach((item, idx) => {
					item.titleEl.textContent = `Item ${idx + 1}`;
					item.upBtn.disabled = idx === 0;
					item.downBtn.disabled = idx === accordionItems.length - 1;
					item.removeBtn.disabled = accordionItems.length <= 1;
					item.removeBtn.classList.toggle(
						"is-disabled",
						accordionItems.length <= 1,
					);
					itemsWrap.appendChild(item.wrap);
				});
			};
			const buildItem = ({ label, body }) => {
				const titleEl = el("div", { class: "cms-modal__group-title" }, [
					"Item",
				]);
				const labelInput = el("input", {
					type: "text",
					class: "cms-field__input",
					value: label || "",
					placeholder: "Row title",
				});
				const editor = buildRteEditor({
					label: "Row content",
					initialHtml: body || "<ul><li>Point A</li><li>Point B</li></ul>",
					toolbarController: ensureToolbar(),
				});
				editor.wrap.classList.add("cms-rte__field--light");
				const upBtn = el(
					"button",
					{
						type: "button",
						class: "cms-btn cms-btn--move",
					},
					["Move up"],
				);
				const downBtn = el(
					"button",
					{
						type: "button",
						class: "cms-btn cms-btn--move",
					},
					["Move down"],
				);
				const removeBtn = el(
					"button",
					{
						type: "button",
						class: "cms-btn cms-btn--danger",
					},
					["Remove row"],
				);
				const actionRow = el(
					"div",
					{ class: "cms-field__row cms-accordion-actions-row" },
					[
					upBtn,
					downBtn,
					removeBtn,
					],
				);
				const wrap = el(
					"div",
					{ class: "cms-modal__group cms-modal__group--settings" },
					[
						titleEl,
						buildField({ label: "Row title", input: labelInput }),
						editor.wrap,
						actionRow,
					],
				);
				const item = {
					wrap,
					titleEl,
					labelInput,
					editor,
					upBtn,
					downBtn,
					removeBtn,
				};
				upBtn.addEventListener("click", () => {
					const index = accordionItems.indexOf(item);
					if (index <= 0) return;
					const prev = accordionItems[index - 1];
					accordionItems[index - 1] = item;
					accordionItems[index] = prev;
					syncItems();
				});
				downBtn.addEventListener("click", () => {
					const index = accordionItems.indexOf(item);
					if (index < 0 || index >= accordionItems.length - 1) return;
					const next = accordionItems[index + 1];
					accordionItems[index + 1] = item;
					accordionItems[index] = next;
					syncItems();
				});
				removeBtn.addEventListener("click", () => {
					if (accordionItems.length <= 1) return;
					const index = accordionItems.indexOf(item);
					if (index < 0) return;
					accordionItems.splice(index, 1);
					syncItems();
				});
				return item;
			};
			(parsed.items || []).forEach((item) => {
				accordionItems.push(buildItem({ label: item.label, body: item.body }));
			});
			if (!accordionItems.length) {
				accordionItems.push(buildItem({ label: "Item 1", body: "" }));
			}
			syncItems();
			const sharedToolbar = toolbarHost();
			const addBtn = el(
				"button",
				{
					type: "button",
					class: "cms-btn cms-btn--primary",
				},
				["Add row"],
			);
			addBtn.addEventListener("click", () => {
				accordionItems.push(buildItem({ label: "", body: "" }));
				syncItems();
			});
			const introGroup = el(
				"div",
				{ class: "cms-modal__group cms-modal__group--intro" },
				[
					introEditor.wrap,
					el("div", { class: "cms-field__note" }, [
						"Optional intro text above the accordion rows.",
					]),
				],
			);

			openModal({
				title: "Edit block",
				bodyNodes: [
					buildHeadingField({
						label: "Title",
						input: titleInput,
						align: titleAlignSelect,
					}),
					...(sharedToolbar ? [sharedToolbar] : []),
					introGroup,
					el("div", { class: "cms-modal__group cms-modal__group--settings" }, [
						el("div", { class: "cms-modal__group-title" }, ["Accordion rows"]),
						itemsWrap,
						addBtn,
					]),
				],
				footerNodes: [
					el(
						"button",
						{
							class: "cms-btn cms-modal__action cms-btn--danger",
							type: "button",
							"data-close": "true",
						},
						["Stop Editing Block"],
					),
					el(
						"button",
						{
							class: "cms-btn cms-modal__action cms-btn--success",
							type: "button",
							"data-action": "save-block",
						},
						["Save"],
					),
				],
				pruneAssets: true,
				onClose: openExitConfirm,
			});

			settings = {
				accordionTitleInput: titleInput,
				accordionTitleAlignSelect: titleAlignSelect,
				accordionTitleStyle: parsed.titleStyle || "",
				accordionIntroEditor: introEditor,
				accordionItems,
			};
		} else if (parsed.type === "stdContainer") {
			const headingInput = el("input", {
				type: "text",
				class: "cms-field__input",
				value: parsed.heading || "",
				placeholder: "Header text",
			});
			const headingAlignSelect = buildAlignSelect(
				parsed.headingAlign,
				"left",
				parsed.headingAnchor || "",
			);
			const body = buildRteEditor({
				label: "Content",
				initialHtml: parsed.body || "",
				toolbarController: ensureToolbar(),
			});
			const sharedToolbar = toolbarHost();
			editors = [{ key: "body", editor: body.editor }];
			openModal({
				title: "Edit block",
				bodyNodes: [
					buildHeadingField({
						label: "Header",
						input: headingInput,
						align: headingAlignSelect,
						note: "Optional header for this container.",
					}),
					...(sharedToolbar ? [sharedToolbar] : []),
					body.wrap,
				],
				footerNodes: [
					el(
						"button",
						{
							class: "cms-btn cms-modal__action cms-btn--danger",
							type: "button",
							"data-close": "true",
						},
						["Stop Editing Block"],
					),
					el(
						"button",
						{
							class: "cms-btn cms-modal__action cms-btn--success",
							type: "button",
							"data-action": "save-block",
						},
						["Save"],
					),
				],
				pruneAssets: true,
				onClose: openExitConfirm,
			});
			settings = {
				stdHeadingInput: headingInput,
				stdHeadingTag: parsed.headingTag || "h2",
				stdHeadingStyle: parsed.headingStyle || "",
				stdHeadingAlignSelect: headingAlignSelect,
			};
		} else if (parsed.type === "twoCol") {
			const headingLeftInput = el("input", {
				type: "text",
				class: "cms-field__input",
				value: parsed.leftHeading || parsed.heading || "",
				placeholder: "Left header",
			});
			const leftAlignSelect = buildAlignSelect(
				parsed.leftHeadingAlign,
				"left",
				parsed.leftHeadingAnchor || "",
			);
			const left = buildRteEditor({
				label: "Left column",
				initialHtml: parsed.left || "",
				toolbarController: ensureToolbar(),
			});
			const headingRightInput = el("input", {
				type: "text",
				class: "cms-field__input",
				value: parsed.rightHeading || "",
				placeholder: "Right header",
			});
			const rightAlignSelect = buildAlignSelect(
				parsed.rightHeadingAlign,
				"left",
				parsed.rightHeadingAnchor || "",
			);
			const right = buildRteEditor({
				label: "Right column",
				initialHtml: parsed.right || "",
				toolbarController: ensureToolbar(),
			});
			const sharedToolbar = toolbarHost();
			editors = [
				{ key: "left", editor: left.editor },
				{ key: "right", editor: right.editor },
			];
			openModal({
				title: "Edit block",
				bodyNodes: [
					...(sharedToolbar ? [sharedToolbar] : []),
					buildHeadingField({
						label: "Header (left)",
						input: headingLeftInput,
						align: leftAlignSelect,
						note: "Optional left column header.",
					}),
					left.wrap,
					buildHeadingField({
						label: "Header (right)",
						input: headingRightInput,
						align: rightAlignSelect,
						note: "Optional right column header.",
					}),
					right.wrap,
				],
				footerNodes: [
					el(
						"button",
						{
							class: "cms-btn cms-modal__action cms-btn--danger",
							type: "button",
							"data-close": "true",
						},
						["Stop Editing Block"],
					),
					el(
						"button",
						{
							class: "cms-btn cms-modal__action cms-btn--success",
							type: "button",
							"data-action": "save-block",
						},
						["Save"],
					),
				],
				pruneAssets: true,
				onClose: openExitConfirm,
			});
			settings = {
				leftHeadingInput: headingLeftInput,
				rightHeadingInput: headingRightInput,
				leftHeadingTag: parsed.leftHeadingTag || parsed.headingTag || "h2",
				rightHeadingTag: parsed.rightHeadingTag || "h2",
				leftHeadingStyle: parsed.leftHeadingStyle || "",
				rightHeadingStyle: parsed.rightHeadingStyle || "",
				leftHeadingAlignSelect: leftAlignSelect,
				rightHeadingAlignSelect: rightAlignSelect,
			};
		} else {
			let headingInput = null;
			let headingAlignSelect = null;
			let headingStyle = "";
			let imgInput = null;
			let videoInput = null;
			let imageRow = null;
			let imagePickBtn = null;
			let imageModeSelect = null;
			let imageLibrarySelect = null;
			let captionInput = null;
			let uploadFileInput = null;
			let uploadNameInput = null;
			let uploadNameLabel = null;
			let uploadNameRow = null;
			let currentUploadFile = null;
			let currentUploadBase64 = "";
			let currentUploadMime = "";
			let currentUploadPath = "";
			let currentUploadExt = "";
			let uploadWarning = null;
			let setImageMode = null;
			let overlayEnabledInput = null;
			let overlayTitleInput = null;
			let overlayTextInput = null;
			let lightboxInput = null;
			let posSelect = null;
			let displayRow = null;
			let lightboxToggle = null;
			let overlayToggle = null;
			let imagePreviewWrap = null;
			let imagePreviewImg = null;
			let updateBlockPreview = null;
			let updateOverlayPreview = null;
			let overlayGroup = null;
			let videoRow = null;

			if (parsed.type === "imgText" || parsed.type === "split50") {
				headingInput = el("input", {
					type: "text",
					class: "cms-field__input",
					value: parsed.heading || "",
					placeholder: "Heading",
				});
				headingAlignSelect = buildAlignSelect(
					parsed.headingAlign,
					"left",
					parsed.headingAnchor || "",
				);
				headingStyle = parsed.headingStyle || "";
				imgInput = el("input", {
					type: "text",
					class: "cms-field__input",
					value: parsed.img || "",
					placeholder: "/assets/img/...",
				});
				videoInput = el("input", {
					type: "text",
					class: "cms-field__input",
					value: parsed.video || "",
					placeholder: "https://www.youtube.com/watch?v=...",
				});
				imageModeSelect = el("select", { class: "cms-field__select" }, [
					el("option", { value: "existing" }, ["Use existing"]),
					el("option", { value: "upload" }, ["Upload new"]),
					el("option", { value: "video" }, ["Video"]),
				]);
				imageModeSelect.value = parsed.video ? "video" : "existing";
				imageLibrarySelect = el("select", { class: "cms-field__select" }, [
					el("option", { value: "" }, ["Select an existing image"]),
				]);
				imagePickBtn = el(
					"button",
					{
						class: "cms-btn cms-btn--primary cms-btn--inline",
						type: "button",
					},
					["Choose image"],
				);
				uploadFileInput = el("input", {
					type: "file",
					class: "cms-field__input",
				});
				uploadFileInput.hidden = true;
				uploadNameInput = el("input", {
					type: "text",
					class: "cms-field__input",
					placeholder: "Filename (e.g. hero.jpg or sub/hero.jpg)",
				});
				uploadNameInput.hidden = true;
				const getFileExtension = (name) => {
					const match = String(name || "")
						.trim()
						.match(/(\.[A-Za-z0-9]+)$/);
					return match ? match[1] : "";
				};
				const normalizeUploadName = (rawName) => {
					const raw = String(rawName || "").trim();
					if (!raw) {
						if (currentUploadExt)
							return { name: currentUploadExt, caret: 0, empty: true };
						return { name: "", caret: 0, empty: true };
					}
					if (!currentUploadExt) return { name: raw, caret: raw.length };
					const lowerRaw = raw.toLowerCase();
					const lowerExt = currentUploadExt.toLowerCase();
					let base = raw;
					if (lowerRaw.endsWith(lowerExt)) {
						base = raw.slice(0, -currentUploadExt.length);
					}
					if (base.endsWith(".")) base = base.slice(0, -1);
					return {
						name: `${base}${currentUploadExt}`,
						caret: base.length,
						empty: !base,
					};
				};
				const syncUploadName = (rawName, { normalize = false } = {}) => {
					const normalized = normalizeUploadName(rawName);
					if (!normalized.name) return;
					if (normalized.empty && currentUploadExt) {
						if (normalize && uploadNameInput) {
							uploadNameInput.value = currentUploadExt;
							if (document.activeElement === uploadNameInput) {
								uploadNameInput.setSelectionRange(0, 0);
							}
						}
						return;
					}
					const safePath = sanitizeImagePath(
						normalized.name,
						currentUploadFile?.name || "",
					);
					if (!safePath) return;
					const safeName = safePath.replace(/^assets\/img\//, "");
					if (normalize && uploadNameInput) {
						uploadNameInput.value = safeName;
						if (
							currentUploadExt &&
							document.activeElement === uploadNameInput
						) {
							const caret = Math.max(
								0,
								safeName.length - currentUploadExt.length,
							);
							uploadNameInput.setSelectionRange(caret, caret);
						}
					}
					imgInput.value = `/${safePath}`;
					if (currentUploadBase64) {
						if (currentUploadPath && currentUploadPath !== safePath) {
							state.assetUploads = (state.assetUploads || []).filter(
								(item) => item.path !== currentUploadPath,
							);
						}
						addAssetUpload({
							name: safeName,
							content: currentUploadBase64,
							path: safePath,
							mime: currentUploadMime || "",
						});
						currentUploadPath = safePath;
					}
					if (updateBlockPreview) updateBlockPreview();
				};
				const stageUpload = (file, filename) => {
					if (!file) return;
					const safePath = sanitizeImagePath(filename, file.name || "");
					if (!safePath) return;
					const safeName = safePath.replace(/^assets\/img\//, "");
					if (uploadNameInput) uploadNameInput.value = safeName;
					const reader = new FileReader();
					reader.onload = () => {
						const dataUrl = String(reader.result || "");
						const base64 = dataUrl.split(",")[1] || "";
						currentUploadBase64 = base64;
						currentUploadMime = file.type || "";
						syncUploadName(uploadNameInput?.value.trim() || safeName, {
							normalize: true,
						});
					};
					reader.readAsDataURL(file);
				};
				imagePickBtn.addEventListener("click", () => {
					uploadFileInput?.click();
				});
				uploadFileInput.addEventListener("change", () => {
					const file = uploadFileInput.files?.[0];
					if (!file) return;
					currentUploadFile = file;
					currentUploadExt = getFileExtension(file.name || "");
					if (uploadNameInput && !uploadNameInput.value.trim()) {
						uploadNameInput.value = file.name || "";
					}
					stageUpload(file, uploadNameInput?.value.trim() || "");
				});
				uploadNameInput.addEventListener("input", () => {
					syncUploadName(uploadNameInput.value.trim(), { normalize: true });
				});
				uploadNameInput.addEventListener("blur", () => {
					if (!currentUploadFile) return;
					if (currentUploadBase64) {
						syncUploadName(uploadNameInput.value.trim(), { normalize: true });
						return;
					}
					stageUpload(currentUploadFile, uploadNameInput.value.trim());
				});
				setImageMode = (mode) => {
					const useUpload = mode === "upload";
					const useVideo = mode === "video";
					if (imageRow) imageRow.hidden = useVideo;
					if (videoRow) videoRow.hidden = !useVideo;
					if (imageLibrarySelect) imageLibrarySelect.hidden = useUpload || useVideo;
					if (imagePickBtn) imagePickBtn.hidden = !useUpload || useVideo;
					if (uploadNameInput) uploadNameInput.hidden = !useUpload || useVideo;
					if (uploadNameLabel) uploadNameLabel.hidden = !useUpload || useVideo;
					if (uploadNameRow) uploadNameRow.hidden = !useUpload || useVideo;
					if (imgInput) {
						imgInput.disabled = useUpload || useVideo;
						imgInput.classList.toggle(
							"cms-field__input--muted",
							useUpload || useVideo,
						);
					}
					if (uploadWarning) uploadWarning.hidden = !useUpload || useVideo;
					if (imagePreviewWrap) imagePreviewWrap.hidden = useVideo;
					if (overlayToggle) overlayToggle.hidden = useVideo;
					if (lightboxToggle) lightboxToggle.hidden = useVideo;
					if (overlayGroup) overlayGroup.hidden = useVideo;
					if (overlayEnabledInput && useVideo) {
						overlayEnabledInput.checked = false;
					}
					if (lightboxInput && useVideo) {
						lightboxInput.checked = false;
					}
					if (!useUpload && !useVideo && imageLibrarySelect) {
						loadImageLibraryIntoSelect(imageLibrarySelect)
							.then(() => {
								const local = getLocalAssetPath(imgInput.value || "");
								if (local) imageLibrarySelect.value = local;
							})
							.catch((err) => console.error(err));
					}
				};
				imageModeSelect.addEventListener("change", () => {
					setImageMode(imageModeSelect.value);
				});
				imageLibrarySelect.addEventListener("change", () => {
					const path = imageLibrarySelect.value;
					if (!path) return;
					const safePath = sanitizeImagePath(path, "");
					if (!safePath) return;
					imgInput.value = `/${safePath}`;
					if (updateBlockPreview) updateBlockPreview();
				});
				imagePreviewImg = el("img", {
					class: "cms-image-preview__img cms-image-preview__img--block",
					alt: "Preview",
				});
				imagePreviewWrap = el(
					"div",
					{
						class:
							"cms-image-preview cms-image-preview--inline content content--full",
					},
					[imagePreviewImg],
				);
				const overlayLayer = el("div", {
					class: "content-overlay",
				});
				const overlayTitlePreview = el("h3", {
					class: "content-title",
				});
				const overlayTextPreview = el("p", {
					class: "content-text",
				});
				const overlayDetails = el(
					"div",
					{ class: "content-details fadeIn-bottom" },
					[overlayTitlePreview, overlayTextPreview],
				);
				imagePreviewWrap.appendChild(overlayLayer);
				imagePreviewWrap.appendChild(overlayDetails);
				updateBlockPreview = () => {
					if (imageModeSelect?.value === "video") {
						imagePreviewWrap.hidden = true;
						imagePreviewImg.removeAttribute("src");
						return;
					}
					const raw = imgInput.value.trim();
					let src = raw ? normalizeImageSource(raw) : "";
					if (src && !src.startsWith("data:")) {
						const local = getLocalAssetPath(src);
						const cached = local ? getCachedAssetDataUrl(local) : "";
						if (cached) src = cached;
					}
					if (!src) {
						imagePreviewWrap.hidden = true;
						imagePreviewImg.removeAttribute("src");
						if (updateOverlayPreview) updateOverlayPreview();
						return;
					}
					imagePreviewWrap.hidden = false;
					imagePreviewImg.src = src;
					if (imageLibrarySelect && !imageLibrarySelect.hidden) {
						const local = getLocalAssetPath(raw);
						if (local) imageLibrarySelect.value = local;
					}
					if (updateOverlayPreview) updateOverlayPreview();
				};
				updateOverlayPreview = () => {
					const enabled = overlayEnabledInput?.checked;
					if (!enabled || imagePreviewWrap.hidden) {
						overlayLayer.hidden = true;
						overlayDetails.hidden = true;
						overlayTitlePreview.textContent = "";
						overlayTextPreview.textContent = "";
						return;
					}
					const title = overlayTitleInput?.value.trim() || "";
					const text = overlayTextInput?.value.trim() || "";
					const fallback =
						!title && !text && lightboxInput?.checked ? "Click to view" : text;
					overlayLayer.hidden = false;
					overlayDetails.hidden = false;
					overlayTitlePreview.textContent = title;
					overlayTextPreview.textContent = fallback;
					overlayTitlePreview.hidden = !title;
					overlayTextPreview.hidden = !fallback;
				};
				imgInput.addEventListener("input", updateBlockPreview);
				imgInput.addEventListener("blur", () => {
					const normalized = normalizeImageSource(imgInput.value);
					if (normalized) imgInput.value = normalized;
					updateBlockPreview();
				});
				updateBlockPreview();
				captionInput = el("input", {
					type: "text",
					class: "cms-field__input",
					value: parsed.caption || "",
					placeholder: "Optional caption",
				});
				overlayTitleInput = el("input", {
					type: "text",
					class: "cms-field__input",
					value: parsed.overlayTitle || "",
					placeholder: "Overlay title (optional)",
				});
				overlayTextInput = el("input", {
					type: "text",
					class: "cms-field__input",
					value: parsed.overlayText || "",
					placeholder: "Overlay text (optional)",
				});
				overlayEnabledInput = el("input", {
					type: "checkbox",
					class: "cms-field__checkbox",
				});
				overlayEnabledInput.checked = parsed.overlayEnabled !== false;
				lightboxInput = el("input", {
					type: "checkbox",
					class: "cms-field__checkbox",
				});
				lightboxInput.checked =
					normalizeBool(parsed.lightbox, "false") === "true";
				posSelect = el("select", { class: "cms-field__select" }, [
					el("option", { value: "left" }, ["Image left"]),
					el("option", { value: "right" }, ["Image right"]),
				]);
				posSelect.value = parsed.imgPos === "right" ? "right" : "left";
				const overlayInputs = el("div", { class: "cms-field__stack" }, [
					overlayTitleInput,
					overlayTextInput,
				]);
				overlayGroup = buildField({
					label: "Overlay",
					input: overlayInputs,
				});
			}

			const body = buildRteEditor({
				label: "Content",
				initialHtml: parsed.body || "",
				toolbarController: ensureToolbar(),
			});
			const sharedToolbar = toolbarHost();
			editors = [{ key: "body", editor: body.editor }];

			const settingsNodes = [];
			if (headingInput) {
				settingsNodes.push(
					buildHeadingField({
						label: "Heading",
						input: headingInput,
						align: headingAlignSelect,
						note: "Controls the block title styling.",
					}),
				);
			}
			if (imgInput) {
				imageRow = el("div", { class: "cms-field__row" }, [
					imgInput,
					imageModeSelect,
					imageLibrarySelect,
					imagePickBtn,
					uploadFileInput,
				]);
				videoRow = el("div", { class: "cms-field__row" }, [videoInput]);
				videoRow.hidden = true;
				let imageInput = imageRow;
				if (uploadNameInput) {
					uploadNameLabel = el("div", { class: "cms-field__label" }, [
						"Filename",
					]);
					uploadNameRow = el("div", { class: "cms-field__row" }, [
						uploadNameInput,
					]);
					uploadNameRow.hidden = uploadNameInput.hidden;
					uploadNameLabel.hidden = uploadNameInput.hidden;
					imageInput = el("div", { class: "cms-field__stack" }, [
						imageRow,
						videoRow,
						uploadNameLabel,
						uploadNameRow,
					]);
				} else {
					imageInput = el("div", { class: "cms-field__stack" }, [
						imageRow,
						videoRow,
					]);
				}
				lightboxToggle = el("label", { class: "cms-field__toggle" }, [
					lightboxInput,
					el("span", { class: "cms-field__toggle-text" }, ["Lightbox"]),
				]);
				overlayToggle = el("label", { class: "cms-field__toggle" }, [
					overlayEnabledInput,
					el("span", { class: "cms-field__toggle-text" }, ["Overlay"]),
				]);
				displayRow = el("div", { class: "cms-field__row" }, [
					posSelect,
					lightboxToggle,
					overlayToggle,
				]);
				const displayField = buildField({
					label: "Display",
					input: displayRow,
				});
				const captionField = buildField({
					label: "Caption",
					input: captionInput,
				});
				const controlsWrap = el(
					"div",
					{ class: "cms-image-settings__controls" },
					[displayField, captionField, overlayGroup],
				);
				const settingsRow = el("div", { class: "cms-image-settings" }, [
					el("div", { class: "cms-image-settings__preview" }, [
						imagePreviewWrap,
					]),
					controlsWrap,
				]);
				settingsNodes.push(
					buildField({
						label: "Media source",
						input: imageInput,
						note: "Required for image/video blocks.",
					}),
				);
				uploadWarning = el(
					"div",
					{ class: "cms-modal__note cms-note--warning" },
					[
						"\u26a0 Please note: Uploaded images are only stored in local memory until comitted and could be lost \u26a0",
					],
				);
				uploadWarning.hidden = true;
				settingsNodes.push(uploadWarning);
				settingsNodes.push(
					buildField({
						label: "Image settings",
						input: settingsRow,
					}),
				);
				const syncOverlayState = () => {
					const enabled = overlayEnabledInput.checked;
					overlayTitleInput.disabled = !enabled;
					overlayTextInput.disabled = !enabled;
					if (overlayGroup) overlayGroup.hidden = !enabled;
					if (updateOverlayPreview) updateOverlayPreview();
				};
				syncOverlayState();
				overlayEnabledInput.addEventListener("change", syncOverlayState);
				lightboxInput.addEventListener("change", () => {
					if (updateOverlayPreview) updateOverlayPreview();
				});
				overlayTitleInput.addEventListener("input", () => {
					if (updateOverlayPreview) updateOverlayPreview();
				});
				overlayTextInput.addEventListener("input", () => {
					if (updateOverlayPreview) updateOverlayPreview();
				});
				if (setImageMode) setImageMode(imageModeSelect.value);
			}

			const settingsWrap =
				settingsNodes.length > 0
					? el(
							"div",
							{ class: "cms-modal__group cms-modal__group--settings" },
							[
								el("div", { class: "cms-modal__group-title" }, [
									"Block settings",
								]),
								...settingsNodes,
							],
						)
					: null;

			openModal({
				title: "Edit block",
				bodyNodes: settingsWrap
					? [
							settingsWrap,
							...(sharedToolbar ? [sharedToolbar] : []),
							body.wrap,
						]
					: [...(sharedToolbar ? [sharedToolbar] : []), body.wrap],
				footerNodes: [
					el(
						"button",
						{
							class: "cms-btn cms-modal__action cms-btn--danger",
							type: "button",
							"data-close": "true",
						},
						["Stop Editing Block"],
					),
					el(
						"button",
						{
							class: "cms-btn cms-modal__action cms-btn--success",
							type: "button",
							"data-action": "save-block",
						},
						["Save"],
					),
				],
				pruneAssets: true,
				onClose: openExitConfirm,
			});

			settings = {
				headingInput,
				headingAlignSelect,
				headingStyle,
				imgInput,
				videoInput,
				imageModeSelect,
				imagePickBtn,
				captionInput,
				overlayEnabledInput,
				overlayTitleInput,
				overlayTextInput,
				lightboxInput,
				posSelect,
			};
		}

		const modal = document.querySelector(".cms-modal");
		const saveBtn = modal?.querySelector(
			'.cms-btn.cms-modal__action.cms-btn--success[data-action="save-block"]',
		);
		if (!saveBtn) return;

		const buildUpdatedHtmlFromSettings = async () => {
			const updated = { ...parsed };
			const resolveAnchor = (control, text) =>
				resolveHeadingAnchor({
					enabled: control?.anchorEnabled,
					anchor: control?.anchor,
					text,
				});
			if (settings.accordionItems) {
				updated.title = settings.accordionTitleInput?.value.trim() || "";
				updated.titleTag = parsed.titleTag || "h2";
				updated.titleAlign =
					settings.accordionTitleAlignSelect?.value || parsed.titleAlign || "";
				updated.titleStyle = settings.accordionTitleStyle || "";
				updated.titleAnchor = resolveAnchor(
					settings.accordionTitleAlignSelect,
					updated.title,
				);
				updated.intro = sanitizeRteHtml(
					settings.accordionIntroEditor?.editor.innerHTML || "",
					ctx,
				);
				updated.items = settings.accordionItems.map((item, idx) => ({
					label: item.labelInput?.value.trim() || `Item ${idx + 1}`,
					body: sanitizeRteHtml(item.editor?.editor.innerHTML || "", ctx),
				}));
			}
			if (settings.stdHeadingInput) {
				updated.heading = settings.stdHeadingInput.value.trim();
				updated.headingTag = settings.stdHeadingTag || "h2";
				updated.headingStyle = settings.stdHeadingStyle || "";
				updated.headingAlign =
					settings.stdHeadingAlignSelect?.value || parsed.headingAlign || "";
				updated.headingAnchor = resolveAnchor(
					settings.stdHeadingAlignSelect,
					updated.heading,
				);
			}
			if (settings.headingInput) {
				updated.heading = settings.headingInput.value.trim();
				updated.headingTag = parsed.headingTag || "h2";
				updated.headingAlign =
					settings.headingAlignSelect?.value || parsed.headingAlign || "";
				updated.headingStyle = settings.headingStyle || parsed.headingStyle || "";
				updated.headingAnchor = resolveAnchor(
					settings.headingAlignSelect,
					updated.heading,
				);
			}
			if (settings.leftHeadingInput) {
				updated.leftHeading = settings.leftHeadingInput.value.trim();
				updated.leftHeadingTag = settings.leftHeadingTag || "h2";
				updated.leftHeadingStyle = settings.leftHeadingStyle || "";
				updated.leftHeadingAlign =
					settings.leftHeadingAlignSelect?.value ||
					parsed.leftHeadingAlign ||
					"";
				updated.leftHeadingAnchor = resolveAnchor(
					settings.leftHeadingAlignSelect,
					updated.leftHeading,
				);
				updated.rightHeading = settings.rightHeadingInput?.value.trim() || "";
				updated.rightHeadingTag = settings.rightHeadingTag || "h2";
				updated.rightHeadingStyle = settings.rightHeadingStyle || "";
				updated.rightHeadingAlign =
					settings.rightHeadingAlignSelect?.value ||
					parsed.rightHeadingAlign ||
					"";
				updated.rightHeadingAnchor = resolveAnchor(
					settings.rightHeadingAlignSelect,
					updated.rightHeading,
				);
				updated.heading = updated.leftHeading;
				updated.headingTag = updated.leftHeadingTag;
			}
			if (settings.imgInput) {
				updated.caption = settings.captionInput?.value.trim() || "";
				const mode = settings.imageModeSelect?.value || "existing";
				if (mode === "video") {
					updated.video = settings.videoInput?.value.trim() || "";
					updated.img = "";
					updated.overlayEnabled = false;
					updated.overlayTitle = "";
					updated.overlayText = "";
					updated.lightbox = "false";
				} else {
					updated.video = "";
					updated.img = settings.imgInput.value.trim();
					const overlayEnabled = settings.overlayEnabledInput?.checked;
					updated.overlayEnabled = overlayEnabled;
					updated.overlayTitle = overlayEnabled
						? settings.overlayTitleInput?.value.trim() || ""
						: "";
					updated.overlayText = overlayEnabled
						? settings.overlayTextInput?.value.trim() || ""
						: "";
					updated.lightbox = settings.lightboxInput?.checked ? "true" : "false";
				}
				updated.imgPos = settings.posSelect?.value || "left";
			}
			if (settings.portfolioCards) {
				const maxRaw = String(settings.portfolioMaxInput?.value || "").trim();
				let maxValue = 3;
				if (maxRaw === "*") maxValue = 0;
				else if (maxRaw) maxValue = Number(maxRaw);
				updated.maxVisible = Number.isFinite(maxValue)
					? Math.max(0, Math.floor(maxValue))
					: 3;
				updated.showSearch = settings.portfolioShowSearch?.checked ?? true;
				updated.showTypeFilters = settings.portfolioShowTypes?.checked ?? true;
				updated.showTagFilters = settings.portfolioShowTags?.checked ?? true;
				updated.showLinkFilters = settings.portfolioShowLinks?.checked ?? true;
				updated.title = settings.portfolioTitleInput?.value.trim() || "";
				updated.titleAnchor = resolveAnchor(
					settings.portfolioTitleAlignSelect,
					updated.title,
				);
				const alignValue = normalizeHeadingAlign(
					settings.portfolioTitleAlignSelect?.value,
					"center",
				);
				const baseAlign = settings.portfolioTitleAlignDefault || "";
				updated.titleAlign =
					alignValue === "center"
						? baseAlign === "center"
							? "center"
							: ""
						: "left";
				updated.intro = sanitizeRteHtml(
					settings.portfolioIntroEditor?.editor.innerHTML || "",
					ctx,
				);
				updated.cards = settings.portfolioCards.map((card) => ({
					title: card.titleInput?.value.trim() || "",
					type:
						card.typeInput?.value.trim() ||
						card.typeSelect?.value.trim() ||
						"",
					start: card.startInput?.value.trim() || "",
					end: card.endInput?.value.trim() || "",
					summary: sanitizeRteHtml(
						card.summaryEditor?.editor.innerHTML || "",
						ctx,
					),
					tags: String(card.tagsInput?.value || "")
						.split(",")
						.map((tag) => tag.trim())
						.filter(Boolean),
					links: {
						site: card.siteInput?.value.trim() || "",
						github: card.githubInput?.value.trim() || "",
						youtube: card.youtubeInput?.value.trim() || "",
						facebook: card.facebookInput?.value.trim() || "",
					},
					gallery:
						card.galleryToggle?.checked && Array.isArray(card.galleryItems)
							? card.galleryItems.slice()
							: [],
				}));
			}
			await Promise.all(
				editors.map(async ({ key, editor }) => {
					const raw = editor.innerHTML;
					if (key === "left") updated.left = sanitizeRteHtml(raw, ctx);
					else if (key === "right") updated.right = sanitizeRteHtml(raw, ctx);
					else updated.body = sanitizeRteHtml(raw, ctx);
				}),
			);
			return serializeMainBlocks([updated], {
				path: state.path,
			}).trim();
		};

		getEditorChangeState = async () => {
			const updatedHtml = await buildUpdatedHtmlFromSettings();
			if (!updatedHtml) return false;
			const updatedSig = buildNoopSignature(updatedHtml);
			return updatedSig !== baseSig;
		};

		saveBtn.addEventListener("click", async () => {
			const updatedHtml = await buildUpdatedHtmlFromSettings();
			if (!updatedHtml) return;
			const updatedSig = buildNoopSignature(updatedHtml);
			if (updatedSig === baseSig) {
				closeModal();
				return;
			}

			if (origin === "local" && localId) {
				const nextLocal = normalizeLocalBlocks(currentLocal).map((item) =>
					item.id === localId
						? { ...item, html: updatedHtml, kind: "edited" }
						: item,
				);
				updateLocalBlocksAndRender(state.path, nextLocal);
				closeModal();
				return;
			}

			if (origin === "base" && anchorBase?.id) {
				const anchor = {
					id: anchorBase.id,
					sig: anchorBase.sig,
					occ: anchorBase.occ,
				};
				const cleaned = stripEditEntriesForBase(currentLocal, anchor);
				const editedInsert = {
					id: makeLocalId(),
					html: updatedHtml,
					anchor,
					placement: "after",
					status: "staged",
					kind: "edited",
					action: "insert",
					baseId: anchor.id,
					sourceKey: `id:${anchor.id}`,
				};
				const removeBase = {
					id: makeLocalId(),
					html: "",
					anchor,
					placement: "after",
					status: "staged",
					kind: "edited",
					action: "remove",
					baseId: anchor.id,
				};
				updateLocalBlocksAndRender(state.path, [
					...cleaned,
					removeBase,
					editedInsert,
				]);
				closeModal();
			}
		});
	}

	function openHeroEditor() {
		const heroModel = parseHeroInner(state.heroInner || "");
		if (!heroModel || heroModel.type !== "hero") {
			openModal({
				title: "Hero editor",
				bodyNodes: [
					el("p", { class: "cms-modal__text" }, [
						"Hero editing is only available for the standard hero layout.",
					]),
				],
				footerNodes: [
					el(
						"button",
						{
							class: "cms-btn cms-modal__action",
							type: "button",
							"data-close": "true",
						},
						["Close Modal"],
					),
				],
			});
			return;
		}

		const titleInput = el("input", {
			type: "text",
			class: "cms-field__input",
			value: heroModel.title || "",
			placeholder: "Hero title",
		});
		const subtitleInput = el("textarea", {
			class: "cms-field__input cms-field__textarea",
			placeholder: "Hero subtitle",
		});
		subtitleInput.value = heroModel.subtitle || "";

		const saveBtn = el(
			"button",
			{
				class: "cms-btn cms-modal__action cms-btn--success",
				type: "button",
			},
			["Save"],
		);
		saveBtn.addEventListener("click", () => {
			const nextHero = {
				type: "hero",
				title: titleInput.value.trim(),
				subtitle: subtitleInput.value.trim(),
				align: heroModel.align,
			};
			const baseHero = extractRegion(state.originalHtml || "", "hero");
			const baseHeroModel = parseHeroInner(baseHero.inner || "");
			const unchanged =
				baseHeroModel.type === "hero" &&
				baseHeroModel.title === nextHero.title &&
				baseHeroModel.subtitle === nextHero.subtitle &&
				normalizeHeadingAlign(baseHeroModel.align, "center") ===
					normalizeHeadingAlign(nextHero.align, "center");
			const entry = state.dirtyPages[state.path] || {};
			const localBlocks = entry.localBlocks || [];
			if (unchanged && !localBlocks.length) {
				closeModal();
				return;
			}

			const heroHtml = serializeHeroInner(nextHero);
			let updatedHtml = entry.html || state.originalHtml || "";
			if (!updatedHtml) return;
			updatedHtml = replaceRegion(updatedHtml, "hero", heroHtml);
			setDirtyPage(state.path, updatedHtml, state.originalHtml, localBlocks);
			applyHtmlToCurrentPage(updatedHtml);
			renderPageSurface();
			refreshUiStateForDirty();
			closeModal();
		});

		openModal({
			title: "Edit hero",
			bodyNodes: [
				buildField({
					label: "Title",
					input: titleInput,
					note: "Hero uses a single h1 and a single subtitle line.",
				}),
				buildField({ label: "Subtitle", input: subtitleInput }),
			],
			footerNodes: [
				el(
					"button",
					{
						class: "cms-btn cms-modal__action cms-btn--danger",
						type: "button",
						"data-close": "true",
					},
					["Stop Editing Hero"],
				),
				saveBtn,
			],
		});
	}

	function stashCurrentPageIfDirty() {
		const existing = state.dirtyPages[state.path] || {};
		const existingLocal = normalizeLocalBlocks(existing.localBlocks || []);
		if (!state.currentDirty && !existingLocal.length) {
			clearDirtyPage(state.path);
			refreshUiStateForDirty();
			return;
		}
		rebuildPreviewHtml();
		if (!state.rebuiltHtml) return;
		setDirtyPage(state.path, state.rebuiltHtml, "", existingLocal);
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
		const usedIds = new Set();
		const occMap = new Map();

		return nodes.map((node, idx) => {
			const clean = node.cloneNode(true);
			clean.querySelectorAll("pre code").forEach((code) => {
				code.classList.remove("hljs");
				code.removeAttribute("data-highlighted");
				code.textContent = code.textContent || "";
			});
			const sig = signatureForHtml(clean.outerHTML || "");
			const occ = sig ? occMap.get(sig) || 0 : 0;
			if (sig) occMap.set(sig, occ + 1);
			const existingId = clean.getAttribute("data-cms-id") || "";
			const cmsId = ensureUniqueCmsId({
				existingId,
				sig,
				occ,
				fallback: clean.outerHTML || sig || String(idx),
				usedIds,
			});
			if (cmsId && existingId !== cmsId) {
				clean.setAttribute("data-cms-id", cmsId);
			}
			const info = detectBlock(clean);
			return {
				idx,
				type: info.type,
				summary: info.summary,
				html: clean.outerHTML,
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
		if (cls.contains("video-stub") && node.getAttribute("data-video")) {
			const cap = node.getAttribute("data-caption") || "";
			return {
				type: "inline-video",
				summary: cap || node.getAttribute("data-video"),
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
		const embed = cls.contains("doc-embed")
			? node
			: node.querySelector(".doc-embed");
		if (embed) {
			return {
				type: "doc-embed",
				summary: embed.getAttribute("data-doc") || "Doc embed",
			};
		}

		if (cls.contains("portfolio-grid")) {
			const count = node.querySelectorAll(".portfolio-card").length;
			return {
				type: "portfolio-grid",
				summary: `Portfolio grid (${count})`,
			};
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

		if (cls.contains("flex-accordion-wrapper")) {
			const title = node.querySelector("h1,h2,h3")?.textContent?.trim() || "";
			return {
				type: "styled-accordion",
				summary: title || "Styled accordion",
			};
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
				summary: h?.textContent?.trim() || "Standard container",
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
		updateTick: 0,
		debug: debugEnabled(),
		debugCodeStyles: debugCodeStylesEnabled(),
		lastReorderLocal: null,
		assetUploads: [],
		prUrl: "",
		prNumber: null,
		prList: loadPrState(),
		dirtyPages: loadDirtyPagesFromStorage(),
		currentDirty: false,
		session: loadSessionState(),
		baselineRegistry: {},

		heroInner: "",
		mainInner: "",
		loadedHeroInner: "",
		loadedMainInner: "",

		blocks: [],

		uiState: "loading",
		uiStateLabel: "LOADING / INITIALISING",
		uiErrorDetail: null,
	};
	window.__CMS_STATE__ = state;
	if (state.debug) {
		window.__CMS_DEBUG__ = {
			buildBaseBlocksWithOcc: (html) => buildBaseBlocksWithOcc(html),
			buildMergedRenderBlocks: (html, locals, options) =>
				buildMergedRenderBlocks(html, locals, options),
			parseBlocks: (html) => parseBlocks(html),
			assignAnchorsFromHtml: (baseHtml, mergedHtml, locals) =>
				assignAnchorsFromHtml(baseHtml, mergedHtml, locals),
		};
	}
	window.__CMS_DEBUG_ENABLE__ = (val = true) => {
		setDebugEnabled(Boolean(val));
		return state.debug;
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

	function pruneLocalBlocksForPr(path, prNumber) {
		if (!path) return;
		const entry = state.dirtyPages[path];
		if (!entry) return;
		const remaining = normalizeLocalBlocks(entry.localBlocks || []).filter(
			(item) => {
				if (!item) return false;
				if (prNumber && item.prNumber === prNumber) return false;
				if (item.status === "pending") {
					if (!prNumber) return false;
					if (!item.prNumber || item.prNumber === prNumber) return false;
				}
				return true;
			},
		);
		if (!remaining.length) {
			clearDirtyPage(path);
			if (path === state.path) state.currentDirty = false;
			return;
		}
		if (path === state.path) {
			updateLocalBlocksAndRender(path, remaining);
		} else {
			const baseHtml =
				entry.baseHtml || entry.dirtyHtml || state.originalHtml || "";
			const updatedHtml = mergeDirtyWithBase(baseHtml, baseHtml, remaining, {
				respectRemovals: hasRemovalActions(remaining),
				path,
			});
			const remappedLocal = assignAnchorsFromHtml(
				baseHtml,
				updatedHtml,
				remaining,
			);
			if (
				normalizeForDirtyCompare(updatedHtml, path) ===
				normalizeForDirtyCompare(baseHtml, path)
			) {
				clearDirtyPage(path);
			} else {
				setDirtyPage(path, updatedHtml, baseHtml, remappedLocal);
			}
		}
	}

	function pruneLocalBlocksForPrAll(prNumber) {
		const paths = Object.keys(state.dirtyPages || {});
		paths.forEach((path) => pruneLocalBlocksForPr(path, prNumber));
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
			// Keep committed markers for this session after merge.
			removePrFromState(number);
			stopPrPolling();
			pruneLocalBlocksForPrAll(number);
			if (state.prUrl) {
				setUiState("pr", buildPrLabel());
				startPrPolling();
			} else {
				await purgeDirtyPagesFromRepo(true);
				await refreshCurrentPageFromRepo();
				pruneLocalBlocksForPrAll(number);
				purgeCleanDirtyPages();
				if (dirtyCount()) setUiState("dirty", buildDirtyLabel());
				else setUiState("clean", "PR MERGED");
			}
			renderPageSurface();
			return;
		}

		if (data.state === "closed") {
			// Drop committed markers when a PR is closed without merge.
			removeSessionCommitted(number);
			removePrFromState(number);
			stopPrPolling();
			resetPendingBlocksIfNoPr();
			if (state.prUrl) {
				setUiState("pr", buildPrLabel());
				startPrPolling();
			} else {
				await purgeDirtyPagesFromRepo(true);
				await refreshCurrentPageFromRepo();
				resetPendingBlocksIfNoPr();
				purgeCleanDirtyPages();
				if (dirtyCount()) setUiState("dirty", buildDirtyLabel());
				else setUiState("clean", "PR CLOSED");
			}
			renderPageSurface();
			return;
		}

		state.prUrl = data.url || state.prUrl;
		state.prNumber = data.number || state.prNumber;
		setUiState("pr", buildPrLabel());
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
	function setUiState(kind, label, options = {}) {
		state.uiState = kind;
		state.uiStateLabel = label;
		if (kind !== "error" || !options.keepErrorDetail) {
			state.uiErrorDetail = null;
		}
		updateStatusStrip();
		if (typeof state._updateNavCommitState === "function")
			state._updateNavCommitState();
		renderBanner();
	}

	function updateStatusStrip() {
		const pill = qs("#cms-status");
		if (pill) {
			pill.classList.remove("ok", "warn", "err", "pr");
			if (state.uiState === "clean") pill.classList.add("ok");
			else if (state.uiState === "loading") pill.classList.add("warn");
			else if (state.uiState === "dirty") pill.classList.add("warn");
			else if (state.uiState === "pr") pill.classList.add("pr");
			else pill.classList.add("err");

			pill.textContent = state.uiStateLabel || state.uiState.toUpperCase();
			if (state.uiState === "pr") {
				pill.title =
					state.prList?.length > 1
						? `PRs: ${state.prList
								.map((pr) => `#${pr.number || "?"}`)
								.join(", ")}`
						: "";
			} else {
				pill.removeAttribute("title");
			}
		}

		// Enable/disable buttons based on state
		const discard = qs("#cms-discard");
		if (discard) discard.disabled = dirtyCount() === 0;

		const prLink = qs("#cms-pr-link");
		if (prLink) {
			if (state.prUrl) {
				prLink.href = state.prUrl;
				prLink.textContent = `PR #${state.prNumber || "?"}`;
				prLink.removeAttribute("title");
				prLink.hidden = false;
			} else {
				prLink.removeAttribute("title");
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

	function buildAccessErrorDetail(path) {
		const apiPath = `/api/repo/file?path=${encodeURIComponent(
			path || DEFAULT_PAGE,
		)}`;
		return {
			title: "Access login required",
			body:
				"The CMS API request was redirected to Cloudflare Access. This happens when /api/* is protected by a separate Access app.",
			hint: "Open the API endpoint in a tab to complete Access login, then reload.",
			actionLabel: "Open API login",
			actionHref: apiPath,
		};
	}

	function setAccessError(path) {
		state.uiErrorDetail = buildAccessErrorDetail(path);
		setUiState("error", "ACCESS REQUIRED", { keepErrorDetail: true });
		renderPageSurface();
	}

	// Builds state.rebuiltHtml from originalHtml + current blocks.
	// Then re-extracts hero/main from rebuiltHtml (so we render from the same pipeline a PR will use).
	function rebuildPreviewHtml() {
		if (!state.originalHtml) return;

		const rebuiltMain = serializeMainFromBlocks(state.blocks, {
			path: state.path || "",
		});

		// If you add hero editing later, this becomes hero editor output.
		// For now we just keep hero as-is.
		const rebuiltHero = serializeHeroInner(
			parseHeroInner(state.heroInner || ""),
		);

		let html = state.originalHtml;
		html = replaceRegion(html, "hero", rebuiltHero);
		html = replaceRegion(html, "main", rebuiltMain);

		state.rebuiltHtml = canonicalizeFullHtml(html, state.path);

		// Re-extract from the rebuilt html for rendering (proof the replacement is correct)
		const hero2 = extractRegion(state.rebuiltHtml, "hero");
		const main2 = extractRegion(state.rebuiltHtml, "main");
		state.heroInner = hero2.found ? hero2.inner : state.heroInner;
		state.mainInner = main2.found ? main2.inner : state.mainInner;
	}

	let highlightRetryCount = 0;
	function getHljsLang(lang) {
		const lower = String(lang || "").toLowerCase();
		if (!lower) return "";
		if (lower === "mermaid") return "";
		if (lower === "js" || lower === "javascript") return "javascript";
		if (lower === "json") return "json";
		if (lower === "html") return "html";
		if (lower === "css") return "css";
		if (lower === "md" || lower === "markdown") return "markdown";
		if (lower === "yml" || lower === "yaml") return "yaml";
		if (lower === "py" || lower === "python") return "python";
		return lower;
	}

	function highlightStaticCodeBlocks() {
		if (!window.hljs?.highlightElement) return false;
		const blocks = Array.from(
			document.querySelectorAll("#cms-portal pre code"),
		).filter((code) => {
			if (code.classList.contains("nohighlight")) return false;
			if (code.isContentEditable) return false;
			if (code.closest(".cms-modal")) return false;
			if (code.closest(".cms-rte")) return false;
			return true;
		});
		blocks.forEach((code) => {
			const lang = getLangFromCodeEl(code);
			if (String(lang || "").toLowerCase() === "mermaid") {
				code.classList.add("nohighlight");
				return;
			}
			const text = String(code.textContent || "");
			code.className = "";
			if (lang) {
				code.className = `language-${lang}`;
				code.setAttribute("data-lang", lang);
			}
			code.removeAttribute("data-highlighted");
			code.textContent = text;
			const hljsLang = getHljsLang(lang);
			if (hljsLang && window.hljs?.highlight) {
				const result = window.hljs.highlight(text, {
					language: hljsLang,
					ignoreIllegals: true,
				});
				code.innerHTML = result.value;
				code.classList.add("hljs");
				code.setAttribute("data-highlighted", "yes");
			} else {
				window.hljs.highlightElement(code);
			}
		});
		return true;
	}

	function scheduleHighlightStaticCodeBlocks() {
		const ok = highlightStaticCodeBlocks();
		if (ok) return;
		if (highlightRetryCount > 10) return;
		highlightRetryCount += 1;
		setTimeout(scheduleHighlightStaticCodeBlocks, 200);
	}

	let mermaidAdminRenderTimer = null;
	let mermaidAdminRenderToken = 0;
	let mermaidAdminLoadPromise = window.__CMS_MERMAID_PREVIEW_PROMISE || null;
	let mermaidAdminLastSignature = "";

	const normalizeMermaidTextForElkAdmin = (text) => {
		const raw = String(text || "").trim();
		if (!raw) return "";
		const decl = /(^|\n)(\s*)(flowchart|graph)(?:-elk)?\b/i.exec(raw);
		if (!decl) return raw;
		const declStart = decl.index + decl[1].length;
		const preamble = raw.slice(0, declStart);
		const hasRendererInit =
			/(^|\n)\s*%%\{init:\s*\{[\s\S]*?["']?flowchart["']?\s*:\s*\{[\s\S]*?defaultRenderer\s*:/i.test(
				raw,
			);
		const readWord = (key) => {
			const m = new RegExp(
				`["']?${key}["']?\\s*:\\s*["']?([A-Z0-9_-]+)["']?\\b`,
				"i",
			).exec(preamble);
			return m ? m[1] : undefined;
		};
		const layoutWord = (readWord("layout") || "").toLowerCase();
		let desiredRenderer = null;
		if (layoutWord === "elk") desiredRenderer = "elk";
		else if (
			layoutWord === "dagre" ||
			layoutWord === "dagre-wrapper" ||
			layoutWord === "dagre-d3"
		)
			desiredRenderer = "dagre-wrapper";
		else if (!hasRendererInit) desiredRenderer = "dagre-wrapper";
		if (!desiredRenderer) return raw;
		const readBool = (key) => {
			const m = new RegExp(
				`["']?${key}["']?\\s*:\\s*(true|false)\\b`,
				"i",
			).exec(preamble);
			if (!m) return undefined;
			return m[1].toLowerCase() === "true";
		};
		const elkConfig = {};
		if (desiredRenderer === "elk") {
			const mergeEdges = readBool("mergeEdges");
			const forceNodeModelOrder = readBool("forceNodeModelOrder");
			const nodePlacementStrategy = readWord("nodePlacementStrategy");
			const considerModelOrder = readWord("considerModelOrder");
			if (typeof mergeEdges === "boolean") elkConfig.mergeEdges = mergeEdges;
			if (typeof forceNodeModelOrder === "boolean")
				elkConfig.forceNodeModelOrder = forceNodeModelOrder;
			if (nodePlacementStrategy)
				elkConfig.nodePlacementStrategy = nodePlacementStrategy;
			if (considerModelOrder) elkConfig.considerModelOrder = considerModelOrder;
		}
		const initConfig = {
			flowchart: { defaultRenderer: desiredRenderer },
		};
		if (desiredRenderer === "elk" && Object.keys(elkConfig).length) {
			initConfig.elk = elkConfig;
		}
		const initDirective = `%%{init: ${JSON.stringify(initConfig)}}%%`;
		const hasDesiredRendererInit = new RegExp(
			`(^|\\n)\\s*%%\\{init:\\s*\\{[\\s\\S]*?defaultRenderer\\s*:\\s*["']?${desiredRenderer.replace(
				/[-/\\^$*+?.()|[\]{}]/g,
				"\\$&",
			)}["']?`,
			"i",
		).test(raw);
		const hasElkOptionsInit =
			desiredRenderer !== "elk"
				? true
				: /(^|\n)\s*%%\{init:\s*\{[\s\S]*?["']?elk["']?\s*:\s*\{[\s\S]*?(mergeEdges|nodePlacementStrategy|forceNodeModelOrder|considerModelOrder)\b/i.test(
						raw,
					);
		if (!hasDesiredRendererInit || !hasElkOptionsInit) {
			return `${raw.slice(0, declStart)}${initDirective}\n${raw.slice(declStart)}`;
		}
		return raw;
	};

	const installMermaidElkCompatForAdminPreview = () => {
		const mermaid = window.mermaid;
		if (!mermaid || mermaid.__cmsElkLayoutCompatInstalled) return;
		mermaid.__cmsElkLayoutCompatInstalled = true;
		const wrapTextArg = (fn, textIndex = 0) => {
			if (typeof fn !== "function") return fn;
			return function (...args) {
				if (args.length > textIndex) {
					args[textIndex] = normalizeMermaidTextForElkAdmin(args[textIndex]);
				}
				return fn.apply(this, args);
			};
		};
		mermaid.render = wrapTextArg(
			typeof mermaid.render === "function" ? mermaid.render.bind(mermaid) : null,
			1,
		);
		mermaid.parse = wrapTextArg(
			typeof mermaid.parse === "function" ? mermaid.parse.bind(mermaid) : null,
			0,
		);
		if (mermaid.mermaidAPI) {
			mermaid.mermaidAPI.render = wrapTextArg(
				typeof mermaid.mermaidAPI.render === "function"
					? mermaid.mermaidAPI.render.bind(mermaid.mermaidAPI)
					: null,
				1,
			);
			mermaid.mermaidAPI.parse = wrapTextArg(
				typeof mermaid.mermaidAPI.parse === "function"
					? mermaid.mermaidAPI.parse.bind(mermaid.mermaidAPI)
					: null,
				0,
			);
			mermaid.mermaidAPI.getDiagramFromText = wrapTextArg(
				typeof mermaid.mermaidAPI.getDiagramFromText === "function"
					? mermaid.mermaidAPI.getDiagramFromText.bind(mermaid.mermaidAPI)
					: null,
				0,
			);
		}
	};

	const loadMermaidAdminScript = () => {
		if (window.mermaid) return Promise.resolve(true);
		if (!mermaidAdminLoadPromise) {
			mermaidAdminLoadPromise = new Promise((resolve) => {
				const script = document.createElement("script");
				script.src = `/assets/script/vendor/mermaid.min.js?v=${MERMAID_BUNDLE_VERSION}`;
				script.async = true;
				script.onload = () => resolve(true);
				script.onerror = () => resolve(false);
				document.head.appendChild(script);
			});
			window.__CMS_MERMAID_PREVIEW_PROMISE = mermaidAdminLoadPromise;
		}
		return mermaidAdminLoadPromise;
	};

	const ensureMermaidAdminReady = async () => {
		if (window.mermaid && window.mermaid.__cmsPreviewReady) return true;
		if (!window.mermaid) await loadMermaidAdminScript();
		if (!window.mermaid) return false;
		window.mermaid.initialize({
			startOnLoad: false,
			theme: "neutral",
			suppressErrorRendering: true,
		});
		installMermaidWarningFilter();
		installMermaidElkCompatForAdminPreview();
		if (
			typeof window.mermaid.registerIconPacks === "function" &&
			!window.mermaid.__cmsPreviewIconsReady
		) {
			const fallbackIcons = {
				prefix: "logos",
				icons: {
					cloud: {
						body: "<defs><linearGradient id=\"SVGZDBLty2B\" x1=\"0%\" x2=\"100%\" y1=\"100%\" y2=\"0%\"><stop offset=\"0%\" stop-color=\"#4D27A8\"/><stop offset=\"100%\" stop-color=\"#A166FF\"/></linearGradient></defs><path fill=\"url(#SVGZDBLty2B)\" d=\"M0 0h256v256H0z\"/><path fill=\"#FFF\" d=\"M176.39 166.794c0-5.293-4.307-9.6-9.6-9.6s-9.6 4.307-9.6 9.6s4.308 9.6 9.6 9.6c5.293 0 9.6-4.308 9.6-9.6m6.4 0c0 8.822-7.177 16-16 16c-8.822 0-16-7.178-16-16c0-8.823 7.178-16 16-16c8.823 0 16 7.177 16 16m-85.536-46.18c0-5.292-4.307-9.6-9.6-9.6c-5.296 0-9.6 4.308-9.6 9.6c0 5.293 4.304 9.6 9.6 9.6c5.293 0 9.6-4.307 9.6-9.6m6.4 0c0 8.823-7.18 16-16 16c-8.822 0-16-7.177-16-16c0-8.822 7.178-16 16-16c8.82 0 16 7.178 16 16m23.482-50.192c0 5.293 4.307 9.6 9.6 9.6c5.296 0 9.6-4.307 9.6-9.6c0-5.296-4.304-9.6-9.6-9.6c-5.293 0-9.6 4.304-9.6 9.6m-6.4 0c0-8.822 7.18-16 16-16c8.822 0 16 7.178 16 16c0 8.823-7.178 16-16 16c-8.82 0-16-7.177-16-16M211.2 128c0-29.674-15.91-57.126-41.562-71.971c-4.598.928-9.046 2.198-14.595 4.205l-2.176-6.02a131 131 0 0 1 7.984-2.61A83 83 0 0 0 128 44.8c-5.405 0-10.723.56-15.92 1.574c3.763 2.202 7.1 4.397 10.342 6.855l-3.868 5.097c-4.57-3.462-9.306-6.396-15.524-9.654c-31.42 9.882-54.05 37.594-57.644 70.138c6.588-1.335 12.915-2.061 19.939-2.234l.157 6.397c-7.36.182-13.684.963-20.596 2.483c-.028.848-.086 1.706-.086 2.544c0 27.706 13.706 53.235 36.246 68.63c-4.01-11.939-6.006-23.222-6.006-34.243c0-6.285 1.082-11.446 2.224-16.909c.266-1.264.534-2.55.797-3.884l6.281 1.238c-.268 1.357-.544 2.672-.812 3.962c-1.12 5.35-2.09 9.97-2.09 15.593c0 12.506 2.746 25.437 8.333 39.479c11.9 6.179 24.752 9.334 38.227 9.334c8.82 0 17.427-1.408 25.638-4.115c3.223-6.359 5.613-12.359 7.61-19.248l6.147 1.782a114 114 0 0 1-5.126 14.147c5.165-2.323 10.051-5.196 14.637-8.55c-1.104-2.707-2.288-5.398-3.597-8.02l5.725-2.863c1.113 2.227 2.134 4.505 3.11 6.797C200.656 175.28 211.2 152.512 211.2 128m6.4 0c0 27.926-12.691 53.757-34.813 70.877c-5.478 4.256-11.42 7.789-17.702 10.633c-2.666 1.21-5.38 2.33-8.17 3.27c-9.216 3.198-18.953 4.82-28.915 4.82c-14.72 0-29.338-3.667-42.278-10.605C56.534 191.38 38.4 161.11 38.4 128c0-2.195.058-3.866.189-5.411c2.179-37.389 27.83-69.75 63.814-80.458C110.598 39.658 119.216 38.4 128 38.4c15.386 0 30.525 3.962 43.789 11.453C200.042 65.68 217.6 95.629 217.6 128m-98.195-46.518l-4.205-4.823c-7.174 6.26-12.755 12.906-19.274 22.944l5.37 3.485c6.17-9.507 11.418-15.766 18.109-21.606m-9.725 41.484l-2.08 6.052c14.698 5.046 27.52 13.097 40.349 25.337l4.419-4.63c-13.523-12.9-27.088-21.402-42.688-26.759m42.787-37.628c12.007 18.31 18.768 38.41 20.093 59.744l-6.387.396c-1.258-20.21-7.667-39.264-19.053-56.63z\"/>",
					},
					user: {
						body: "<defs><linearGradient id=\"SVGhE6sJcGC\" x1=\"0%\" x2=\"100%\" y1=\"100%\" y2=\"0%\"><stop offset=\"0%\" stop-color=\"#BD0816\"/><stop offset=\"100%\" stop-color=\"#FF5252\"/></linearGradient></defs><path fill=\"url(#SVGhE6sJcGC)\" d=\"M0 0h256v256H0z\"/><path fill=\"#FFF\" d=\"M44.8 188.8h166.4V67.2H44.8zM217.6 64v128a3.2 3.2 0 0 1-3.2 3.2H41.6a3.2 3.2 0 0 1-3.2-3.2V64a3.2 3.2 0 0 1 3.2-3.2h172.8a3.2 3.2 0 0 1 3.2 3.2m-76.8 89.6h48v-6.4h-48zm41.6-19.2h16V128h-16zm-41.6 0h25.6V128h-25.6zm-48 12.8c0-1.763-1.434-3.2-3.2-3.2a3.203 3.203 0 0 0-3.2 3.2c0 1.763 1.434 3.2 3.2 3.2s3.2-1.437 3.2-3.2m6.4 0c0 4.166-2.685 7.683-6.4 9.011v6.989h-6.4v-6.992c-3.715-1.325-6.4-4.842-6.4-9.008c0-5.293 4.307-9.6 9.6-9.6s9.6 4.307 9.6 9.6m-38.4 25.578l57.58.022l.007-12.8H105.6v-6.4h12.787l.007-9.6H105.6v-6.4h12.797l.003-9.578L60.82 128zm9.6-51.175l38.4.016V99.2c.003-7.37-8.97-13.834-19.2-13.84h-.013c-10.214 0-19.174 6.467-19.18 13.84zm-16 54.371l.02-51.174a3.2 3.2 0 0 1 3.2-3.2l6.38.003l.006-22.403c.007-11.162 11.482-20.24 25.581-20.24h.013c14.118.006 25.603 9.088 25.6 20.24v22.422l6.4.004a3.2 3.2 0 0 1 3.2 3.2L124.78 176a3.2 3.2 0 0 1-3.2 3.2l-63.98-.026a3.2 3.2 0 0 1-3.2-3.2M192 115.2h6.4v-6.4H192zm-51.2 0H176v-6.4h-35.2z\"/>",
					},
					users: {
						body: "<defs><linearGradient id=\"SVGhE6sJcGC\" x1=\"0%\" x2=\"100%\" y1=\"100%\" y2=\"0%\"><stop offset=\"0%\" stop-color=\"#BD0816\"/><stop offset=\"100%\" stop-color=\"#FF5252\"/></linearGradient></defs><path fill=\"url(#SVGhE6sJcGC)\" d=\"M0 0h256v256H0z\"/><path fill=\"#FFF\" d=\"M44.8 188.8h166.4V67.2H44.8zM217.6 64v128a3.2 3.2 0 0 1-3.2 3.2H41.6a3.2 3.2 0 0 1-3.2-3.2V64a3.2 3.2 0 0 1 3.2-3.2h172.8a3.2 3.2 0 0 1 3.2 3.2m-76.8 89.6h48v-6.4h-48zm41.6-19.2h16V128h-16zm-41.6 0h25.6V128h-25.6zm-48 12.8c0-1.763-1.434-3.2-3.2-3.2a3.203 3.203 0 0 0-3.2 3.2c0 1.763 1.434 3.2 3.2 3.2s3.2-1.437 3.2-3.2m6.4 0c0 4.166-2.685 7.683-6.4 9.011v6.989h-6.4v-6.992c-3.715-1.325-6.4-4.842-6.4-9.008c0-5.293 4.307-9.6 9.6-9.6s9.6 4.307 9.6 9.6m-38.4 25.578l57.58.022l.007-12.8H105.6v-6.4h12.787l.007-9.6H105.6v-6.4h12.797l.003-9.578L60.82 128zm9.6-51.175l38.4.016V99.2c.003-7.37-8.97-13.834-19.2-13.84h-.013c-10.214 0-19.174 6.467-19.18 13.84zm-16 54.371l.02-51.174a3.2 3.2 0 0 1 3.2-3.2l6.38.003l.006-22.403c.007-11.162 11.482-20.24 25.581-20.24h.013c14.118.006 25.603 9.088 25.6 20.24v22.422l6.4.004a3.2 3.2 0 0 1 3.2 3.2L124.78 176a3.2 3.2 0 0 1-3.2 3.2l-63.98-.026a3.2 3.2 0 0 1-3.2-3.2M192 115.2h6.4v-6.4H192zm-51.2 0H176v-6.4h-35.2z\"/>",
					},
					network: {
						body: "<defs><linearGradient id=\"SVGZDBLty2B\" x1=\"0%\" x2=\"100%\" y1=\"100%\" y2=\"0%\"><stop offset=\"0%\" stop-color=\"#4D27A8\"/><stop offset=\"100%\" stop-color=\"#A166FF\"/></linearGradient></defs><path fill=\"url(#SVGZDBLty2B)\" d=\"M0 0h256v256H0z\"/><path fill=\"#FFF\" d=\"m195.2 132.39l-17.6-7.04v63.843c5.14-.512 9.283-2.202 12.227-5.19c5.44-5.53 5.376-13.636 5.373-13.716zm-24 56.844V125.35l-17.6 7.04v37.834c.022.662.749 17.142 17.6 19.011m30.4-19.011c.01.362.17 10.71-7.152 18.208c-4.787 4.906-11.536 7.392-20.048 7.392c-21.034 0-26.992-16.698-27.2-25.523v-40.077c0-1.309.797-2.486 2.013-2.973l24-9.6a3.2 3.2 0 0 1 2.374 0l24 9.6a3.2 3.2 0 0 1 2.013 2.973zm9.603-6.291l-.003-42.743l-36.8-14.72l-36.8 14.72v42.634c-.006.291-.432 19.93 11.309 32.013c6.182 6.361 14.758 9.587 25.491 9.587c10.806 0 19.424-3.248 25.613-9.651c11.725-12.135 11.197-31.645 11.19-31.84m-6.589 36.285c-7.44 7.702-17.606 11.606-30.214 11.606c-12.547 0-22.678-3.891-30.112-11.565c-13.629-14.057-13.117-35.625-13.088-36.534v-44.701c0-1.309.797-2.486 2.013-2.973l40-16a3.2 3.2 0 0 1 2.374 0l40 16a3.2 3.2 0 0 1 2.013 2.973v44.8c.029.8.605 22.33-12.986 36.394M73.776 151.023H121.6v6.4H73.776c-19.45 0-34.298-12.966-35.3-30.832c-.07-.73-.076-1.58-.076-2.432c0-21.98 15.37-30.074 24.333-32.922a50 50 0 0 1-.096-3.113c0-17.45 12.448-35.706 28.95-42.464c19.38-7.936 39.811-4.093 54.637 10.262c4.995 4.867 8.803 10.064 11.558 15.789c3.86-3.312 8.519-5.091 13.51-5.091c10.577 0 21.764 8.3 23.687 24.201c6.986 1.76 15.754 5.498 21.943 13.434l-5.044 3.936c-5.702-7.315-14.307-10.362-20.518-11.635a3.19 3.19 0 0 1-2.554-2.944c-.835-14.147-9.664-20.592-17.513-20.592c-4.679 0-8.826 2.208-11.997 6.384a3.16 3.16 0 0 1-3.024 1.232a3.2 3.2 0 0 1-2.528-2.064c-2.454-6.688-6.371-12.595-11.978-18.058c-12.94-12.525-30.803-15.869-47.753-8.931c-14.237 5.83-24.976 21.54-24.976 36.54c0 1.732.099 3.444.3 5.086a3.204 3.204 0 0 1-2.409 3.49c-8.262 2.046-22.128 8.337-22.128 27.46c0 .646-.006 1.296.058 1.946c.812 14.49 12.972 24.918 28.918 24.918\"/>",
					},
					server: {
						body: "<defs><linearGradient id=\"SVGbGfcrvoV\" x1=\"0%\" x2=\"100%\" y1=\"100%\" y2=\"0%\"><stop offset=\"0%\" stop-color=\"#C8511B\"/><stop offset=\"100%\" stop-color=\"#F90\"/></linearGradient></defs><path fill=\"url(#SVGbGfcrvoV)\" d=\"M0 0h256v256H0z\"/><path fill=\"#FFF\" d=\"M86.4 169.6h80v-80h-80zm86.4-80h12.8V96h-12.8v12.8h12.8v6.4h-12.8v9.6h12.8v6.4h-12.8V144h12.8v6.4h-12.8v12.8h12.8v6.4h-12.8v.435a5.97 5.97 0 0 1-5.965 5.965h-.435v12.8H160V176h-12.8v12.8h-6.4V176h-9.6v12.8h-6.4V176H112v12.8h-6.4V176H92.8v12.8h-6.4V176h-.435A5.97 5.97 0 0 1 80 170.035v-.435h-9.6v-6.4H80v-12.8h-9.6V144H80v-12.8h-9.6v-6.4H80v-9.6h-9.6v-6.4H80V96h-9.6v-6.4H80v-.435a5.97 5.97 0 0 1 5.965-5.965h.435V70.4h6.4v12.8h12.8V70.4h6.4v12.8h12.8V70.4h6.4v12.8h9.6V70.4h6.4v12.8H160V70.4h6.4v12.8h.435a5.97 5.97 0 0 1 5.965 5.965zm-41.6 121.203a.4.4 0 0 1-.397.397H45.197a.4.4 0 0 1-.397-.397v-85.606a.4.4 0 0 1 .397-.397H64v-6.4H45.197a6.805 6.805 0 0 0-6.797 6.797v85.606a6.805 6.805 0 0 0 6.797 6.797h85.606a6.805 6.805 0 0 0 6.797-6.797V195.2h-6.4zm86.4-165.606v85.606a6.805 6.805 0 0 1-6.797 6.797H192v-6.4h18.803a.4.4 0 0 0 .397-.397V45.197a.4.4 0 0 0-.397-.397h-85.606a.4.4 0 0 0-.397.397V64h-6.4V45.197a6.805 6.805 0 0 1 6.797-6.797h85.606a6.805 6.805 0 0 1 6.797 6.797\"/>",
					},
					database: {
						body: "<defs><linearGradient id=\"SVGWTObRdcx\" x1=\"0%\" x2=\"100%\" y1=\"100%\" y2=\"0%\"><stop offset=\"0%\" stop-color=\"#2E27AD\"/><stop offset=\"100%\" stop-color=\"#527FFF\"/></linearGradient></defs><path fill=\"url(#SVGWTObRdcx)\" d=\"M0 0h256v256H0z\"/><path fill=\"#FFF\" d=\"m49.325 44.8l29.737 29.738l-4.524 4.524L44.8 49.325V73.6h-6.4v-32a3.2 3.2 0 0 1 3.2-3.2h32v6.4zM217.6 41.6v32h-6.4V49.325l-29.738 29.737l-4.524-4.524L206.675 44.8H182.4v-6.4h32a3.2 3.2 0 0 1 3.2 3.2m-6.4 140.8h6.4v32a3.2 3.2 0 0 1-3.2 3.2h-32v-6.4h24.275l-29.737-29.738l4.524-4.524l29.738 29.737zm-1.6-56.918c0-10.621-12.262-21.114-32.8-28.068l2.051-6.06C202.458 99.344 216 111.782 216 125.482c0 13.702-13.542 26.144-37.152 34.13l-2.051-6.063c20.54-6.95 32.803-17.44 32.803-28.067m-163.02 0c0 10.176 11.478 20.39 30.706 27.328l-2.172 6.019c-22.202-8.01-34.935-20.163-34.935-33.347c0-13.181 12.733-25.335 34.935-33.348l2.172 6.02c-19.228 6.94-30.707 17.155-30.707 27.328m32.482 55.98L49.325 211.2H73.6v6.4h-32a3.2 3.2 0 0 1-3.2-3.2v-32h6.4v24.275l29.738-29.737zM128 100.115c-22.867 0-35.2-5.907-35.2-8.32c0-2.416 12.333-8.32 35.2-8.32c22.864 0 35.2 5.904 35.2 8.32c0 2.413-12.336 8.32-35.2 8.32m.093 24.784c-21.895 0-35.293-5.98-35.293-9.235v-15.555c7.882 4.349 21.862 6.406 35.2 6.406s27.318-2.057 35.2-6.406v15.555c0 3.258-13.328 9.235-35.107 9.235m0 24.435c-21.895 0-35.293-5.98-35.293-9.235v-15.74c7.78 4.572 21.574 6.94 35.293 6.94c13.641 0 27.357-2.365 35.107-6.925V140.1c0 3.258-13.328 9.235-35.107 9.235M128 171.258c-22.774 0-35.2-6.122-35.2-9.268v-13.196c7.78 4.572 21.574 6.94 35.293 6.94c13.641 0 27.357-2.361 35.107-6.924v13.18c0 3.146-12.426 9.268-35.2 9.268m0-94.183c-20.035 0-41.6 4.605-41.6 14.72v70.195c0 10.285 20.928 15.668 41.6 15.668s41.6-5.383 41.6-15.668V91.795c0-10.115-21.565-14.72-41.6-14.72\"/>",
					},
				},
			};
			const fetchIconPack = async (path) => {
				try {
					const res = await fetch(path);
					if (!res.ok) return null;
					return await res.json();
				} catch {
					return null;
				}
			};
			try {
				const iconUrl = `/assets/icon-packs/logos.json?v=${BUILD_TOKEN}-${Date.now()}`;
				const altIconUrl = `/admin-assets/icon-packs/logos.json?v=${BUILD_TOKEN}-${Date.now()}`;
				const loadIcons = async () =>
					(await fetchIconPack(iconUrl)) ||
					(await fetchIconPack(altIconUrl)) ||
					fallbackIcons;
				const result = window.mermaid.registerIconPacks([
					{
						name: "logos",
						loader: loadIcons,
					},
				]);
				if (result && typeof result.then === "function") await result;
			} catch (err) {
				try {
					window.mermaid.registerIconPacks([
						{ name: "logos", loader: async () => fallbackIcons },
					]);
				} catch {
					console.warn("Mermaid icon pack load failed:", err);
				}
			}
			window.mermaid.__cmsPreviewIconsReady = true;
		}
		window.mermaid.__cmsPreviewReady = true;
		return true;
	};

	const renderMermaidAdminPreview = async () => {
		const root = qs("#cms-portal");
		if (!root) return;
		const scheduleLoadingClear = () => {
			const clear = () => {
				root
					.querySelectorAll(".mermaid-wrap.is-loading")
					.forEach((wrap) => wrap.classList.remove("is-loading"));
			};
			setTimeout(clear, 200);
			setTimeout(clear, 1200);
			setTimeout(clear, 3000);
		};
		const clearExistingPreviews = () => {
			root
				.querySelectorAll(".mermaid-admin-preview")
				.forEach((wrap) => wrap.remove());
			root
				.querySelectorAll("pre.cms-mermaid-source")
				.forEach((pre) => {
					pre.classList.remove("cms-mermaid-source");
					pre.classList.remove("is-show-source");
					pre.removeAttribute("id");
				});
		};

		const blocks = Array.from(root.querySelectorAll("pre code")).filter(
			(code) => {
				if (code.closest(".cms-modal")) return false;
				if (code.closest(".cms-rte")) return false;
				const lang = String(getLangFromCodeEl(code) || "").toLowerCase();
				if (lang === "mermaid") return true;
				const detected = guessLanguageFromText(code.textContent || "");
				return detected === "mermaid";
			},
		);
		const items = blocks
			.map((code) => ({
				code,
				pre: code.closest("pre"),
				text: normalizeMermaidTextForElkAdmin(
					String(code.textContent || "").trim(),
				),
			}))
			.filter((item) => item.pre && item.text);
		const nextSignature = items.map((item) => item.text).join("\n\n%%\n\n");
		if (!items.length) {
			clearExistingPreviews();
			mermaidAdminLastSignature = "";
			return;
		}
		if (
			nextSignature === mermaidAdminLastSignature &&
			root.querySelector(".mermaid-admin-preview")
		) {
			return;
		}
		mermaidAdminLastSignature = nextSignature;
		clearExistingPreviews();
		scheduleLoadingClear();
		const ready = await ensureMermaidAdminReady();
		if (!ready || !window.mermaid) {
			scheduleLoadingClear();
			return;
		}
		const canRender = typeof window.mermaid.render === "function";
		const canRun = typeof window.mermaid.run === "function";
		const canInit = typeof window.mermaid.init === "function";
		const runNodes = [];
		const token = (mermaidAdminRenderToken += 1);
		for (let i = 0; i < items.length; i += 1) {
			const item = items[i];
			const sourceId = `cms-mermaid-source-${BUILD_TOKEN}-${makeLocalId()}-${i}`;
			item.pre.setAttribute("id", sourceId);
			item.pre
				.querySelectorAll(".code-copy-btn, .code-preview-btn")
				.forEach((btn) => btn.remove());
			const wrap = document.createElement("div");
			wrap.className = "mermaid-wrap mermaid-admin-preview is-loading";
			wrap.setAttribute("data-source-id", sourceId);
			item.pre.insertAdjacentElement("afterend", wrap);
			const actions = document.createElement("div");
			actions.className = "mermaid-admin-actions";
			const previewBtn = document.createElement("button");
			previewBtn.type = "button";
			previewBtn.className = "code-preview-btn";
			const copyBtn = document.createElement("button");
			copyBtn.type = "button";
			copyBtn.className = "code-copy-btn";
			copyBtn.textContent = "content_copy";
			copyBtn.setAttribute("aria-label", "Copy code");
			copyBtn.setAttribute("title", "Copy");
			copyBtn.dataset.tooltip = "Copy";
			copyBtn.addEventListener("click", async (event) => {
				event.preventDefault();
				event.stopPropagation();
				const text = item.code.textContent || "";
				try {
					if (navigator.clipboard?.writeText) {
						await navigator.clipboard.writeText(text);
					} else {
						const area = document.createElement("textarea");
						area.value = text;
						area.setAttribute("readonly", "true");
						area.style.position = "fixed";
						area.style.top = "-9999px";
						area.style.left = "-9999px";
						document.body.appendChild(area);
						area.select();
						document.execCommand("copy");
						document.body.removeChild(area);
					}
					copyBtn.classList.add("is-copied");
					copyBtn.textContent = "check";
					setTimeout(() => {
						copyBtn.classList.remove("is-copied");
						copyBtn.textContent = "content_copy";
					}, 1200);
				} catch {
					copyBtn.textContent = "error";
					setTimeout(() => {
						copyBtn.textContent = "content_copy";
					}, 1200);
				}
			});
			actions.appendChild(previewBtn);
			actions.appendChild(copyBtn);
			wrap.appendChild(actions);
			const id = `mermaid-admin-${BUILD_TOKEN}-${makeLocalId()}-${i}`;
			const placeActions = (target) => {
				if (actions.parentElement !== target) target.appendChild(actions);
			};
			const setPreviewState = (showSource) => {
				item.pre.classList.toggle("is-show-source", showSource);
				wrap.classList.toggle("is-show-source", showSource);
				placeActions(showSource ? item.pre : wrap);
				previewBtn.textContent = showSource ? "visibility" : "code";
				const label = showSource ? "Show preview" : "Show source";
				previewBtn.setAttribute("title", label);
				previewBtn.setAttribute("aria-label", label);
				previewBtn.dataset.tooltip = label;
			};
			previewBtn.onclick = (event) => {
				event.preventDefault();
				setPreviewState(!item.pre.classList.contains("is-show-source"));
			};
			setPreviewState(false);
			try {
				if (canRender) {
					const result = await window.mermaid.render(id, item.text);
					if (token !== mermaidAdminRenderToken) return;
					const svg = typeof result === "string" ? result : result?.svg;
					wrap.innerHTML = "";
					wrap.appendChild(actions);
					if (svg) {
						const svgWrap = document.createElement("div");
						svgWrap.className = "cms-mermaid-preview__diagram";
						svgWrap.innerHTML = svg;
						wrap.appendChild(svgWrap);
						result?.bindFunctions?.(svgWrap);
					}
				} else {
					const svgWrap = document.createElement("div");
					svgWrap.className = "cms-mermaid-preview__diagram mermaid";
					svgWrap.textContent = item.text;
					wrap.appendChild(svgWrap);
					runNodes.push(svgWrap);
				}
				item.pre.classList.add("cms-mermaid-source");
			} catch (err) {
				wrap.innerHTML = "";
				wrap.appendChild(actions);
				const errorMsg = document.createElement("div");
				errorMsg.className = "cms-mermaid-preview__error";
				errorMsg.textContent = "Mermaid render failed.";
				wrap.appendChild(errorMsg);
			} finally {
				wrap.classList.remove("is-loading");
			}
		}
		if (!canRender && runNodes.length) {
			try {
				if (canRun) {
					await window.mermaid.run({ nodes: runNodes });
				} else if (canInit) {
					window.mermaid.init(undefined, runNodes);
				}
			} catch (err) {
				runNodes.forEach((node) => {
					const wrap = node.closest(".mermaid-wrap");
					if (!wrap) return;
					wrap.innerHTML = "";
					const errorMsg = document.createElement("div");
					errorMsg.className = "cms-mermaid-preview__error";
					errorMsg.textContent = "Mermaid render failed.";
					wrap.appendChild(errorMsg);
				});
			}
		}
		root
			.querySelectorAll(".mermaid-wrap.is-loading")
			.forEach((wrap) => {
				if (
					wrap.querySelector("svg") ||
					wrap.querySelector(".mermaid[data-processed='true']") ||
					wrap.querySelector(".cms-mermaid-preview__diagram")
				) {
					wrap.classList.remove("is-loading");
				}
			});
		document.documentElement.classList.add("mermaid-ready");
		scheduleLoadingClear();
	};

	const scheduleMermaidAdminPreview = () => {
		if (mermaidAdminRenderTimer) clearTimeout(mermaidAdminRenderTimer);
		mermaidAdminRenderTimer = setTimeout(renderMermaidAdminPreview, 60);
	};

	function renderPageSurface() {
		const entry = state.dirtyPages[state.path];
		const entryHtml = entry?.html ? String(entry.html) : "";
		if (entryHtml.trim()) {
			const hero = extractRegion(entryHtml, "hero");
			const main = extractRegion(entryHtml, "main");
			if (hero.found) state.heroInner = hero.inner;
			if (main.found) {
				state.mainInner = main.inner;
				state.blocks = parseBlocks(state.mainInner);
			}
		} else if (state.originalHtml) {
			const hero = extractRegion(state.originalHtml, "hero");
			const main = extractRegion(state.originalHtml, "main");
			if (hero.found) state.heroInner = hero.inner;
			if (main.found) {
				state.mainInner = main.inner;
				state.blocks = parseBlocks(state.mainInner);
			}
		}

		const root = qs("#cms-portal");
		root.innerHTML = "";

		// Hero
		const heroDoc = new DOMParser().parseFromString(
			state.heroInner || "",
			"text/html",
		).body;
		Array.from(heroDoc.children).forEach((n) => root.appendChild(n));
		const heroWrap = root.querySelector(".default-div-wrapper.hero-override");
		if (heroWrap) {
			heroWrap.classList.add("cms-hero-editable");
			let heroBtn = heroWrap.querySelector(".cms-hero-edit");
			if (!heroBtn) {
				heroBtn = el(
					"button",
					{
						type: "button",
						class: "cms-block__btn cms-block__btn--edit cms-hero-edit",
						title: "Edit hero",
						"aria-label": "Edit hero",
					},
					[buildPenIcon(), "Edit"],
				);
				heroBtn.addEventListener("click", (event) => {
					event.preventDefault();
					openHeroEditor();
				});
				heroWrap.appendChild(heroBtn);
			}
		}

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

		if (state.uiState === "error" && state.uiErrorDetail) {
			const detail = state.uiErrorDetail;
			const actions = [];
			if (detail.actionHref) {
				actions.push(
					el(
						"a",
						{
							class: "cms-btn cms-btn--move",
							href: detail.actionHref,
							target: "_blank",
							rel: "noopener noreferrer",
						},
						[detail.actionLabel || "Open API login"],
					),
				);
			}
			actions.push(
				el(
					"button",
					{
						class: "cms-btn",
						type: "button",
						onclick: () => location.reload(),
					},
					["Reload page"],
				),
			);
			mainWrap.appendChild(
				el("div", { class: "cms-empty" }, [
					el("div", { class: "cms-empty-title" }, [
						detail.title || "Access required",
					]),
					detail.body
						? el("p", { class: "cms-modal__text" }, [detail.body])
						: null,
					detail.hint
						? el("p", { class: "cms-modal__text" }, [detail.hint])
						: null,
					el("div", { class: "cms-field__row" }, actions),
				].filter(Boolean)),
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
					openInsertBlockModal(0, null);
				});
			});

			root.appendChild(mainWrap);
			return;
		}

		const insertDivider = (
			index,
			label = "Insert block",
			anchorInfo = null,
		) => {
			const attrs = {
				class: "cms-divider-btn",
				type: "button",
				"data-insert": String(index),
			};
			if (anchorInfo?.anchor?.id) {
				attrs["data-anchor-id"] = anchorInfo.anchor.id;
				if (Number.isInteger(anchorInfo.anchor.occ))
					attrs["data-anchor-occ"] = String(anchorInfo.anchor.occ);
				if (anchorInfo.placement)
					attrs["data-anchor-placement"] = anchorInfo.placement;
			} else if (anchorInfo?.anchor?.sig) {
				attrs["data-anchor-sig"] = anchorInfo.anchor.sig;
				if (Number.isInteger(anchorInfo.anchor.occ))
					attrs["data-anchor-occ"] = String(anchorInfo.anchor.occ);
				if (anchorInfo.placement)
					attrs["data-anchor-placement"] = anchorInfo.placement;
			}
			return el("button", attrs, [
				el("span", { class: "cms-divider-line", "aria-hidden": "true" }),
				el("span", { class: "cms-divider-plus", "aria-hidden": "true" }, [
					"＋",
				]),
				el("span", { class: "cms-divider-text" }, [label]),
				el("span", { class: "cms-divider-line", "aria-hidden": "true" }),
			]);
		};

		// Render from state.blocks (raw HTML),
		// then run sections/lightbox for parity (same as your live site).
		const localBlocks = getHydratedLocalBlocks(
			state.originalHtml || "",
			state.dirtyPages[state.path]?.localBlocks || [],
		);
		const mergedRender = buildMergedRenderBlocks(
			state.originalHtml || "",
			localBlocks,
			{ respectRemovals: true },
		);
		const anchorForIndex = (idx) => getAnchorForIndex(idx, mergedRender || []);

		mainWrap.appendChild(insertDivider(0, "Insert block", anchorForIndex(0)));

		const sessionList = state.session.baselines[state.path] || [];
		const sessionCountsById = new Map();
		const sessionCountsBySig = new Map();
		sessionList.forEach((entry) => {
			if (!entry) return;
			if (typeof entry === "object") {
				if (entry.id)
					sessionCountsById.set(
						entry.id,
						(sessionCountsById.get(entry.id) || 0) + 1,
					);
				if (entry.sig)
					sessionCountsBySig.set(
						entry.sig,
						(sessionCountsBySig.get(entry.sig) || 0) + 1,
					);
				return;
			}
			sessionCountsBySig.set(entry, (sessionCountsBySig.get(entry) || 0) + 1);
		});
		const committedState = committedMatchesForPath(state.path);
		const committedCountsById = committedState.countsById;
		const committedCountsBySig = committedState.countsBySig;
		const committedByPosById = committedState.byPosById;
		const committedByPosBySig = committedState.byPosBySig;
		const markMap = new Map();
		localBlocks
			.filter((item) => item.action === "mark")
			.forEach((item) => {
				const key = anchorKey(item.anchor);
				if (!key) return;
				const list = markMap.get(key) || [];
				list.push(item);
				markMap.set(key, list);
			});
		const baseBlocks = buildBaseBlocksWithOcc(state.originalHtml || "");
		const baselineOrder = baseBlocks.map((b) => b.id);
		const currentOrder = buildBaseOrderFromReorders(baseBlocks, localBlocks);
		const reorderIds = new Set(
			currentOrder.filter(
				(id, idx) => baselineOrder[idx] && baselineOrder[idx] !== id,
			),
		);

		mergedRender.forEach((b, idx) => {
			const frag = new DOMParser().parseFromString(b.html, "text/html").body;
			const blockRoot = frag.firstElementChild || frag.children[0] || null;
			const parsedBlock = blockRoot ? parseMainBlockNode(blockRoot) : null;
			const blockType = parsedBlock?.type || "";
			const isGridRow =
				blockType === "hoverCardRow" || blockType === "squareGridRow";
			const html = (b.html || "").trim();
			const localItem = b._local || null;
			const isPending = localItem?.status === "pending";
			const pendingItem = isPending ? localItem : null;
			const isBase = Boolean(b._base);
			const isMarkedRemove = isBase && markMap.get(anchorKey(b))?.length > 0;

			let status = "baseline";
			if (localItem) {
				if (localItem.status === "pending") status = "pending";
				else status = localItem.kind === "edited" ? "edited" : "new";
			} else {
				const baseId = b.id || null;
				const sig = b.sig || signatureForHtml(html);
				let committedAtPos = -1;
				if (baseId) {
					const list = committedByPosById.get(idx) || [];
					committedAtPos = list.findIndex((id) => id === baseId);
					if (committedAtPos >= 0) {
						list.splice(committedAtPos, 1);
						if (!list.length) committedByPosById.delete(idx);
						else committedByPosById.set(idx, list);
						status = "committed";
					}
				}
				if (committedAtPos < 0 && sig) {
					const list = committedByPosBySig.get(idx) || [];
					committedAtPos = list.findIndex((s) => s === sig);
					if (committedAtPos >= 0) {
						list.splice(committedAtPos, 1);
						if (!list.length) committedByPosBySig.delete(idx);
						else committedByPosBySig.set(idx, list);
						status = "committed";
					}
				}
				if (committedAtPos >= 0) {
					// already marked committed
				} else if (baseId) {
					if (reorderIds.has(baseId)) {
						status = "edited";
					} else {
						const committedRemaining = committedCountsById.get(baseId) || 0;
						if (committedRemaining > 0) {
							committedCountsById.set(baseId, committedRemaining - 1);
							status = "committed";
						} else {
							const remaining = sessionCountsById.get(baseId) || 0;
							if (remaining > 0) sessionCountsById.set(baseId, remaining - 1);
							else {
								const fallbackSig = sig || signatureForHtml(html);
								const sigRemaining = fallbackSig
									? sessionCountsBySig.get(fallbackSig) || 0
									: 0;
								if (sigRemaining > 0) {
									sessionCountsBySig.set(fallbackSig, sigRemaining - 1);
								} else if (sessionCountsById.size || sessionCountsBySig.size) {
									status = "edited";
								}
							}
						}
					}
				} else {
					const committedRemaining = sig
						? committedCountsBySig.get(sig) || 0
						: 0;
					if (committedRemaining > 0) {
						committedCountsBySig.set(sig, committedRemaining - 1);
						status = "committed";
					} else {
						const remaining = sig ? sessionCountsBySig.get(sig) || 0 : 0;
						if (remaining > 0) sessionCountsBySig.set(sig, remaining - 1);
						else status = "edited";
					}
				}
			}
			if (isMarkedRemove) status = "removed";

			const classes = ["cms-block"];
			if (status === "pending") classes.push("cms-block--pending");
			else classes.push(`cms-block--${status}`);
			const wrapper = el("div", { class: classes.join(" ") });
			if (isGridRow) wrapper.classList.add("cms-block--dark-controls");
			if (isBase) {
				if (b.id) wrapper.setAttribute("data-base-id", b.id);
				if (b.sig) wrapper.setAttribute("data-base-sig", b.sig);
				if (Number.isInteger(b.occ))
					wrapper.setAttribute("data-base-occ", String(b.occ));
			}
			Array.from(frag.children).forEach((n) => wrapper.appendChild(n));
			if (localItem && !isPending) {
				const controls = el("div", { class: "cms-block__controls" }, []);
				if (!isGridRow) {
					controls.appendChild(
						el(
							"button",
							{
								type: "button",
								class: "cms-block__btn cms-block__btn--edit",
								"data-action": "edit",
								"data-id": localItem.id || "",
								"data-index": String(idx),
								"data-origin": "local",
								title: "Edit block",
							},
							[buildPenIcon(), "Edit"],
						),
					);
				}
				controls.appendChild(
					el(
						"button",
						{
							type: "button",
							class: "cms-block__btn cms-block__btn--move",
							"data-action": "up",
							"data-id": localItem.id || "",
							"data-index": String(idx),
							"data-origin": "local",
							title: "Move up",
						},
						["↑"],
					),
				);
				controls.appendChild(
					el(
						"button",
						{
							type: "button",
							class: "cms-block__btn cms-block__btn--move",
							"data-action": "down",
							"data-id": localItem.id || "",
							"data-index": String(idx),
							"data-origin": "local",
							title: "Move down",
						},
						["↓"],
					),
				);
				controls.appendChild(
					el(
						"button",
						{
							type: "button",
							class: "cms-block__btn cms-block__btn--danger",
							"data-action": "delete",
							"data-id": localItem.id || "",
							"data-index": String(idx),
							"data-origin": "local",
							title: "Delete block",
						},
						[buildTrashIcon(), "Delete"],
					),
				);
				wrapper.appendChild(controls);
			}
			if (!localItem && !isPending && isBase) {
				const isUndo = isMarkedRemove;
				const controls = el("div", { class: "cms-block__controls" }, []);
				if (!isGridRow) {
					controls.appendChild(
						el(
							"button",
							{
								type: "button",
								class: "cms-block__btn cms-block__btn--edit",
								"data-action": "edit",
								"data-index": String(idx),
								"data-origin": "base",
								title: "Edit block",
							},
							[buildPenIcon(), "Edit"],
						),
					);
				}
				controls.appendChild(
					el(
						"button",
						{
							type: "button",
							class: "cms-block__btn cms-block__btn--move",
							"data-action": "up",
							"data-index": String(idx),
							"data-origin": "base",
							title: "Move up",
						},
						["↑"],
					),
				);
				controls.appendChild(
					el(
						"button",
						{
							type: "button",
							class: "cms-block__btn cms-block__btn--move",
							"data-action": "down",
							"data-index": String(idx),
							"data-origin": "base",
							title: "Move down",
						},
						["↓"],
					),
				);
				controls.appendChild(
					el(
						"button",
						{
							type: "button",
							class: "cms-block__btn cms-block__btn--danger",
							"data-action": "delete",
							"data-index": String(idx),
							"data-origin": "base",
							"data-removed": isUndo ? "true" : "false",
							title: "Delete block",
						},
						[buildTrashIcon(), isUndo ? "Undo" : "Delete"],
					),
				);
				wrapper.appendChild(controls);
			}
			if (status !== "pending") {
				const label =
					status === "new"
						? "New block"
						: status === "edited"
							? "Edited"
							: status === "committed"
								? "Committed"
								: status === "removed"
									? "Marked delete"
									: "Baseline";
				wrapper.appendChild(
					el("div", { class: `cms-block__badge cms-block__badge--${status}` }, [
						label,
					]),
				);
			}
			if (isPending) {
				const label = pendingItem?.prNumber
					? `Committed PR #${pendingItem.prNumber}`
					: "Committed PR";
				wrapper.appendChild(
					el("div", { class: "cms-block__overlay" }, [label]),
				);
			}
			if (isMarkedRemove) {
				wrapper.appendChild(
					el(
						"div",
						{ class: "cms-block__overlay cms-block__overlay--remove" },
						["Marked for deletion"],
					),
				);
			}
			mainWrap.appendChild(wrapper);
			if (!isPending && !isMarkedRemove && isGridRow) {
				attachGridRowControls({
					wrapper,
					type: blockType,
					origin: localItem ? "local" : "base",
					localId: localItem?.id || "",
					anchorBase: isBase ? { id: b.id, sig: b.sig, occ: b.occ } : null,
				});
			}
			mainWrap.appendChild(
				insertDivider(idx + 1, "Insert block", anchorForIndex(idx + 1)),
			);
		});

		root.appendChild(mainWrap);
		scheduleHighlightStaticCodeBlocks();
		scheduleMermaidAdminPreview();

		queueMicrotask(() => {
			mainWrap
				.querySelectorAll(".cms-divider-btn[data-insert]")
				.forEach((btn) => {
				btn.addEventListener("click", () => {
					const at = Number(btn.getAttribute("data-insert") || "0");
					const anchorId = btn.getAttribute("data-anchor-id") || "";
					const anchorSig = btn.getAttribute("data-anchor-sig") || "";
					const anchorOccRaw = btn.getAttribute("data-anchor-occ");
					const anchorOcc = Number.isInteger(Number(anchorOccRaw))
						? Number(anchorOccRaw)
						: null;
					const anchorPlacement =
						btn.getAttribute("data-anchor-placement") || "after";
					const anchorInfo = anchorId
						? {
								anchor: {
									id: anchorId,
									sig: anchorSig,
									occ: anchorOcc,
								},
								placement: anchorPlacement,
							}
						: null;
					openInsertBlockModal(at, anchorInfo);
				});
			});
			mainWrap.querySelectorAll(".cms-block__btn").forEach((btn) => {
				btn.addEventListener("click", () => {
					const action = btn.getAttribute("data-action") || "";
					const id = btn.getAttribute("data-id") || "";
					const origin =
						btn.getAttribute("data-origin") || (id ? "local" : "base");
					const blockEl = btn.closest(".cms-block");
					const blockNodes = Array.from(
						mainWrap.querySelectorAll(".cms-block"),
					);
					const index = blockEl ? blockNodes.indexOf(blockEl) : -1;
					const isRemoved = btn.getAttribute("data-removed") === "true";
					if (action === "edit") {
						const baseHtml = state.originalHtml || "";
						const currentLocal = getHydratedLocalBlocks(
							baseHtml,
							state.dirtyPages[state.path]?.localBlocks || [],
						);
						const merged = buildMergedRenderBlocks(baseHtml, currentLocal, {
							respectRemovals: true,
						});
						const localIndex =
							origin === "local"
								? merged.findIndex((item) => item?._local?.id === id)
								: -1;
						const currentIndex =
							origin === "local"
								? localIndex >= 0
									? localIndex
									: index
								: index;
						if (currentIndex < 0) return;
						const targetBlock = merged[currentIndex];
						if (!targetBlock?.html) return;
						openBlockEditor({
							blockHtml: targetBlock.html,
							origin,
							localId: id,
							anchorBase: targetBlock._base
								? {
										id: targetBlock.id,
										sig: targetBlock.sig,
										occ: targetBlock.occ,
									}
								: null,
							currentLocal,
						});
						return;
					}
					const baseHtml = state.originalHtml || "";
					const currentLocal = getHydratedLocalBlocks(
						baseHtml,
						state.dirtyPages[state.path]?.localBlocks || [],
					);
					const merged = buildMergedRenderBlocks(baseHtml, currentLocal, {
						respectRemovals: true,
					});
					const localIndex =
						origin === "local"
							? merged.findIndex((item) => item?._local?.id === id)
							: -1;
					const currentIndex =
						origin === "local" ? (localIndex >= 0 ? localIndex : index) : index;
					if (currentIndex < 0) return;
					if (action === "delete") {
						if (origin === "base" && isRemoved) {
							const baseBlock = merged[currentIndex];
							if (!baseBlock?._base) return;
							const anchor = {
								id: baseBlock.id,
								sig: baseBlock.sig,
								occ: baseBlock.occ,
							};
							const key = anchorKey(anchor);
							const updated = currentLocal.filter(
								(item) =>
									!(item.action === "mark" && anchorKey(item.anchor) === key),
							);
							updateLocalBlocksAndRender(state.path, updated);
							return;
						}
						const baseBlock = merged[currentIndex];
						const isBaseBlock = origin === "base" && baseBlock?._base;
						confirmDeleteBlock({
							message: isBaseBlock
								? "Mark this block for deletion? It stays visible until the PR is merged."
								: "Are you sure you want to delete this block?",
							confirmLabel: isBaseBlock ? "Mark for deletion" : "Delete",
							onConfirm: () => {
								if (origin === "local") {
									const remaining = currentLocal.filter(
										(item) => item.id !== id,
									);
									updateLocalBlocksAndRender(state.path, remaining);
									return;
								}
								if (!baseBlock?._base) return;
								const anchor = {
									id: baseBlock.id,
									sig: baseBlock.sig,
									occ: baseBlock.occ,
								};
								const key = anchorKey(anchor);
								const alreadyRemoved = currentLocal.some(
									(item) =>
										item.action === "mark" && anchorKey(item.anchor) === key,
								);
								if (alreadyRemoved) return;
								const updated = [
									...currentLocal,
									{
										id: makeLocalId(),
										html: baseBlock.html || "",
										anchor,
										placement: "after",
										status: "staged",
										kind: "edited",
										action: "mark",
										baseId: baseBlock.id || null,
									},
								];
								updateLocalBlocksAndRender(state.path, updated);
							},
						});
						return;
					}
					const delta = action === "up" ? -1 : 1;
					const targetIndex = Math.max(
						0,
						Math.min(currentIndex + delta, merged.length - 1),
					);
					if (targetIndex === currentIndex) {
						recordMoveDebug({
							action,
							origin,
							currentIndex,
							targetIndex,
							reason: "no-op",
						});
						return;
					}
					if (origin === "local") {
						recordMoveDebug({
							action,
							origin,
							currentIndex,
							targetIndex,
							id,
							step: "local-move",
						});
						const remaining = currentLocal.filter((item) => item.id !== id);
						const mergedWithout = buildMergedRenderBlocks(baseHtml, remaining, {
							respectRemovals: hasRemovalActions(remaining),
						});
						const anchorInfo = getAnchorForIndex(targetIndex, mergedWithout);
						if (state.debug) {
							recordMoveDebug({
								action,
								origin,
								currentIndex,
								targetIndex,
								id,
								step: "local-anchor",
								anchorInfo,
								snapshot: summarizeMergedBlocks(
									mergedWithout,
									targetIndex,
									4,
								),
							});
						}
						const moving = currentLocal.find((item) => item.id === id);
						if (!moving) return;
						const desired = [...mergedWithout];
						desired.splice(targetIndex, 0, { _local: moving });
						const posById = new Map();
						desired.forEach((block, idx) => {
							if (block?._local?.id) posById.set(block._local.id, idx);
						});
						const updated = [
							...remaining.map((item) => ({
								...item,
								pos: posById.get(item.id) ?? item.pos ?? null,
							})),
							{
								...moving,
								anchor: anchorInfo.anchor,
								placement: anchorInfo.placement,
								pos: posById.get(moving.id) ?? targetIndex,
							},
						];
						updateLocalBlocksAndRender(state.path, updated);
						return;
					}
					const baseBlock = merged[currentIndex];
					if (!baseBlock?._base) {
						recordMoveDebug({
							action,
							origin,
							currentIndex,
							targetIndex,
							reason: "missing-base",
						});
						return;
					}
					const targetBlock = merged[targetIndex];
					if (targetBlock?._local) {
						const anchor = {
							id: baseBlock.id,
							sig: baseBlock.sig,
							occ: baseBlock.occ,
						};
						const placement = delta < 0 ? "after" : "before";
						const updated = normalizeLocalBlocks(currentLocal).map((item) =>
							item.id === targetBlock._local.id
								? { ...item, anchor, placement }
								: item,
						);
						recordMoveDebug({
							action,
							origin,
							currentIndex,
							targetIndex,
							baseKey: anchorKey(anchor),
							step: "base-swap-local",
							localId: targetBlock._local.id,
							placement,
						});
						updateLocalBlocksAndRender(state.path, updated);
						return;
					}
					const baseKey = anchorKey({
						id: baseBlock.id,
						sig: baseBlock.sig,
						occ: baseBlock.occ,
					});
					const registry =
						state.baselineRegistry[state.path] ||
						buildBaselineRegistry(baseHtml || "");
					const baseOrder =
						registry.blocks || buildBaseBlocksWithOcc(baseHtml || "");
					const baseOrderKeys = baseOrder.map((b) => anchorKey(b));
					const currentBaseOrder = merged
						.filter((item) => item?._base)
						.map((item) => ({
							key: anchorKey(item),
							sig: item.sig,
							occ: item.occ,
							html: item.html,
						}))
						.filter((item) => item.key);
					const currentBaseIndex = currentBaseOrder.findIndex(
						(item) => item.key === baseKey,
					);
					if (currentBaseIndex < 0) {
						recordMoveDebug({
							action,
							origin,
							currentIndex,
							targetIndex,
							baseKey,
							reason: "base-index-miss",
						});
						return;
					}
					const targetBaseIndex = Math.max(
						0,
						Math.min(currentBaseIndex + delta, currentBaseOrder.length - 1),
					);
					if (targetBaseIndex === currentBaseIndex) {
						recordMoveDebug({
							action,
							origin,
							currentIndex,
							targetIndex,
							baseKey,
							reason: "base-no-op",
						});
						return;
					}
					const nextOrder = [...currentBaseOrder];
					const [movingBase] = nextOrder.splice(currentBaseIndex, 1);
					nextOrder.splice(targetBaseIndex, 0, movingBase);
					const nextOrderKeys = nextOrder.map((item) => item.key);
					const origIndex = new Map();
					baseOrderKeys.forEach((key, idx) => {
						if (!key) return;
						origIndex.set(key, idx);
					});
					const movedKeys = nextOrderKeys.filter(
						(key, idx) => origIndex.get(key) !== idx,
					);
					const cleanedLocal = normalizeLocalBlocks(currentLocal).filter(
						(item) => item.action !== "reorder",
					);
					if (!movedKeys.length) {
						recordMoveDebug({
							action,
							origin,
							currentIndex,
							targetIndex,
							baseKey,
							reason: "no-moved-keys",
						});
						updateLocalBlocksAndRender(state.path, cleanedLocal);
						return;
					}
					recordMoveDebug({
						action,
						origin,
						currentIndex,
						targetIndex,
						baseKey,
						movedCount: movedKeys.length,
					});
					const nextOrderIds = nextOrder
						.map((item) => item.key?.replace(/^id:/, "") || "")
						.filter(Boolean);
					const reorderEntry = {
						id: makeLocalId(),
						html: "",
						anchor: null,
						placement: null,
						status: "staged",
						kind: "edited",
						action: "reorder",
						order: nextOrderIds,
					};
					updateLocalBlocksAndRender(state.path, [
						...cleanedLocal,
						reorderEntry,
					]);
				});
			});
		});

		// Parity behaviours
		window.runSections?.();
		applyLocalImagePreviews(root);
		window.initLightbox?.();
		renderDebugOverlay();
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
		const updatePill = el(
			"span",
			{ id: "cms-update-pill", class: "cms-pill" },
			[`UPD ${UPDATE_VERSION}.0-${BUILD_TOKEN}`],
		);
		const debugPill = el(
			"button",
			{
				id: "cms-debug-pill",
				class: "cms-pill",
				type: "button",
				title: "Toggle debug panel",
			},
			[state.debug ? "DBG ON" : "DBG OFF"],
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
				el("div", { class: "cms-strip-mid" }, [
					statusPill,
					updatePill,
					debugPill,
					prLink,
				]),
				el("div", { class: "cms-strip-right cms-controls" }, [
					discardBtn,
					exitBtn,
				]),
			]),
		);
	}

	function renderDebugPill() {
		const pill = qs("#cms-debug-pill");
		if (!pill) return;
		pill.textContent = state.debug ? "DBG ON" : "DBG OFF";
	}

	function bumpUpdatePill() {
		state.updateTick += 1;
		const pill = qs("#cms-update-pill");
		if (pill)
			pill.textContent = `UPD ${UPDATE_VERSION}.${state.updateTick}-${BUILD_TOKEN}`;
	}

	function renderDebugOverlay() {
		let host = qs("#cms-debug-panel");
		if (!host) {
			host = el("div", { id: "cms-debug-panel" }, []);
			const header = el("div", { id: "cms-debug-header" }, []);
			const btn = el("button", { id: "cms-debug-copy", type: "button" }, [
				"Copy",
			]);
			const styleBtn = el(
				"button",
				{ id: "cms-debug-code-style", type: "button" },
				[state.debugCodeStyles ? "Code CSS ON" : "Code CSS OFF"],
			);
			const close = el("button", { id: "cms-debug-close", type: "button" }, [
				"×",
			]);
			const pre = el("pre", { id: "cms-debug-text" }, []);
			header.appendChild(btn);
			header.appendChild(styleBtn);
			header.appendChild(close);
			host.appendChild(header);
			host.appendChild(pre);
			document.body.appendChild(host);

			btn.addEventListener("click", async () => {
				const text = qs("#cms-debug-text")?.textContent || "";
				if (!text) return;
				try {
					await navigator.clipboard.writeText(text);
					btn.textContent = "Copied";
					setTimeout(() => {
						btn.textContent = "Copy";
					}, 1200);
				} catch {
					btn.textContent = "Failed";
					setTimeout(() => {
						btn.textContent = "Copy";
					}, 1200);
				}
			});
			styleBtn.addEventListener("click", () => {
				setDebugCodeStylesEnabled(!state.debugCodeStyles);
			});
			close.addEventListener("click", () => {
				setDebugEnabled(false);
			});
		}
		if (!state.debug) {
			host.style.display = "none";
			return;
		}
		host.style.display = "block";
		host.style.position = "fixed";
		host.style.right = "10px";
		host.style.bottom = "10px";
		host.style.maxWidth = "45vw";
		host.style.maxHeight = "45vh";
		host.style.overflow = "auto";
		host.style.padding = "10px";
		host.style.background = "rgba(0,0,0,0.8)";
		host.style.color = "#fff";
		host.style.fontSize = "11px";
		host.style.zIndex = "99999";
		host.style.borderRadius = "6px";
		host.style.display = "flex";
		host.style.flexDirection = "column";
		host.style.gap = "6px";

		const header = qs("#cms-debug-header");
		if (header) {
			header.style.display = "flex";
			header.style.gap = "6px";
			header.style.alignItems = "center";
		}
		const btn = qs("#cms-debug-copy");
		if (btn) {
			btn.style.alignSelf = "flex-start";
			btn.style.fontSize = "11px";
		}
		const close = qs("#cms-debug-close");
		if (close) {
			close.style.fontSize = "12px";
			close.style.padding = "2px 6px";
		}
		const styleBtn = qs("#cms-debug-code-style");
		if (styleBtn) {
			styleBtn.textContent = state.debugCodeStyles
				? "Code CSS ON"
				: "Code CSS OFF";
			styleBtn.style.fontSize = "11px";
		}

		const baseBlocks = buildBaseBlocksWithOcc(state.originalHtml || "");
		const baselineOrder = baseBlocks.map((b) => b.id);
		const localBlocks = normalizeLocalBlocks(
			state.dirtyPages[state.path]?.localBlocks || [],
		);
		const cmsIdCounts = new Map();
		const missingCmsIds = [];
		const recordCmsId = (id) => {
			if (!id) return;
			cmsIdCounts.set(id, (cmsIdCounts.get(id) || 0) + 1);
		};
		const mainSnapshot = state.mainInner || "";
		const mainDoc = new DOMParser().parseFromString(
			`<div id="__wrap__">${mainSnapshot}</div>`,
			"text/html",
		);
		Array.from(mainDoc.querySelectorAll("#__wrap__ > *")).forEach((node) => {
			const id = node.getAttribute("data-cms-id") || "";
			if (!id) missingCmsIds.push(node.tagName.toLowerCase());
			else recordCmsId(id);
		});
		const duplicates = Array.from(cmsIdCounts.entries())
			.filter(([, count]) => count > 1)
			.map(([id, count]) => `${id}(${count})`);
		const currentOrder = buildBaseOrderFromReorders(baseBlocks, localBlocks);
		const short = (id) => (id ? String(id).slice(0, 10) : "null");
		const lines = [];
		lines.push(`path: ${state.path}`);
		lines.push(
			`cms-id duplicates: ${duplicates.length ? duplicates.join(", ") : "none"}`,
		);
		lines.push(
			`cms-id missing: ${missingCmsIds.length ? missingCmsIds.length : "0"}`,
		);
		lines.push(`baseline: ${baselineOrder.map(short).join(", ")}`);
		lines.push(`current : ${currentOrder.map(short).join(", ")}`);
		lines.push(
			`locals  : ${localBlocks
				.map(
					(l) =>
						`${l.action}:${short(l.baseId)}:${l.pos ?? "x"}:${short(
							l.anchor?.id,
						)}`,
				)
				.join(" | ")}`,
		);
		if (state.debugCodeStyles) {
			const codes = Array.from(document.querySelectorAll("pre code"));
			const missingLang = codes.filter((code) => {
				const cls = code.getAttribute("class") || "";
				return !code.getAttribute("data-lang") && !/language-/.test(cls);
			}).length;
			const missingHljs = codes.filter(
				(code) => !code.classList.contains("hljs"),
			).length;
			lines.push(
				`code-style: blocks=${codes.length} data-lang-missing=${missingLang} hljs-missing=${missingHljs}`,
			);
			if (codes[0]) {
				const css = getComputedStyle(codes[0]);
				lines.push(
					`code-style sample: padding=${css.padding} radius=${css.borderRadius} bg=${css.backgroundColor}`,
				);
			}
		}
		if (state.lastMove) {
			lines.push(`lastMove: ${JSON.stringify(state.lastMove)}`);
		}
		const pre = qs("#cms-debug-text");
		if (pre) pre.textContent = lines.join("\n");
	}

	function recordMoveDebug(info) {
		if (!state.debug) return;
		state.lastMove = info;
		console.log("[cms-debug] move", info);
		renderDebugOverlay();
	}

	function confirmDeleteBlock({ message, confirmLabel, onConfirm }) {
		const cancel = el(
			"button",
			{
				class: "cms-btn cms-modal__action",
				type: "button",
				"data-close": "true",
			},
			["Cancel"],
		);
		const confirm = el(
			"button",
			{
				class: "cms-btn cms-modal__action cms-btn--danger",
				type: "button",
			},
			[confirmLabel || "Delete"],
		);
		confirm.addEventListener("click", () => {
			closeModal();
			if (typeof onConfirm === "function") onConfirm();
		});
		openModal({
			title: "Delete block",
			bodyNodes: [
				el("p", { class: "cms-modal__text" }, [
					message || "Are you sure you want to delete this block?",
				]),
			],
			footerNodes: [cancel, confirm],
		});
	}

	function buildPenIcon() {
		return el("span", {
			class: "cms-block__icon cms-block__icon--edit",
			html: "&#xe3c9;",
			"aria-hidden": "true",
		});
	}

	function buildTrashIcon() {
		return el("span", {
			class: "cms-block__icon cms-block__icon--delete",
			html: "&#xe872;",
			"aria-hidden": "true",
		});
	}

	// -------------------------
	// Data load
	// -------------------------
	async function refreshCurrentPageFromRepo() {
		const path = state.path || getPagePathFromLocation();
		const res = await fetch(`/api/repo/file?path=${encodeURIComponent(path)}`, {
			headers: { Accept: "application/json" },
		});
		if (!res.ok) return;
		const data = await res.json();
		state.originalHtml = data.text || state.originalHtml;
		bumpUpdatePill();
		let dirtyEntry = state.dirtyPages[path] || {};
		if (dirtyEntry.localBlocks?.length) {
			const cleanedLocal = filterLocalBlocksAgainstBase(
				state.originalHtml,
				dirtyEntry.localBlocks,
			);
			const normalizedLocal = normalizeLocalBlocks(dirtyEntry.localBlocks);
			if (cleanedLocal.length !== normalizedLocal.length) {
				if (!cleanedLocal.length) clearDirtyPage(path);
				else
					setDirtyPage(
						path,
						dirtyEntry.html || state.originalHtml,
						state.originalHtml,
						cleanedLocal,
					);
			}
		}
		dirtyEntry = state.dirtyPages[path] || {};
		const workingHtml = dirtyEntry.html || state.originalHtml;
		const hero = extractRegion(workingHtml, "hero");
		const main = extractRegion(workingHtml, "main");
		const origHero = extractRegion(state.originalHtml, "hero");
		const origMain = extractRegion(state.originalHtml, "main");
		state.loadedHeroInner = origHero.found ? origHero.inner : "";
		state.loadedMainInner = origMain.found ? origMain.inner : "";
		state.heroInner = hero.found ? hero.inner : state.loadedHeroInner;
		state.mainInner = main.found ? main.inner : state.loadedMainInner;
		state.blocks = parseBlocks(state.mainInner);
	}

	async function loadSelectedPage() {
		state.path = getPagePathFromLocation();
		state.prList = loadPrState();
		syncActivePrState();
		if (state.prUrl) startPrPolling();
		else stopPrPolling();

		setUiState("loading", "LOADING / INITIALISING");
		renderPageSurface();

		const url = `/api/repo/file?path=${encodeURIComponent(state.path)}`;
		let res = null;
		try {
			res = await fetch(url, {
				headers: { Accept: "application/json" },
				redirect: "manual",
			});
		} catch (err) {
			if (err?.name === "TypeError") {
				setAccessError(state.path);
				return;
			}
			throw err;
		}
		if (res.type === "opaqueredirect") {
			setAccessError(state.path);
			return;
		}
		const contentType = res.headers.get("content-type") || "";
		if (!contentType.includes("application/json")) {
			setAccessError(state.path);
			return;
		}
		if (!res.ok) throw new Error(`HTTP ${res.status}`);

		const data = await res.json();
		state.originalHtml = data.text || "";
		ensureSessionBaseline(state.path, state.originalHtml);
		state.baselineRegistry[state.path] = buildBaselineRegistry(
			state.originalHtml,
		);
		bumpUpdatePill();

		// Load draft HTML if a dirty version exists for this path.
		const dirtyEntry = state.dirtyPages[state.path] || {};
		let dirtyHtml = dirtyEntry.html || "";
		if (dirtyHtml) {
			const cleanedLocal = getHydratedLocalBlocks(
				state.originalHtml,
				dirtyEntry.localBlocks,
				{ filtered: true, pendingOnly: true },
			);
			const mergedDirty = mergeDirtyWithBase(
				state.originalHtml,
				dirtyHtml,
				cleanedLocal,
				{
					respectRemovals: hasRemovalActions(cleanedLocal),
					path: state.path,
				},
			);
			if (
				normalizeForDirtyCompare(mergedDirty, state.path) ===
				normalizeForDirtyCompare(state.originalHtml, state.path)
			) {
				if (!hasRemovalOrMarkActions(cleanedLocal)) {
					clearDirtyPage(state.path);
					dirtyHtml = "";
				} else {
					setDirtyPage(
						state.path,
						mergedDirty,
						state.originalHtml,
						cleanedLocal,
					);
					dirtyHtml = mergedDirty;
				}
			} else {
				setDirtyPage(state.path, mergedDirty, state.originalHtml, cleanedLocal);
				dirtyHtml = mergedDirty;
			}
		}
		await purgeDirtyPagesFromRepo();
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
		if (state.debug) {
			console.log(
				"[cms-portal] roundtrip main equal?",
				rebuiltMain === originalMain,
			);
		}

		const missing = [];
		if (!hero.found) missing.push("hero markers");
		if (!main.found) missing.push("main markers");

		if (missing.length) {
			setUiState("error", `Missing ${missing.join(" + ")}`);
		} else {
			if (dirtyHtml && !state.currentDirty) clearDirtyPage(state.path);
			purgeCleanDirtyPages();
			if (state.prUrl) setUiState("pr", buildPrLabel());
			else if (dirtyCount()) setUiState("dirty", buildDirtyLabel());
			else setUiState("clean", "CONNECTED - CLEAN");
		}

		await rehydrateAssetUploadsFromCache();
		renderPageSurface();
	}

	async function openDiscardModal() {
		openLoadingModal("Loading changes");
		stashCurrentPageIfDirty();
		await purgeDirtyPagesFromRepo();
		if (!dirtyCount() && state.lastReorderLocal?.length) {
			const baseHtml = state.originalHtml || "";
			const updatedHtml = mergeDirtyWithBase(
				baseHtml,
				baseHtml,
				state.lastReorderLocal,
				{
					respectRemovals: hasRemovalActions(state.lastReorderLocal),
					path: state.path,
				},
			);
			setDirtyPage(state.path, updatedHtml, baseHtml, state.lastReorderLocal);
		}
		purgeCleanDirtyPages();
		if (!dirtyCount()) {
			closeModal();
			return;
		}

		const paths = Object.keys(state.dirtyPages || {});
		const blockData = await buildBlockDataMap(paths);
		const selectedPages = new Set();
		const selectedBlocks = new Map();
		let activeModes = new Set(["all"]);
		let list = null;

		const selectAll = el("input", { type: "checkbox", id: "cms-select-all" });
		const selectAllLabel = el(
			"label",
			{ for: "cms-select-all", class: "cms-modal__label" },
			["Select all pages"],
		);
		const selectAllRow = el(
			"div",
			{ class: "cms-modal__row cms-modal__page" },
			[selectAll, selectAllLabel],
		);
		const divider = el("div", { class: "cms-modal__divider" }, []);
		const note = el("p", { class: "cms-modal__text" }, [
			"Confirm discarding the selected pages from memory.",
		]);

		const confirm = el("input", {
			type: "checkbox",
			id: "cms-confirm-discard",
		});
		const confirmLabel = el(
			"label",
			{ for: "cms-confirm-discard", class: "cms-modal__label" },
			["I understand all selected pages will be deleted"],
		);
		const confirmRow = el("div", { class: "cms-modal__row cms-modal__page" }, [
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
			selectAll.checked =
				totalSelectable > 0 && totalSelected === totalSelectable;
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

		const toggle = buildModalToggleBar(
			(modes) => {
				activeModes = modes;
				rerenderList();
			},
			{ defaultModes: ["all"] },
		);

		selectAll.addEventListener("click", (event) => {
			event.stopPropagation();
			selectedPages.clear();
			selectedBlocks.clear();
			if (selectAll.checked) {
				paths.forEach((path) => {
					const entry = blockData[path];
					const blocks = getBlocksForModes(entry, activeModes);
					const selectable = blocks
						.filter((b) => b.selectable)
						.map((b) => b.id);
					if (!selectable.length) return;
					selectedPages.add(path);
					selectedBlocks.set(path, new Set(selectable));
				});
			}
			rerenderList();
		});

		selectAllRow.addEventListener("click", (event) => {
			if (
				event.target === selectAll ||
				event.target === selectAllLabel ||
				selectAllLabel.contains(event.target)
			)
				return;
			selectAll.click();
		});

		confirm.addEventListener("click", (event) => {
			event.stopPropagation();
			updateAction();
		});
		confirmRow.addEventListener("click", (event) => {
			if (
				event.target === confirm ||
				event.target === confirmLabel ||
				confirmLabel.contains(event.target)
			)
				return;
			confirm.click();
		});
		codeInput.addEventListener("input", updateAction);
		updateAction();

		action.addEventListener("click", () => {
			const pathsToProcess = Array.from(selectedPages);
			if (!pathsToProcess.length) return;
			pathsToProcess.forEach((path) => {
				const entry = blockData[path];
				const selectedIds = selectedBlocks.get(path) || new Set();
				const heroInfo = entry.hero || null;
				const heroSelected =
					heroInfo && selectedIds ? selectedIds.has(heroInfo.id) : false;
				const localIdsToDrop = new Set();
				(entry.all || []).forEach((block) => {
					if (!selectedIds.has(block.id)) return;
					if (block.localId) localIdsToDrop.add(block.localId);
				});
				const currentLocal = normalizeLocalBlocks(
					state.dirtyPages[path]?.localBlocks || [],
				);
				const localById = new Map(currentLocal.map((item) => [item.id, item]));
				const baseIdsToDrop = new Set();
				localIdsToDrop.forEach((id) => {
					const item = localById.get(id);
					if (!item) return;
					if (item.action === "insert" && item.kind === "edited") {
						const baseId = item.baseId || item.anchor?.id || "";
						if (baseId) baseIdsToDrop.add(baseId);
					}
				});
				const remainingLocal = currentLocal.filter((item) => {
					if (localIdsToDrop.has(item.id)) return false;
					if (item.action === "remove" || item.action === "mark") {
						const baseId = item.baseId || item.anchor?.id || "";
						if (baseId && baseIdsToDrop.has(baseId)) return false;
					}
					return true;
				});
				const baseHtml = entry.baseHtml || entry.dirtyHtml || "";
				const keepHero = heroInfo && !heroSelected;
				const dropHero = heroInfo && heroSelected;
				if (!remainingLocal.length) {
					if (keepHero) {
						const updatedHtml = applyHeroRegion(
							baseHtml,
							heroInfo.dirtyInner,
						);
						setDirtyPage(path, updatedHtml, entry.baseHtml, []);
						if (path === state.path) {
							state.lastReorderLocal = null;
							applyHtmlToCurrentPage(updatedHtml);
							renderPageSurface();
						}
						return;
					}
					clearDirtyPage(path);
					if (path === state.path) {
						state.lastReorderLocal = null;
						applyHtmlToCurrentPage(baseHtml || state.originalHtml || "");
						renderPageSurface();
					}
					return;
				}
				let updatedHtml = mergeDirtyWithBase(
					baseHtml,
					baseHtml,
					remainingLocal,
					{
						respectRemovals: hasRemovalActions(remainingLocal),
						path,
					},
				);
				if (heroInfo) {
					updatedHtml = applyHeroRegion(
						updatedHtml,
						dropHero ? heroInfo.baseInner : heroInfo.dirtyInner,
					);
				}
				const remappedLocal = assignAnchorsFromHtml(
					baseHtml,
					updatedHtml,
					remainingLocal,
				);
				const baseForCompare = entry.baseHtml || "";
				const matchesBase =
					normalizeForDirtyCompare(updatedHtml, path) ===
					normalizeForDirtyCompare(baseForCompare, path);
				if (!updatedHtml || matchesBase) clearDirtyPage(path);
				else setDirtyPage(path, updatedHtml, entry.baseHtml, remappedLocal);
				if (path === state.path) {
					applyHtmlToCurrentPage(updatedHtml);
					renderPageSurface();
				}
			});
			purgeCleanDirtyPages();
			closeModal();
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
			sessionStorage.removeItem(SESSION_STORAGE_KEY);
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
			sessionStorage.removeItem(SESSION_STORAGE_KEY);
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
		// Guard against multiple active PRs for this session.
		if (state.prList?.length) {
			const note = el("p", { class: "cms-modal__text" }, [
				"If the PR was merged or closed and the status didn't update, you can clear PR state without losing edits.",
			]);
			const clearBtn = el(
				"button",
				{
					class: "cms-btn cms-modal__action cms-btn--move",
					type: "button",
				},
				["Clear PR State (keep edits)"],
			);
			clearBtn.addEventListener("click", () => {
				state.prList = [];
				savePrState();
				syncActivePrState();
				resetPendingBlocksIfNoPr();
				stopPrPolling();
				refreshUiStateForDirty();
				renderPageSurface();
				closeModal();
			});
			openModal({
				title: "PR already open",
				bodyNodes: [
					el("p", {}, [
						"A pull request is already open for this session. Merge or close it before creating another.",
					]),
					note,
				],
				footerNodes: [
					el(
						"a",
						{
							class: "cms-btn cms-modal__action",
							href: state.prUrl || "#",
							target: "_blank",
							rel: "noopener noreferrer",
						},
						["View PR"],
					),
					clearBtn,
				],
			});
			return;
		}
		openLoadingModal("Loading changes");
		stashCurrentPageIfDirty();
		await purgeDirtyPagesFromRepo();
		purgeCleanDirtyPages();
		let dirtyPaths = Object.keys(state.dirtyPages || {});
		if (!dirtyPaths.length && state.lastReorderLocal?.length) {
			const baseHtml = state.originalHtml || "";
			const updatedHtml = mergeDirtyWithBase(
				baseHtml,
				baseHtml,
				state.lastReorderLocal,
				{
					respectRemovals: hasRemovalActions(state.lastReorderLocal),
					path: state.path,
				},
			);
			setDirtyPage(state.path, updatedHtml, baseHtml, state.lastReorderLocal);
			dirtyPaths = Object.keys(state.dirtyPages || {});
		}
		if (!dirtyPaths.length) {
			closeModal();
			return;
		}

		const blockData = await buildBlockDataMap(dirtyPaths);
		const selectedPages = new Set();
		const selectedBlocks = new Map();
		let activeModes = new Set(["all"]);
		let list = null;

		const selectAll = el("input", {
			type: "checkbox",
			id: "cms-select-all-pr",
		});
		const selectAllLabel = el(
			"label",
			{ for: "cms-select-all-pr", class: "cms-modal__label" },
			["Select all pages"],
		);
		const selectAllRow = el(
			"div",
			{ class: "cms-modal__row cms-modal__page" },
			[selectAll, selectAllLabel],
		);

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
		const keepNote = el(
			"div",
			{ class: "cms-modal__note cms-modal__note--subtle" },
			["Unchecked blocks remain staged in memory."],
		);

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
		const confirmRow = el("div", { class: "cms-modal__row cms-modal__page" }, [
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
			selectAll.checked =
				totalSelectable > 0 && totalSelected === totalSelectable;
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

		const toggle = buildModalToggleBar(
			(modes) => {
				activeModes = modes;
				rerenderList();
			},
			{ defaultModes: ["all"] },
		);

		selectAll.addEventListener("click", (event) => {
			event.stopPropagation();
			selectedPages.clear();
			selectedBlocks.clear();
			if (selectAll.checked) {
				dirtyPaths.forEach((path) => {
					const entry = blockData[path];
					const blocks = getBlocksForModes(entry, activeModes);
					const selectable = blocks
						.filter((b) => b.selectable)
						.map((b) => b.id);
					if (!selectable.length) return;
					selectedPages.add(path);
					selectedBlocks.set(path, new Set(selectable));
				});
			}
			rerenderList();
		});

		selectAllRow.addEventListener("click", (event) => {
			if (
				event.target === selectAll ||
				event.target === selectAllLabel ||
				selectAllLabel.contains(event.target)
			)
				return;
			selectAll.click();
		});

		confirm.addEventListener("click", (event) => {
			event.stopPropagation();
			updateAction();
		});
		confirmRow.addEventListener("click", (event) => {
			if (
				event.target === confirm ||
				event.target === confirmLabel ||
				confirmLabel.contains(event.target)
			)
				return;
			confirm.click();
		});
		codeInput.addEventListener("input", updateAction);
		updateAction();

		action.addEventListener("click", async () => {
			const pathsToProcess = Array.from(selectedPages);
			const commitSelections = [];
			if (!pathsToProcess.length) return;
			const payloads = [];
			const postPrUpdates = [];
			pathsToProcess.forEach((path) => {
				const entry = blockData[path];
				const selectedIds = selectedBlocks.get(path) || new Set();
				const heroInfo = entry.hero || null;
				const heroSelected =
					heroInfo && selectedIds ? selectedIds.has(heroInfo.id) : false;
				commitSelections.push({ path, entry, selectedIds });
				const commitHtml = buildHtmlForSelection(entry, selectedIds, "commit");
				const localById = new Map(
					normalizeLocalBlocks(state.dirtyPages[path]?.localBlocks || []).map(
						(item) => [item.id, item],
					),
				);
				const remainingLocal = [];
				const seen = new Set();
				const pushLocal = (item) => {
					const key = `${item.id || ""}::${item.status}::${item.html}`;
					if (seen.has(key)) return;
					seen.add(key);
					remainingLocal.push(item);
				};

				(entry.all || []).forEach((block) => {
					const localItem = block.localId ? localById.get(block.localId) : null;
					if (!localItem) return;
					const nextStatus = selectedIds.has(block.id) ? "pending" : "staged";
					pushLocal({
						...localItem,
						status: nextStatus,
						prNumber:
							nextStatus === "pending" ? null : localItem.prNumber || null,
					});
				});
				const remainingBase = entry.baseHtml || entry.dirtyHtml || "";
				let remainingHtml = mergeDirtyWithBase(
					remainingBase,
					remainingBase,
					remainingLocal,
					{
						respectRemovals: hasRemovalActions(remainingLocal),
						path,
					},
				);
				if (heroInfo) {
					remainingHtml = applyHeroRegion(
						remainingHtml,
						heroSelected ? heroInfo.baseInner : heroInfo.dirtyInner,
					);
				}
				const remappedLocal = assignAnchorsFromHtml(
					remainingBase,
					remainingHtml,
					remainingLocal,
				);
				if (commitHtml) {
					payloads.push({ path, text: commitHtml });
				}
				const baseForCompare = entry.baseHtml || remainingBase;
				const matchesBase =
					normalizeForDirtyCompare(remainingHtml, path) ===
					normalizeForDirtyCompare(baseForCompare, path);
				if (!remainingHtml || matchesBase) clearDirtyPage(path);
				else {
					setDirtyPage(path, remainingHtml, entry.baseHtml, remappedLocal);
					postPrUpdates.push({
						path,
						entry,
						selectedIds,
						remainingLocal: remappedLocal,
					});
				}
				if (path === state.path) {
					applyHtmlToCurrentPage(remainingHtml);
					renderPageSurface();
				}
			});

			closeModal();

			if (!payloads.length) return;
			const pr = await submitPr(
				payloads.map((p) => p.path),
				noteInput.value,
				payloads,
			);
			if (!pr?.number) return;
			commitSelections.forEach(({ path, entry, selectedIds }) => {
				const selectedBlocks = (entry.all || [])
					.filter(
						(block) => selectedIds.has(block.id) && block.kind !== "hero",
					)
					.map((block) => ({
						html: block.html,
						pos: block.idx,
						baseId: block.baseId || null,
					}));
				addSessionCommitted(pr.number, path, selectedBlocks);
			});
			postPrUpdates.forEach(({ path, entry, remainingLocal }) => {
				const updated = remainingLocal.map((item) => {
					if (item.status === "pending" && !item.prNumber) {
						return { ...item, prNumber: pr.number };
					}
					return item;
				});
				setDirtyPage(
					path,
					state.dirtyPages[path]?.html || "",
					entry.baseHtml || state.originalHtml,
					updated,
				);
			});
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
				keepNote,
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
		qs("#cms-debug-pill")?.addEventListener("click", () => {
			setDebugEnabled(!state.debug);
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
			else if (state.uiState === "error") link.classList.add("cms-nav-pr--err");
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
		bumpUpdatePill();
		renderDebugOverlay();
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
