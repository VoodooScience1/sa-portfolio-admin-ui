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
	const PR_STORAGE_KEY = "cms-pr-state";
	const SESSION_STORAGE_KEY = "cms-session-state";
	const DEBUG_ENABLED_DEFAULT = true;
	const UPDATE_VERSION = 28;

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
			id: "accordion",
			label: "Accordion (simple)",
			partial: "/admin-assets/partials/CloudFlareCMS/std-accordion.html",
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
			id: "doc-card",
			label: "Document card",
			partial: "/admin-assets/partials/CloudFlareCMS/doc-card.html",
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

	function buildSummaryForHtml(html) {
		const main = extractRegion(html, "main");
		if (!main.found) return [];
		return parseBlocks(main.inner).map((b) => b.summary || b.type || "Block");
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

		const parts = [];
		wrap.childNodes.forEach((node) => {
			if (node.nodeType === Node.ELEMENT_NODE) {
				const clone = node.cloneNode(true);
				stripCmsIds(clone);
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
		return String(text || "")
			.split("\n")
			.map((line) => (line ? `${pad}${line}` : line))
			.join("\n");
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

	const PRETTIER_URLS = [
		"https://unpkg.com/prettier@3.2.5/standalone.js",
		"https://unpkg.com/prettier@3.2.5/plugins/babel.js",
		"https://unpkg.com/prettier@3.2.5/plugins/html.js",
		"https://unpkg.com/prettier@3.2.5/plugins/postcss.js",
		"https://unpkg.com/prettier@3.2.5/plugins/markdown.js",
		"https://unpkg.com/prettier@3.2.5/plugins/yaml.js",
	];
	const RUFF_FMT_URL =
		"https://unpkg.com/@wasm-fmt/ruff_fmt@0.14.10/ruff_fmt.js";

	function loadExternalScript(src) {
		return new Promise((resolve, reject) => {
			const s = document.createElement("script");
			s.src = src;
			s.async = true;
			s.onload = () => resolve();
			s.onerror = () => reject(new Error(`Failed to load: ${src}`));
			document.head.appendChild(s);
		});
	}

	async function loadPrettier() {
		if (window.prettier && window.prettierPlugins) return;
		for (const src of PRETTIER_URLS) {
			// eslint-disable-next-line no-await-in-loop
			await loadExternalScript(src);
		}
	}

	async function loadPythonFormatter() {
		if (window.__RuffFmtReady) return window.__RuffFmtReady;
		window.__RuffFmtReady = (async () => {
			const mod = await import(RUFF_FMT_URL);
			await mod.default();
			window.__RuffFmt = mod;
			return mod;
		})().catch((err) => {
			console.error(err);
			window.__RuffFmtReady = null;
			return null;
		});
		return window.__RuffFmtReady;
	}

	async function formatPythonCode(code) {
		const mod = await loadPythonFormatter();
		if (!mod || typeof mod.format !== "function") return null;
		return mod.format(code, null, {
			indent_style: "space",
			indent_width: 4,
			line_width: 88,
			line_ending: "lf",
		});
	}

	function getParserForLang(lang) {
		const raw = String(lang || "").trim().toLowerCase();
		if (!raw || raw === "auto") return null;
		if (raw === "js" || raw === "javascript") return "babel";
		if (raw === "json") return "json";
		if (raw === "html") return "html";
		if (raw === "css") return "css";
		if (raw === "md" || raw === "markdown") return "markdown";
		if (raw === "yml" || raw === "yaml") return "yaml";
		if (raw === "py" || raw === "python") return null;
		return null;
	}

	function guessLanguageFromText(text) {
		const raw = String(text || "").trim();
		if (!raw) return "auto";
		if (raw.startsWith("<") || /<\/[a-z]/i.test(raw)) return "html";
		if (/^\s*[{[]/.test(raw) && /":\s*/.test(raw)) return "json";
		if (/(^|\n)\s*#/.test(raw) || /```/.test(raw)) return "markdown";
		if (/(^|\n)\s*[A-Za-z0-9_-]+\s*:\s*[^{}]/.test(raw)) return "yaml";
		if (/(^|\n)\s*(def|class|import|from)\s+/.test(raw)) return "python";
		if (/(^|\n)\s*(const|let|var|function)\s+/.test(raw) || /=>/.test(raw))
			return "javascript";
		if (/[.#][A-Za-z0-9_-]+\s*\{/.test(raw) || /:\s*[^;]+;/.test(raw))
			return "css";
		return "auto";
	}

	function getLangFromCodeEl(codeEl) {
		if (!codeEl) return "";
		const cls = codeEl.getAttribute("class") || "";
		const match = cls.match(/language-([a-z0-9_-]+)/i);
		return match ? match[1] : codeEl.getAttribute("data-lang") || "";
	}

	async function formatCodeBlocksInEditor(editor) {
		if (!editor) return;
		const blocks = Array.from(editor.querySelectorAll("pre > code"));
		if (!blocks.length) return;
		const needsPython = blocks.some((codeEl) => {
			const lang = getLangFromCodeEl(codeEl) || guessLanguageFromText(codeEl.textContent);
			return lang === "py" || lang === "python";
		});
		const needsPrettier = blocks.some((codeEl) => {
			const lang = getLangFromCodeEl(codeEl) || guessLanguageFromText(codeEl.textContent);
			return Boolean(getParserForLang(lang));
		});
		if (needsPrettier) {
			await loadPrettier().catch((err) => console.error(err));
		}
		if (needsPython) {
			await loadPythonFormatter();
		}
		const prettier = window.prettier;
		const plugins = window.prettierPlugins
			? Object.values(window.prettierPlugins)
			: [];
		for (const codeEl of blocks) {
			let lang = getLangFromCodeEl(codeEl);
			if (!lang || lang === "auto") {
				lang = guessLanguageFromText(codeEl.textContent);
				if (lang && lang !== "auto") {
					codeEl.className = `language-${lang}`;
					codeEl.setAttribute("data-lang", lang);
				}
			}
			if (lang === "py" || lang === "python") {
				try {
					const formatted = await formatPythonCode(codeEl.textContent || "");
					if (typeof formatted === "string") {
						codeEl.textContent = formatted.replace(/\s+$/, "");
					}
				} catch (err) {
					console.error(err);
				}
				continue;
			}
			const parser = getParserForLang(lang);
			if (!parser || !prettier || !plugins.length) continue;
			try {
				const maybeFormatted = prettier.format(codeEl.textContent || "", {
					parser,
					plugins,
				});
				const formatted =
					maybeFormatted && typeof maybeFormatted.then === "function"
						? await maybeFormatted
						: maybeFormatted;
				if (typeof formatted === "string") {
					codeEl.textContent = formatted.replace(/\s+$/, "");
				}
			} catch (err) {
				console.error(err);
			}
		}
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
			overlayText = normalizeBool(attrs.lightbox, "false") === "true" ? "Click to view" : "";
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
		];
		return `<div${serializeAttrsOrdered(ordered, order)}></div>`;
	}

	function sanitizeHref(href) {
		const raw = String(href || "").trim();
		if (!raw) return "";
		if (raw.startsWith("/")) return raw;
		if (raw.startsWith("https://")) return raw;
		return "";
	}

	function sanitizeRteHtml(html, ctx = {}) {
		const doc = new DOMParser().parseFromString(
			`<div id="__wrap__">${String(html || "")}</div>`,
			"text/html",
		);
		const wrap = doc.querySelector("#__wrap__");
		if (!wrap) return "";

		const accState = ctx._accordionState || { index: 0 }; // 0-based item index per ADR-015
		const pageHash = ctx.pageHash || hashText(ctx.path || "");
		const blockShort = ctx.blockIdShort || hashText(ctx.blockId || "block");

		const serializeChildren = (node) =>
			Array.from(node.childNodes)
				.map((child) => sanitizeNode(child))
				.filter(Boolean)
				.join("");

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
			const lines = [
				`<div class="doc-card">`,
				`\t<a class="doc-card__link" href="${escapeAttr(
					href,
				)}" target="${target}" rel="${rel}">`,
				`\t\t<div class="doc-card__meta">`,
				`\t\t\t<div class="doc-card__title">${escapeHtml(title)}</div>`,
			];
			if (desc) {
				lines.push(
					`\t\t\t<div class="doc-card__desc">${escapeHtml(desc)}</div>`,
				);
			}
			lines.push("\t\t</div>", "\t</a>", "</div>");
			return lines.join("\n");
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
					return escapeHtml(cleaned);
				}
				return escapeHtml(text);
			}
			if (node.nodeType !== Node.ELEMENT_NODE) return "";

			const tag = node.tagName.toLowerCase();
			const cls = node.getAttribute("class") || "";

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
					});
				}
				if (cls.includes("tab")) return serializeAccordion(node);
				if (cls.includes("doc-card")) return serializeDocCard(node);
				if (cls.includes("img-text-div-img"))
					return serializeStandardImage(node);
				if (cls && cls.trim()) {
					// Disallow arbitrary classes from free typing.
					return serializeChildren(node);
				}
				const inner = serializeChildren(node);
				return `<div>${inner}</div>`;
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
			return `<table>${inner}</table>`;
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
			if (codeChild) {
				return `<pre>${sanitizeNode(codeChild)}</pre>`;
			}
			const text = escapeHtml(node.textContent || "");
			return `<pre><code>${text}</code></pre>`;
		}

		if (tag === "ul" || tag === "ol") {
			const inner = serializeChildren(node);
			return `<${tag}>${inner}</${tag}>`;
		}

		if (tag === "li") {
			const inner = serializeChildren(node);
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
		const title = hero.querySelector("h1")?.textContent?.trim() || "";
		const subtitle = hero.querySelector("p")?.textContent?.trim() || "";
		return { type: "hero", title, subtitle };
	}

	function serializeHeroInner(model) {
		if (!model || model.type !== "hero") {
			return String(model?.raw || "").trim();
		}
		const title = escapeHtml(model.title || "");
		const subtitle = escapeHtml(model.subtitle || "");
		return [
			`<div class="div-wrapper">`,
			`\t<div class="default-div-wrapper hero-override">`,
			`\t\t<h1 style="text-align: center">${title}</h1>`,
			`\t\t<p style="text-align: center">${subtitle}</p>`,
			`\t</div>`,
			`</div>`,
		].join("\n");
	}

	function parseMainBlockNode(node) {
		if (!node || !node.classList) {
			return { type: "legacy", raw: String(node?.outerHTML || "") };
		}
		const cls = node.classList;
		const cmsId = node.getAttribute("data-cms-id") || "";
		if (cls.contains("section")) {
			const type = (node.getAttribute("data-type") || "").trim();
			if (type === "twoCol") {
				const leftNode = node.querySelector("[data-col='left']");
				const rightNode = node.querySelector("[data-col='right']");
				const headingEl = leftNode?.querySelector("h2,h3");
				const headingTag = headingEl
					? headingEl.tagName.toLowerCase()
					: "h2";
				const safeHeadingTag = headingTag === "h1" ? "h2" : headingTag;
				let leftHtml = leftNode?.innerHTML || "";
				if (headingEl && leftNode) {
					const clone = leftNode.cloneNode(true);
					const removeHeading = clone.querySelector("h2,h3");
					if (removeHeading) removeHeading.remove();
					leftHtml = clone.innerHTML || "";
				}
				return {
					type: "twoCol",
					cmsId,
					heading: headingEl?.textContent?.trim() || "",
					headingTag: safeHeadingTag,
					left: leftHtml,
					right: rightNode?.innerHTML || "",
				};
			}
			if (type === "imgText" || type === "split50") {
				const headingEl = node.querySelector("h1,h2,h3");
				const headingTag = headingEl
					? headingEl.tagName.toLowerCase()
					: "h2";
				const safeHeadingTag = headingTag === "h1" ? "h2" : headingTag;
				const overlayEnabled = node.getAttribute("data-overlay") !== "false";
				let body = node.innerHTML || "";
				if (headingEl) {
					const clone = node.cloneNode(true);
					const removeHeading = clone.querySelector("h1,h2,h3");
					if (removeHeading) removeHeading.remove();
					body = clone.innerHTML || "";
				}
				return {
					type,
					cmsId,
					imgPos: node.getAttribute("data-img-pos") || "left",
					img: node.getAttribute("data-img") || "",
					caption: node.getAttribute("data-caption") || "",
					lightbox: node.getAttribute("data-lightbox") || "false",
					overlayEnabled,
					overlayTitle: node.getAttribute("data-overlay-title") || "",
					overlayText: node.getAttribute("data-overlay-text") || "",
					heading: headingEl?.textContent?.trim() || "",
					headingTag: safeHeadingTag,
					body,
				};
			}
			return { type: "legacy", cmsId, raw: node.outerHTML };
		}

		if (cls.contains("grid-wrapper") && cls.contains("grid-wrapper--row")) {
			if (node.querySelector(".content.box.box-img")) {
				const cards = Array.from(
					node.querySelectorAll(".content.box.box-img"),
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
			if (node.querySelector(".box > img")) {
				const items = Array.from(node.querySelectorAll(".box > img")).map(
					(img) => ({
						src: img.getAttribute("src") || "",
						alt: img.getAttribute("alt") || "",
						lightbox: img.classList.contains("js-lightbox") || false,
					}),
				);
				return { type: "squareGridRow", cmsId, items };
			}
		}

		return { type: "legacy", cmsId, raw: node.outerHTML };
	}

	function parseMainBlocksFromHtml(mainHtml) {
		const doc = new DOMParser().parseFromString(
			`<div id="__wrap__">${String(mainHtml || "")}</div>`,
			"text/html",
		);
		const wrap = doc.querySelector("#__wrap__");
		const nodes = wrap ? Array.from(wrap.children) : [];
		const occMap = new Map();
		return nodes.map((node, idx) => {
			const parsed = parseMainBlockNode(node);
			if (parsed.cmsId) return parsed;
			const sig = signatureForHtml(node?.outerHTML || "");
			const occ = sig ? occMap.get(sig) || 0 : 0;
			if (sig) occMap.set(sig, occ + 1);
			return {
				...parsed,
				cmsId: makeCmsIdFromSig(sig, occ, node?.outerHTML || String(idx)),
			};
		});
	}

	function getBlockCmsId(block, idx, ctx) {
		if (block?.cmsId) return block.cmsId;
		if (block?.baseId) return block.baseId;
		if (block?.id) return block.id;
		const sig =
			ctx?.sig || signatureForHtml(block?.raw || block?.html || "");
		const occ =
			Number.isInteger(ctx?.occ) ? ctx.occ : Number.isInteger(block?.occ) ? block.occ : idx;
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
		if (block.imgPos && block.imgPos !== "left") {
			attrs["data-img-pos"] = block.imgPos;
		}
		if (block.img) attrs["data-img"] = block.img;
		if (block.caption) attrs["data-caption"] = block.caption;
		attrs["data-lightbox"] = normalizeBool(block.lightbox, "false");
		if (block.overlayEnabled === false) attrs["data-overlay"] = "false";
		if (block.overlayTitle) attrs["data-overlay-title"] = block.overlayTitle;
		let overlayText = block.overlayText || "";
		if (!block.overlayTitle && !overlayText && block.overlayEnabled !== false) {
			overlayText = normalizeBool(block.lightbox, "false") === "true" ? "Click to view" : "";
		}
		if (overlayText) attrs["data-overlay-text"] = overlayText;
		const order = [
			"class",
			"data-cms-id",
			"data-type",
			"data-img-pos",
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
			? `<${headingTag}>${escapeHtml(headingText)}</${headingTag}>`
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
		const headingText = (block.heading || "").trim();
		const headingTag = (block.headingTag || "h2").toLowerCase();
		const headingHtml = headingText
			? `<${headingTag}>${escapeHtml(headingText)}</${headingTag}>`
			: "";
		const left = sanitizeRteHtml(block.left || "", ctx);
		const right = sanitizeRteHtml(block.right || "", ctx);
		const lines = [
			`<div class="section" data-cms-id="${escapeAttr(
				cmsId,
			)}" data-type="twoCol">`,
			`\t<div data-col="left">`,
			headingHtml ? `\t\t${headingHtml}` : "",
			left ? indentLines(left, 2) : "",
			`\t</div>`,
			`\t<div data-col="right">`,
			right ? indentLines(right, 2) : "",
			`\t</div>`,
			`</div>`,
		].filter((line) => line !== "");
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

	function serializeMainBlocks(blocks, ctx) {
		const list = blocks || [];
		const occMap = new Map();
		return list
			.map((block, idx) => {
				const sig =
					signatureForHtml(block?.raw || block?.html || "") ||
					hashText(JSON.stringify(block || {}));
				const occ = sig ? occMap.get(sig) || 0 : 0;
				if (sig) occMap.set(sig, occ + 1);
				const blockCtx = {
					...ctx,
					index: idx,
					sig,
					occ,
					blockId: block.baseId || block.id || `block-${idx}`,
					blockIdShort: hashText(
						`${block.baseId || block.id || "block"}::${idx}`,
					).slice(0, 4),
				};
				if (block.type === "twoCol") return serializeTwoCol(block, blockCtx);
				if (block.type === "imgText" || block.type === "split50")
					return serializeSectionStub(block, blockCtx);
				if (block.type === "hoverCardRow")
					return serializeHoverCardRow(block, blockCtx);
				if (block.type === "squareGridRow")
					return serializeSquareGridRow(block, blockCtx);
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
							if (!node.getAttribute("data-cms-id")) {
								node.setAttribute(
									"data-cms-id",
									getBlockCmsId(block, idx, blockCtx),
								);
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
					closeModal();
				},
				{ once: true },
			);
		});
	}

	function closeModal() {
		const root = qs("#cms-modal");
		if (!root) return;
		root.classList.remove("is-open");
		document.documentElement.classList.remove("cms-lock");
		document.body.classList.remove("cms-lock");
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

	function buildBaseBlocksWithOcc(baseHtml) {
		const main = extractRegion(baseHtml || "", "main");
		const blocks = main.found ? parseBlocks(main.inner) : [];
		const occMap = new Map();
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
				baseId = node?.getAttribute("data-cms-id") || "";
				if (!baseId && sig) baseId = makeCmsIdFromSig(sig, occ, block.html);
				if (node && baseId && !node.getAttribute("data-cms-id")) {
					node.setAttribute("data-cms-id", baseId);
					updatedHtml = node.outerHTML;
				}
			} catch {
				baseId = "";
			}
			if (!baseId) {
				baseId = sig
					? makeCmsIdFromSig(sig, occ, block.html)
					: makeCmsIdFromSig(String(idx), occ, block.html);
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
					return {
						id: item.id || makeLocalId(),
						html: String(item.html || ""),
						pos: Number.isInteger(item.pos) ? item.pos : null,
						anchor: item.anchor || null,
						placement: item.placement === "before" ? "before" : "after",
						status: item.status === "pending" ? "pending" : "staged",
						prNumber: item.prNumber || null,
						kind: item.kind === "edited" ? "edited" : "new",
						baseId: item.baseId || null,
						sourceKey: item.sourceKey || null,
						order: Array.isArray(item.order) ? item.order.slice() : null,
						action:
							item.action === "remove"
								? "remove"
								: item.action === "mark"
									? "mark"
									: item.action === "reorder"
										? "reorder"
										: "insert",
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
			let anchor = item.anchor;
			if (anchor?.sig && !anchor.id) {
				const id = idBySigOcc.get(`${anchor.sig}::${anchor.occ ?? 0}`);
				if (id) anchor = { ...anchor, id };
			}
			let baseId = item.baseId;
			if (!baseId && anchor?.id) baseId = anchor.id;
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
		let anchor = null;
		let placement = "after";
		for (let i = targetIndex - 1; i >= 0; i -= 1) {
			const block = mergedRender[i];
			if (block?._base && block.sig) {
				anchor = { id: block.id, sig: block.sig, occ: block.occ };
				placement = "after";
				return { anchor, placement };
			}
		}
		for (let i = targetIndex; i < mergedRender.length; i += 1) {
			const block = mergedRender[i];
			if (block?._base && block.sig) {
				anchor = { id: block.id, sig: block.sig, occ: block.occ };
				placement = "before";
				return { anchor, placement };
			}
		}
		return { anchor: null, placement: "after" };
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

	function stripBaseMoveEntries(localBlocks, baseKey, baseHtml) {
		const baseSig = normalizeFragmentHtml(baseHtml || "");
		return normalizeLocalBlocks(localBlocks).filter((item) => {
			if (item.baseId && `id:${item.baseId}` === baseKey) return false;
			if (item.action === "remove" && anchorKey(item.anchor) === baseKey)
				return false;
			if (
				item.action === "insert" &&
				item.kind === "edited" &&
				(item.sourceKey === baseKey ||
					(!item.sourceKey &&
						normalizeFragmentHtml(item.html || "") === baseSig))
			)
				return false;
			return true;
		});
	}

	function stripAllBaseMoveEntries(localBlocks, baseKeys, baseHtmlByKey) {
		const baseKeySet = new Set(baseKeys || []);
		const baseHtmlMap = baseHtmlByKey || new Map();
		return normalizeLocalBlocks(localBlocks).filter((item) => {
			const key = anchorKey(item.anchor);
			if (item.baseId && baseKeySet.has(`id:${item.baseId}`)) return false;
			if (item.action === "remove" && baseKeySet.has(key)) return false;
			if (
				item.action === "insert" &&
				item.kind === "edited" &&
				(item.sourceKey ? baseKeySet.has(item.sourceKey) : baseKeySet.has(key))
			)
				return false;
			if (
				item.action === "insert" &&
				item.kind === "edited" &&
				baseKeySet.size
			) {
				const sig = normalizeFragmentHtml(item.html || "");
				for (const baseKey of baseKeySet) {
					const baseSig = baseHtmlMap.get(baseKey);
					if (baseSig && baseSig === sig) return false;
				}
			}
			return true;
		});
	}

	function updateLocalBlocksAndRender(path, updatedLocal) {
		const baseHtml = state.originalHtml || "";
		const updatedHtml = mergeDirtyWithBase(baseHtml, baseHtml, updatedLocal, {
			respectRemovals: hasRemovalActions(updatedLocal),
			path,
		});
		const normalizedLocal = normalizeLocalBlocks(updatedLocal);
		const hasLocal = normalizedLocal.length > 0;
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
		if (!updatedHtml || (!hasLocal && updatedHtml.trim() === baseHtml.trim())) {
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
				? mergeDirtyWithBase(baseHtml || "", baseHtml || "", normalizedLocal, {
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

		const baseBlocks = parseBlocks(main.inner);
		const baseByPos = baseBlocks.map((b) => (b.html || "").trim());
		const localsWithPos = items
			.filter((item) => Number.isInteger(item.pos))
			.map((item) => item.pos)
			.sort((a, b) => a - b);

		return items.filter((item) => {
			if (
				item.action === "mark" ||
				item.action === "remove" ||
				item.action === "reorder"
			)
				return true;
			const html = (item.html || "").trim();
			if (!html) return false;
			if (Number.isInteger(item.pos)) {
				const beforeCount = localsWithPos.filter(
					(pos) => pos < item.pos,
				).length;
				const baseIndex = item.pos - beforeCount;
				const baseAt = baseByPos[baseIndex] || "";
				// Drop any local block that now exactly matches the repo at its mapped position.
				return baseAt.trim() !== html;
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
		const mergedMain = mergedBlocks.map((b) => b.html).join("\n\n");

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

					all.push(...added, ...modified, ...removed);

					blockMap[path] = {
						path,
						baseHtml,
						dirtyHtml: mergedForList,
						localBlocks,
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
			if (normalizeLocalBlocks(entry.localBlocks || []).length) return;
			if (
				entry.baseHash &&
				entry.dirtyHash &&
				entry.baseHash === entry.dirtyHash
			)
				clearDirtyPage(path);
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
						!normalizeLocalBlocks(entry.localBlocks || []).length
					) {
						if (remoteText && entryText && remoteText !== entryText) {
							clearDirtyPage(path);
							return;
						}
					}
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
		const localBlocks = normalizeLocalBlocks(entry?.localBlocks || []);
		if (!selectedIds || !selectedIds.size) {
			const result =
				action === "discard"
					? baseHtml
					: mergeDirtyWithBase(baseHtml, baseHtml, [], {
							respectRemovals: true,
							path: entry?.path || state.path,
						});
			return canonicalizeFullHtml(result, entry?.path || state.path);
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
			return canonicalizeFullHtml(result, entry?.path || state.path);
		}
		const remainingLocal = localBlocks.filter(
			(item) => !selectedLocalIds.has(item.id),
		);
		const result = mergeDirtyWithBase(baseHtml, baseHtml, remainingLocal, {
			respectRemovals: hasRemovalActions(remainingLocal),
			path: entry?.path || state.path,
		});
		return canonicalizeFullHtml(result, entry?.path || state.path);
	}

	// Remove only the selected blocks from the current dirty HTML (keep everything else).
	function buildDirtyAfterSelection(entry, selectedIds) {
		const baseHtml = entry?.baseHtml || entry?.dirtyHtml || "";
		if (!baseHtml) return "";
		if (!selectedIds || !selectedIds.size)
			return canonicalizeFullHtml(entry?.dirtyHtml || baseHtml, entry?.path);
		const localBlocks = normalizeLocalBlocks(entry?.localBlocks || []);
		const selectedLocalIds = getSelectedLocalIds(entry, selectedIds);
		const remainingLocal = localBlocks.filter(
			(item) => !selectedLocalIds.has(item.id),
		);
		const result = mergeDirtyWithBase(baseHtml, baseHtml, remainingLocal, {
			respectRemovals: hasRemovalActions(remainingLocal),
			path: entry?.path || state.path,
		});
		return canonicalizeFullHtml(result, entry?.path || state.path);
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
		const wrap = el("div", { class: "cms-modal__list" }, []);
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
		if (!dirtyCount()) state.assetUploads = [];
		refreshUiStateForDirty();
	}

	function addAssetUpload({ name, content, path }) {
		if (!name || !content) return;
		const clean = String(path || "").trim() || `assets/img/${name}`;
		state.assetUploads = (state.assetUploads || []).filter(
			(item) => item.path !== clean,
		);
		state.assetUploads.push({
			path: clean,
			content,
			encoding: "base64",
		});
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
			state.assetUploads = [];

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

	async function insertTestBlockAt(index, anchorOverride) {
		const html = await buildTestContainerHtml();
		return insertHtmlAt(index, anchorOverride, html);
	}

	async function insertBlockFromPartial(index, anchorOverride, partialPath) {
		const html = await loadPartialHtml(partialPath);
		return insertHtmlAt(index, anchorOverride, html);
	}

	async function insertHtmlAt(index, anchorOverride, html) {
		const localEntry = state.dirtyPages[state.path] || {};
		const localBlocks = normalizeLocalBlocks(localEntry.localBlocks || []);
		let anchor = null;
		let placement = "after";
		if (anchorOverride?.anchor) {
			anchor = anchorOverride.anchor;
			placement = anchorOverride.placement || "after";
		} else {
			const merged = buildMergedRenderBlocks(
				state.originalHtml || "",
				localBlocks,
				{ respectRemovals: hasRemovalActions(localBlocks) },
			);
			const anchorInfo = getAnchorForIndex(index, merged);
			anchor = anchorInfo.anchor;
			placement = anchorInfo.placement;
		}
		const updatedLocal = [
			...localBlocks,
			{
				id: makeLocalId(),
				html,
				anchor,
				placement,
				status: "staged",
				kind: "new",
				pos: index,
			},
		];
		state.blocks.splice(index, 0, {
			idx: index,
			type: "std-container",
			summary: "Standard container",
			html,
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
					["Close"],
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

	async function fetchImageLibrary() {
		const res = await fetch("/api/repo/tree?path=assets/img", {
			headers: { Accept: "application/json" },
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data?.error || "Failed to load image list");
		const items = Array.isArray(data.items) ? data.items : [];
		return items.filter((item) => item.type === "file");
	}

	async function loadImageLibraryIntoSelect(select) {
		const images = await fetchImageLibrary();
		select.innerHTML = "";
		select.appendChild(el("option", { value: "" }, ["Select an existing image"]));
		images.forEach((item) => {
			select.appendChild(el("option", { value: item.path }, [item.name]));
		});
		return images;
	}

	function buildImageSourceFields({ initialSrc = "", initialMode = "existing" } = {}) {
		const sourceInput = el("input", {
			type: "text",
			class: "cms-field__input",
			placeholder: "/assets/img/...",
			value: initialSrc || "",
		});
		const modeSelect = el(
			"select",
			{ class: "cms-field__select" },
			[
				el("option", { value: "existing" }, ["Use existing"]),
				el("option", { value: "upload" }, ["Upload new"]),
			],
		);
		modeSelect.value = initialMode === "upload" ? "upload" : "existing";

		const librarySelect = el("select", { class: "cms-field__select" }, [
			el("option", { value: "" }, ["Select an existing image"]),
		]);
		const fileInput = el("input", {
			type: "file",
			class: "cms-field__input",
		});
		const nameInput = el("input", {
			type: "text",
			class: "cms-field__input",
			placeholder: "Filename (e.g. hero.jpg)",
		});
		const previewImg = el("img", {
			class: "cms-image-preview__img",
			alt: "Preview",
		});
		const previewWrap = el("div", { class: "cms-image-preview" }, [previewImg]);

		let currentFile = null;
		let uploadPreviewSrc = "";

		const updatePreview = () => {
			const src =
				modeSelect.value === "upload" && uploadPreviewSrc
					? uploadPreviewSrc
					: sourceInput.value.trim();
			if (!src) {
				previewWrap.hidden = true;
				previewImg.removeAttribute("src");
				return;
			}
			previewWrap.hidden = false;
			previewImg.src = src;
		};

		const stageUpload = (file, filename) => {
			if (!file || !filename) return;
			const reader = new FileReader();
			reader.onload = () => {
				const dataUrl = String(reader.result || "");
				const base64 = dataUrl.split(",")[1] || "";
				addAssetUpload({
					name: filename,
					content: base64,
					path: `assets/img/${filename}`,
				});
				sourceInput.value = `/assets/img/${filename}`;
				uploadPreviewSrc = dataUrl;
				updatePreview();
			};
			reader.readAsDataURL(file);
		};

		librarySelect.addEventListener("change", () => {
			const path = librarySelect.value;
			if (!path) return;
			sourceInput.value = `/${path}`.replace(/^\/+/, "/");
			updatePreview();
		});

		fileInput.addEventListener("change", () => {
			const file = fileInput.files?.[0];
			if (!file) return;
			currentFile = file;
			if (!nameInput.value.trim()) {
				nameInput.value = file.name || "";
			}
			stageUpload(file, nameInput.value.trim());
		});

		nameInput.addEventListener("blur", () => {
			if (!currentFile) return;
			const filename = nameInput.value.trim();
			stageUpload(currentFile, filename);
		});

		sourceInput.addEventListener("input", updatePreview);
		updatePreview();

		const existingWrap = el("div", { class: "cms-image-source__existing" }, [
			buildField({ label: "Existing images", input: librarySelect }),
		]);
		const uploadWrap = el("div", { class: "cms-image-source__upload" }, [
			buildField({ label: "File", input: fileInput }),
			buildField({ label: "Filename", input: nameInput }),
		]);

		const setMode = (mode) => {
			const useUpload = mode === "upload";
			existingWrap.hidden = useUpload;
			uploadWrap.hidden = !useUpload;
			updatePreview();
		};

		setMode(modeSelect.value);
		modeSelect.addEventListener("change", () => setMode(modeSelect.value));

		const wrap = el("div", { class: "cms-image-source" }, [
			buildField({ label: "Source mode", input: modeSelect }),
			buildField({ label: "Image source", input: sourceInput }),
			existingWrap,
			uploadWrap,
			previewWrap,
		]);

		return {
			wrap,
			modeSelect,
			sourceInput,
			librarySelect,
			fileInput,
			nameInput,
			updatePreview,
			setMode,
			getSource: () => sourceInput.value.trim(),
		};
	}

	function openImageSourcePicker({ onSelect, title = "Choose image", initialMode = "existing", initialSrc = "" }) {
		const fields = buildImageSourceFields({
			initialSrc,
			initialMode,
		});

		openModal({
			title,
			bodyNodes: [
				el("div", { class: "cms-modal__group" }, [
					el("div", { class: "cms-modal__group-title" }, ["Image source"]),
					fields.wrap,
					el("div", { class: "cms-modal__note" }, [
						"Uploads are staged and included in the next PR.",
					]),
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
					["Close"],
				),
				el(
					"button",
					{
						class: "cms-btn cms-modal__action cms-btn--success",
						type: "button",
						"data-action": "select",
					},
					["Use image"],
				),
			],
		});

		loadImageLibraryIntoSelect(fields.librarySelect).catch((err) =>
			console.error(err),
		);

		const modal = document.querySelector(".cms-modal");
		const useBtn = modal?.querySelector(
			".cms-btn.cms-modal__action.cms-btn--success[data-action=\"select\"]",
		);
		if (!useBtn) return;
		useBtn.addEventListener("click", () => {
			const src = fields.getSource();
			if (!src) return;
			onSelect?.(src);
			closeModal();
		});
	}

	function buildRteEditor({ label, initialHtml }) {
		const codeLangOptions = [
			{ value: "auto", label: "Auto" },
			{ value: "javascript", label: "JS" },
			{ value: "json", label: "JSON" },
			{ value: "html", label: "HTML" },
			{ value: "css", label: "CSS" },
			{ value: "python", label: "Python" },
			{ value: "markdown", label: "Markdown" },
			{ value: "yaml", label: "YAML" },
		];
		const toolbar = el("div", { class: "cms-rte__toolbar" }, [
			el("button", { type: "button", "data-cmd": "bold" }, ["B"]),
			el("button", { type: "button", "data-cmd": "italic" }, ["I"]),
			el("button", { type: "button", "data-cmd": "underline" }, ["U"]),
			el("button", { type: "button", "data-cmd": "h2" }, ["H2"]),
			el("button", { type: "button", "data-cmd": "h3" }, ["H3"]),
			el("button", { type: "button", "data-cmd": "quote" }, ["❝"]),
			el("button", { type: "button", "data-cmd": "ul" }, ["•"]),
			el("button", { type: "button", "data-cmd": "ol" }, ["1."]),
			el("button", { type: "button", "data-cmd": "table" }, ["Table"]),
			el("button", { type: "button", "data-cmd": "table-row" }, ["Row +"]),
			el("button", { type: "button", "data-cmd": "table-col" }, ["Col +"]),
			el("button", { type: "button", "data-cmd": "code" }, ["Code"]),
			el("button", { type: "button", "data-cmd": "code-block" }, ["Block code"]),
			el("button", { type: "button", "data-cmd": "img" }, ["Image"]),
		]);
		const editor = el("div", {
			class: "cms-rte",
			contenteditable: "true",
			"data-rte": "true",
		});
		editor.innerHTML = initialHtml || "";

		const TOOLBAR_TEXT_RE =
			/Auto\s*JS\s*JSON\s*HTML\s*CSS\s*Python\s*Markdown\s*YAML\s*Format/g;

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

		const updateCodeLanguage = (codeEl, lang) => {
			if (!codeEl) return;
			const clean = String(lang || "").trim().toLowerCase();
			codeEl.className = "";
			codeEl.removeAttribute("data-lang");
			if (clean && clean !== "auto") {
				codeEl.className = `language-${clean}`;
				codeEl.setAttribute("data-lang", clean);
			}
		};

		const ensureCodeToolbar = (pre) => {
			if (!pre) return;
			const codeEl = pre.querySelector("code");
			if (!codeEl) return;
			let wrapper = pre.parentElement?.classList.contains("cms-code-block-wrap")
				? pre.parentElement
				: null;
			if (!wrapper) {
				wrapper = el("div", { class: "cms-code-block-wrap" });
				pre.parentNode?.insertBefore(wrapper, pre);
				wrapper.appendChild(pre);
			}
			const existing = wrapper.querySelector(".cms-code-toolbar");
			if (existing) return;
			const textLang = getLangFromCodeEl(codeEl);
			const detected = textLang || guessLanguageFromText(codeEl.textContent);
			if (!textLang && detected && detected !== "auto") {
				updateCodeLanguage(codeEl, detected);
			}
			if (TOOLBAR_TEXT_RE.test(codeEl.textContent)) {
				codeEl.textContent = codeEl.textContent.replace(TOOLBAR_TEXT_RE, "");
			}
			pre.querySelectorAll(".cms-code-toolbar, select, button").forEach((el) => {
				if (pre.contains(el)) el.remove();
			});
			pre.classList.add("cms-code-block");
			const tool = el("div", {
				class: "cms-code-toolbar",
				contenteditable: "false",
			});
			const langSelectInline = el(
				"select",
				{ class: "cms-code-toolbar__select", contenteditable: "false" },
				codeLangOptions.map((opt) =>
					el("option", { value: opt.value }, [opt.label]),
				),
			);
			langSelectInline.value = detected || "auto";
			const formatBtn = el(
				"button",
				{
					type: "button",
					class: "cms-code-toolbar__btn",
					contenteditable: "false",
					title: "Format code",
				},
				["Format"],
			);
			langSelectInline.addEventListener("change", () => {
				updateCodeLanguage(codeEl, langSelectInline.value);
				formatCodeBlocksInEditor(pre).then(() => {
					if (window.hljs) {
						codeEl.textContent = codeEl.textContent;
						codeEl.removeAttribute("data-highlighted");
						codeEl.classList.remove("hljs");
						window.hljs.highlightElement(codeEl);
					}
				});
			});
			formatBtn.addEventListener("click", () => {
				if (langSelectInline.value === "auto") {
					const guessed = guessLanguageFromText(codeEl.textContent);
					if (guessed && guessed !== "auto") {
						langSelectInline.value = guessed;
						updateCodeLanguage(codeEl, guessed);
					}
				}
				formatCodeBlocksInEditor(pre).then(() => {
					if (window.hljs) {
						codeEl.textContent = codeEl.textContent;
						codeEl.removeAttribute("data-highlighted");
						codeEl.classList.remove("hljs");
						window.hljs.highlightElement(codeEl);
					}
				});
			});
			tool.appendChild(langSelectInline);
			tool.appendChild(formatBtn);
			wrapper.appendChild(tool);
		};

		editor.querySelectorAll("pre").forEach((pre) => ensureCodeToolbar(pre));

		const codeObserver = new MutationObserver((mutations) => {
			mutations.forEach((mutation) => {
				mutation.addedNodes.forEach((node) => {
					if (!(node instanceof HTMLElement)) return;
					if (node.matches("pre")) ensureCodeToolbar(node);
					node.querySelectorAll?.("pre").forEach((pre) =>
						ensureCodeToolbar(pre),
					);
				});
			});
		});
		codeObserver.observe(editor, { childList: true, subtree: true });

		let activeImageTarget = null;

		const imageFields = buildImageSourceFields();
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
		const overlayOptionsWrap = el("div", { class: "cms-rte__panel-subgroup" }, [
			buildField({
				label: "Overlay text",
				input: el("div", { class: "cms-field__row" }, [
					overlayTitleInput,
					overlayTextInput,
				]),
			}),
		]);
		const sizeSelect = el(
			"select",
			{ class: "cms-field__select" },
			[
				el("option", { value: "sml" }, ["Small"]),
				el("option", { value: "lrg" }, ["Large"]),
			],
		);
		const lightboxInput = el("input", {
			type: "checkbox",
			class: "cms-field__checkbox",
		});
		lightboxInput.checked = true;
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
		const imageCancelBtn = el(
			"button",
			{ class: "cms-btn", type: "button" },
			["Close"],
		);
		const imagePanel = el(
			"div",
			{ class: "cms-rte__panel cms-rte__panel--image" },
			[
				imageFields.wrap,
				buildField({ label: "Caption", input: captionInput }),
				buildField({
					label: "Lightbox",
					input: el("label", { class: "cms-field__toggle" }, [
						lightboxInput,
						el("span", { class: "cms-field__toggle-text" }, ["Enable"]),
					]),
				}),
				buildField({
					label: "Overlay",
					input: el("label", { class: "cms-field__toggle" }, [
						overlayEnabledInput,
						el("span", { class: "cms-field__toggle-text" }, ["Enable"]),
					]),
				}),
				overlayOptionsWrap,
				buildField({ label: "Size", input: sizeSelect }),
				el("div", { class: "cms-rte__panel-actions" }, [
					imageDeleteBtn,
					imageCancelBtn,
					imageSaveBtn,
				]),
			],
		);
		imagePanel.hidden = true;

		const syncOverlayState = () => {
			const enabled = overlayEnabledInput.checked;
			overlayTitleInput.disabled = !enabled;
			overlayTextInput.disabled = !enabled;
			overlayOptionsWrap.hidden = !enabled;
		};
		syncOverlayState();
		overlayEnabledInput.addEventListener("change", syncOverlayState);

		const wrap = el("div", { class: "cms-rte__field" }, [
			el("div", { class: "cms-rte__label" }, [label]),
			toolbar,
			editor,
			imagePanel,
		]);

		const openImagePanel = ({ targetStub = null } = {}) => {
			activeImageTarget = targetStub;
			const attrs = targetStub
				? {
						img: targetStub.getAttribute("data-img") || "",
						caption: targetStub.getAttribute("data-caption") || "",
						lightbox: targetStub.getAttribute("data-lightbox") || "false",
						overlay: targetStub.getAttribute("data-overlay") || "",
						overlayTitle: targetStub.getAttribute("data-overlay-title") || "",
						overlayText: targetStub.getAttribute("data-overlay-text") || "",
						size: targetStub.getAttribute("data-size") || "sml",
					}
				: null;
			if (attrs) {
				imageFields.modeSelect.value = "existing";
				imageFields.sourceInput.value = attrs.img;
				captionInput.value = attrs.caption;
				lightboxInput.checked = normalizeBool(attrs.lightbox, "false") === "true";
				overlayEnabledInput.checked = attrs.overlay !== "false";
				overlayTitleInput.value = attrs.overlayTitle;
				overlayTextInput.value = attrs.overlayText;
				sizeSelect.value = attrs.size || "sml";
			} else {
				imageFields.modeSelect.value = "existing";
				imageFields.sourceInput.value = "";
				captionInput.value = "";
				lightboxInput.checked = true;
				overlayEnabledInput.checked = true;
				overlayTitleInput.value = "";
				overlayTextInput.value = "";
				sizeSelect.value = "sml";
			}
			syncOverlayState();
			imageFields.updatePreview();
			imageSaveBtn.textContent = targetStub ? "Update image" : "Insert image";
			imageDeleteBtn.disabled = !targetStub;
			imagePanel.hidden = false;
			loadImageLibraryIntoSelect(imageFields.librarySelect).catch((err) =>
				console.error(err),
			);
			imagePanel.scrollIntoView({ block: "center", behavior: "smooth" });
		};

		const closeImagePanel = () => {
			activeImageTarget = null;
			imagePanel.hidden = true;
		};

		imageSaveBtn.addEventListener("click", () => {
			const src = imageFields.getSource();
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
				size: sizeSelect.value || "sml",
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
				activeImageTarget.setAttribute("data-size", attrs.size || "sml");
			} else {
				const html = serializeImgStub(attrs);
				insertHtmlAtCursor(editor, html);
			}
			closeImagePanel();
		});

		imageDeleteBtn.addEventListener("click", () => {
			if (!activeImageTarget) return;
			activeImageTarget.remove();
			closeImagePanel();
		});

		imageCancelBtn.addEventListener("click", () => closeImagePanel());

		toolbar.addEventListener("click", (event) => {
			const btn = event.target.closest("button");
			if (!btn) return;
			const cmd = btn.getAttribute("data-cmd");
			if (!cmd) return;
			editor.focus();
			if (cmd === "bold") document.execCommand("bold");
			else if (cmd === "italic") document.execCommand("italic");
			else if (cmd === "underline") document.execCommand("underline");
			else if (cmd === "h2") document.execCommand("formatBlock", false, "H2");
			else if (cmd === "h3") document.execCommand("formatBlock", false, "H3");
			else if (cmd === "quote")
				document.execCommand("formatBlock", false, "BLOCKQUOTE");
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
			} else if (cmd === "table-row") {
				addTableRowAfterCell();
			} else if (cmd === "table-col") {
				addTableColumnAfterCell();
			} else if (cmd === "code") {
				const selection = window.getSelection();
				if (!selection || selection.rangeCount === 0) return;
				const range = selection.getRangeAt(0);
				if (range.collapsed) return;
				let node = range.commonAncestorContainer;
				if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
				const existingCode = node?.closest ? node.closest("code") : null;
				if (existingCode) {
					const textNode = document.createTextNode(existingCode.textContent || "");
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
				if (existingPre) {
					const textNode = document.createTextNode(existingPre.textContent || "");
					existingPre.replaceWith(textNode);
					selection.removeAllRanges();
					const newRange = document.createRange();
					newRange.selectNodeContents(textNode);
					selection.addRange(newRange);
					return;
				}
				if (range.collapsed) return;
				if (range.collapsed) return;
				const pre = document.createElement("pre");
				const code = document.createElement("code");
				const lang = guessLanguageFromText(range.toString());
				updateCodeLanguage(code, lang);
				code.textContent = range.toString();
				pre.appendChild(code);
				const rawText = code.textContent;
				const parser = getParserForLang(lang);
				if (parser) {
					formatCodeBlocksInEditor(pre).then(() => {
						range.deleteContents();
						range.insertNode(pre);
						ensureCodeToolbar(pre);
					});
				} else {
					range.deleteContents();
					range.insertNode(pre);
					ensureCodeToolbar(pre);
				}
				selection.removeAllRanges();
				const newRange = document.createRange();
				newRange.selectNodeContents(pre);
				selection.addRange(newRange);
			} else if (cmd === "img") {
				openImagePanel();
			}
		});
		editor.addEventListener("keydown", (event) => {
			if (event.key !== "Tab") return;
			const selection = window.getSelection();
			if (!selection || !selection.anchorNode) return;
			let node = selection.anchorNode;
			if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
			const codeBlock = node?.closest ? node.closest("pre, code") : null;
			if (codeBlock) {
				event.preventDefault();
				document.execCommand("insertText", false, "\t");
				return;
			}
			const li = node?.closest ? node.closest("li") : null;
			if (!li) return;
			event.preventDefault();
			if (event.shiftKey) document.execCommand("outdent");
			else document.execCommand("indent");
		});
		editor.addEventListener("paste", (event) => {
			const selection = window.getSelection();
			if (!selection || selection.rangeCount === 0) return;
			const range = selection.getRangeAt(0);
			let node = range.commonAncestorContainer;
			if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
			const codeBlock = node?.closest ? node.closest("pre, code") : null;
			if (!codeBlock) return;
			const text = event.clipboardData?.getData("text/plain");
			if (!text) return;
			event.preventDefault();
			document.execCommand("insertText", false, text);
		});
		editor.addEventListener("click", (event) => {
			const stub = event.target.closest(".img-stub");
			if (stub && editor.contains(stub)) {
				openImagePanel({ targetStub: stub });
			}
		});
		return {
			wrap,
			editor,
			formatCodeBlocks: () => formatCodeBlocksInEditor(editor),
		};
	}

	function stripEditEntriesForBase(localBlocks, anchor) {
		const key = anchorKey(anchor);
		return normalizeLocalBlocks(localBlocks).filter((item) => {
			if (item.action === "mark" && anchorKey(item.anchor) === key) return false;
			if (item.action === "remove" && anchorKey(item.anchor) === key) return false;
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
		const nodes = [
			el("div", { class: "cms-field__label" }, [label]),
			input,
		];
		if (note) nodes.push(el("div", { class: "cms-field__note" }, [note]));
		return el("div", { class: "cms-field" }, nodes);
	}

	function openBlockEditor({ blockHtml, origin, localId, anchorBase, currentLocal }) {
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
						["Close"],
					),
				],
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
						["Close"],
					),
				],
			});
			return;
		}

		let editors = [];
		let settings = {};
		if (parsed.type === "twoCol") {
			const headingInput = el("input", {
				type: "text",
				class: "cms-field__input",
				value: parsed.heading || "",
				placeholder: "Heading",
			});
			const left = buildRteEditor({
				label: "Left column",
				initialHtml: parsed.left || "",
			});
			const right = buildRteEditor({
				label: "Right column",
				initialHtml: parsed.right || "",
			});
			editors = [
				{ key: "left", editor: left.editor, formatCodeBlocks: left.formatCodeBlocks },
				{ key: "right", editor: right.editor, formatCodeBlocks: right.formatCodeBlocks },
			];
			openModal({
				title: "Edit block",
				bodyNodes: [
					buildField({
						label: "Heading",
						input: headingInput,
						note: "Optional block heading.",
					}),
					left.wrap,
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
						["Close"],
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
			});
			settings = { headingInput };
		} else {
			let headingInput = null;
			let imgInput = null;
			let imagePickBtn = null;
			let imageModeSelect = null;
			let captionInput = null;
			let overlayEnabledInput = null;
			let overlayTitleInput = null;
			let overlayTextInput = null;
			let lightboxInput = null;
			let posSelect = null;

			if (parsed.type === "imgText" || parsed.type === "split50") {
				headingInput = el("input", {
					type: "text",
					class: "cms-field__input",
					value: parsed.heading || "",
					placeholder: "Heading",
				});
				imgInput = el("input", {
					type: "text",
					class: "cms-field__input",
					value: parsed.img || "",
					placeholder: "/assets/img/...",
				});
				imageModeSelect = el(
					"select",
					{ class: "cms-field__select" },
					[
						el("option", { value: "existing" }, ["Use existing"]),
						el("option", { value: "upload" }, ["Upload new"]),
					],
				);
				imageModeSelect.value = "existing";
				imagePickBtn = el(
					"button",
					{
						class: "cms-btn cms-btn--primary cms-btn--inline",
						type: "button",
					},
					["Choose image"],
				);
				imagePickBtn.addEventListener("click", () => {
					openImageSourcePicker({
						onSelect: (src) => {
							imgInput.value = src;
						},
						initialMode: imageModeSelect?.value || "existing",
						initialSrc: imgInput.value || "",
						title: "Choose image for block",
					});
				});
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
				lightboxInput.checked = normalizeBool(parsed.lightbox, "false") === "true";
				posSelect = el(
					"select",
					{ class: "cms-field__select" },
					[
						el("option", { value: "left" }, ["Image left"]),
						el("option", { value: "right" }, ["Image right"]),
					],
				);
				posSelect.value = parsed.imgPos === "right" ? "right" : "left";
			}

			const body = buildRteEditor({
				label: "Content",
				initialHtml: parsed.body || "",
			});
			editors = [
				{ key: "body", editor: body.editor, formatCodeBlocks: body.formatCodeBlocks },
			];

			const settingsNodes = [];
			if (headingInput) {
				settingsNodes.push(
					buildField({
						label: "Heading",
						input: headingInput,
						note: "Controls the block title styling.",
					}),
				);
			}
			if (imgInput) {
				const imageRow = el("div", { class: "cms-field__row" }, [
					imgInput,
					imageModeSelect,
					imagePickBtn,
				]);
				const displayRow = el("div", { class: "cms-field__row" }, [
					posSelect,
					el("label", { class: "cms-field__toggle" }, [
						lightboxInput,
						el("span", { class: "cms-field__toggle-text" }, ["Lightbox"]),
					]),
					el("label", { class: "cms-field__toggle" }, [
						overlayEnabledInput,
						el("span", { class: "cms-field__toggle-text" }, ["Overlay"]),
					]),
				]);
				settingsNodes.push(
					buildField({
						label: "Image source",
						input: imageRow,
						note: "Required for image blocks.",
					}),
				);
				settingsNodes.push(
					buildField({
						label: "Display",
						input: displayRow,
					}),
				);
				settingsNodes.push(
					buildField({ label: "Caption", input: captionInput }),
				);
				const overlayOptionsWrap = el(
					"div",
					{ class: "cms-modal__subgroup" },
					[
						buildField({
							label: "Overlay text",
							input: el("div", { class: "cms-field__row" }, [
								overlayTitleInput,
								overlayTextInput,
							]),
						}),
					],
				);
				settingsNodes.push(overlayOptionsWrap);
				const syncOverlayState = () => {
					const enabled = overlayEnabledInput.checked;
					overlayTitleInput.disabled = !enabled;
					overlayTextInput.disabled = !enabled;
					overlayOptionsWrap.hidden = !enabled;
				};
				syncOverlayState();
				overlayEnabledInput.addEventListener("change", syncOverlayState);
			}

			const settingsWrap =
				settingsNodes.length > 0
					? el("div", { class: "cms-modal__group cms-modal__group--settings" }, [
							el("div", { class: "cms-modal__group-title" }, ["Block settings"]),
							...settingsNodes,
						])
					: null;

			openModal({
				title: "Edit block",
				bodyNodes: settingsWrap ? [settingsWrap, body.wrap] : [body.wrap],
				footerNodes: [
					el(
						"button",
						{
							class: "cms-btn cms-modal__action cms-btn--danger",
							type: "button",
							"data-close": "true",
						},
						["Close"],
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
			});

			settings = {
				headingInput,
				imgInput,
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
			".cms-btn.cms-modal__action.cms-btn--success[data-action=\"save-block\"]",
		);
		if (!saveBtn) return;

		saveBtn.addEventListener("click", async () => {
			const updated = { ...parsed };
			if (settings.headingInput) {
				updated.heading = settings.headingInput.value.trim();
				updated.headingTag = parsed.headingTag || "h2";
			}
			if (settings.imgInput) {
				updated.img = settings.imgInput.value.trim();
				updated.caption = settings.captionInput?.value.trim() || "";
				const overlayEnabled = settings.overlayEnabledInput?.checked;
				updated.overlayEnabled = overlayEnabled;
				updated.overlayTitle = overlayEnabled
					? settings.overlayTitleInput?.value.trim() || ""
					: "";
				updated.overlayText = overlayEnabled
					? settings.overlayTextInput?.value.trim() || ""
					: "";
				updated.lightbox = settings.lightboxInput?.checked ? "true" : "false";
				updated.imgPos = settings.posSelect?.value || "left";
			}
			await Promise.all(
				editors.map(async ({ key, editor, formatCodeBlocks }) => {
					await formatCodeBlocks?.();
					const raw = editor.innerHTML;
					if (key === "left") updated.left = sanitizeRteHtml(raw, ctx);
					else if (key === "right") updated.right = sanitizeRteHtml(raw, ctx);
					else updated.body = sanitizeRteHtml(raw, ctx);
				}),
			);
			const updatedHtml = serializeMainBlocks([updated], {
				path: state.path,
			}).trim();
			if (!updatedHtml) return;

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
		updateTick: 0,
		debug: debugEnabled(),
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
			// Keep committed markers for this session after merge.
			removePrFromState(number);
			stopPrPolling();
			if (state.prUrl) {
				setUiState("pr", buildPrLabel());
				startPrPolling();
			} else {
				await purgeDirtyPagesFromRepo(true);
				await refreshCurrentPageFromRepo();
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
			if (state.prUrl) {
				setUiState("pr", buildPrLabel());
				startPrPolling();
			} else {
				await purgeDirtyPagesFromRepo(true);
				await refreshCurrentPageFromRepo();
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

	function renderPageSurface() {
		const entry = state.dirtyPages[state.path];
		if (entry?.html) {
			const hero = extractRegion(entry.html, "hero");
			const main = extractRegion(entry.html, "main");
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
					openInsertBlockModal(0, null);
				});
			});

			root.appendChild(mainWrap);
			return;
		}

		const insertDivider = (index, label = "Insert block", anchorInfo = null) => {
			const attrs = {
				class: "cms-divider-btn",
				type: "button",
				"data-insert": String(index),
			};
			if (anchorInfo?.anchor?.id) {
				attrs["data-anchor-id"] = anchorInfo.anchor.id;
				if (anchorInfo.anchor.sig)
					attrs["data-anchor-sig"] = anchorInfo.anchor.sig;
				if (Number.isInteger(anchorInfo.anchor.occ))
					attrs["data-anchor-occ"] = String(anchorInfo.anchor.occ);
				if (anchorInfo.placement)
					attrs["data-anchor-placement"] = anchorInfo.placement;
			}
			return el(
				"button",
				attrs,
				[
					el("span", { class: "cms-divider-line", "aria-hidden": "true" }),
					el("span", { class: "cms-divider-plus", "aria-hidden": "true" }, [
						"＋",
					]),
					el("span", { class: "cms-divider-text" }, [label]),
					el("span", { class: "cms-divider-line", "aria-hidden": "true" }),
				],
			);
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
							else status = "edited";
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
			if (isBase) {
				if (b.id) wrapper.setAttribute("data-base-id", b.id);
				if (b.sig) wrapper.setAttribute("data-base-sig", b.sig);
				if (Number.isInteger(b.occ))
					wrapper.setAttribute("data-base-occ", String(b.occ));
			}
			Array.from(frag.children).forEach((n) => wrapper.appendChild(n));
			if (localItem && !isPending) {
				const controls = el("div", { class: "cms-block__controls" }, [
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
				]);
				wrapper.appendChild(controls);
			}
			if (!localItem && !isPending && isBase) {
				const isUndo = isMarkedRemove;
				const controls = el("div", { class: "cms-block__controls" }, [
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
				]);
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
			mainWrap.appendChild(
				insertDivider(idx + 1, "Insert block", anchorForIndex(idx + 1)),
			);
		});

		root.appendChild(mainWrap);

		queueMicrotask(() => {
			mainWrap.querySelectorAll(".cms-divider-btn").forEach((btn) => {
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
					const baseHtmlByKey = new Map(
						baseOrder.map((b) => [anchorKey(b), normalizeFragmentHtml(b.html)]),
					);
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
		window.initLightbox?.();
		if (window.hljs?.highlightAll) {
			window.hljs.highlightAll();
		}
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
			const close = el("button", { id: "cms-debug-close", type: "button" }, [
				"×",
			]);
			const pre = el("pre", { id: "cms-debug-text" }, []);
			header.appendChild(btn);
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

		const baseBlocks = buildBaseBlocksWithOcc(state.originalHtml || "");
		const baselineOrder = baseBlocks.map((b) => b.id);
		const localBlocks = normalizeLocalBlocks(
			state.dirtyPages[state.path]?.localBlocks || [],
		);
		const currentOrder = buildBaseOrderFromReorders(baseBlocks, localBlocks);
		const short = (id) => (id ? String(id).slice(0, 10) : "null");
		const lines = [];
		lines.push(`path: ${state.path}`);
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
		const dirtyEntry = state.dirtyPages[path] || {};
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
		const res = await fetch(url, { headers: { Accept: "application/json" } });
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
				const localIdsToDrop = new Set();
				(entry.all || []).forEach((block) => {
					if (!selectedIds.has(block.id)) return;
					if (block.localId) localIdsToDrop.add(block.localId);
				});
				const remainingLocal = normalizeLocalBlocks(
					(state.dirtyPages[path]?.localBlocks || []).filter(
						(item) => !localIdsToDrop.has(item.id),
					),
				);
				const updatedHtml = mergeDirtyWithBase(
					entry.baseHtml || entry.dirtyHtml || "",
					entry.baseHtml || entry.dirtyHtml || "",
					remainingLocal,
					{
						respectRemovals: hasRemovalActions(remainingLocal),
						path,
					},
				);
				const remappedLocal = assignAnchorsFromHtml(
					entry.baseHtml || entry.dirtyHtml || "",
					updatedHtml,
					remainingLocal,
				);
				if (!updatedHtml || updatedHtml.trim() === entry.baseHtml.trim())
					clearDirtyPage(path);
				else setDirtyPage(path, updatedHtml, entry.baseHtml, remappedLocal);
				if (path === state.path) {
					applyHtmlToCurrentPage(updatedHtml);
					renderPageSurface();
				}
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
			openModal({
				title: "PR already open",
				bodyNodes: [
					el("p", {}, [
						"A pull request is already open for this session. Merge or close it before creating another.",
					]),
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
				const remainingHtml = mergeDirtyWithBase(
					remainingBase,
					remainingBase,
					remainingLocal,
					{
						respectRemovals: hasRemovalActions(remainingLocal),
						path,
					},
				);
				const remappedLocal = assignAnchorsFromHtml(
					remainingBase,
					remainingHtml,
					remainingLocal,
				);
				if (commitHtml) {
					payloads.push({ path, text: commitHtml });
				}
				if (!remainingHtml || remainingHtml.trim() === entry.baseHtml.trim())
					clearDirtyPage(path);
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

			qs("#cms-modal").classList.remove("is-open");
			document.documentElement.classList.remove("cms-lock");
			document.body.classList.remove("cms-lock");

			if (!payloads.length) return;
			const pr = await submitPr(
				payloads.map((p) => p.path),
				noteInput.value,
				payloads,
			);
			if (!pr?.number) return;
			commitSelections.forEach(({ path, entry, selectedIds }) => {
				const selectedBlocks = (entry.all || [])
					.filter((block) => selectedIds.has(block.id))
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
