import { TFile, Vault } from "obsidian";
import { uploadImage } from "./api";

/**
 * Strip YAML frontmatter from the beginning of a markdown string.
 */
function stripFrontmatter(md: string): string {
	const match = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
	if (match) {
		return md.slice(match[0].length);
	}
	return md;
}

/**
 * Convert Obsidian wiki links to plain text.
 * [[Page Name]] -> Page Name
 * [[Page Name|display text]] -> display text
 */
function convertWikiLinks(md: string): string {
	// Handle aliased links first: [[target|display]]
	md = md.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
	// Handle plain links: [[target]]
	md = md.replace(/\[\[([^\]]+)\]\]/g, "$1");
	return md;
}

/**
 * Strip Obsidian comments: %%comment%%
 * Handles both inline and multi-line comments.
 */
function stripComments(md: string): string {
	return md.replace(/%%[\s\S]*?%%/g, "");
}

/**
 * Strip hashtag-style tags (#tag).
 * Avoids stripping markdown headings (# heading) by requiring tags
 * to not be at the start of a line or preceded only by whitespace with #.
 */
function stripTags(md: string): string {
	// Match #tag that isn't a heading (headings: line starts with # followed by space)
	// Tags: # followed by word chars, not preceded by line-start-only hashes
	return md.replace(/(^|\s)#(?!#|\s)([\w/-]+)/gm, (match, prefix, tag, offset, str) => {
		// Check if this is a heading: line starts with one or more # then space
		const lineStart = str.lastIndexOf("\n", offset - 1) + 1;
		const beforeOnLine = str.slice(lineStart, offset + prefix.length);
		if (/^#{0,6}$/.test(beforeOnLine.trim()) && beforeOnLine.trim().length > 0) {
			// This # is part of a heading like "## #tag" - still strip the tag
			// But "# heading" shouldn't match since heading text doesn't start with #
			return match;
		}
		// Strip the tag but preserve the leading whitespace/start-of-line
		return prefix;
	});
}

/**
 * Identify regions in the markdown that are inside fenced code blocks or inline code,
 * so image regex matches inside them can be skipped.
 */
function buildCodeRegions(md: string): Array<{ start: number; end: number }> {
	const regions: Array<{ start: number; end: number }> = [];
	// Fenced code blocks: ``` or ~~~
	const fencedRe = /^(`{3,}|~{3,}).*\n[\s\S]*?\n\1\s*$/gm;
	let m;
	while ((m = fencedRe.exec(md)) !== null) {
		regions.push({ start: m.index, end: m.index + m[0].length });
	}
	// Inline code: `...`
	const inlineRe = /`[^`\n]+`/g;
	while ((m = inlineRe.exec(md)) !== null) {
		regions.push({ start: m.index, end: m.index + m[0].length });
	}
	return regions;
}

function isInsideCode(offset: number, regions: Array<{ start: number; end: number }>): boolean {
	return regions.some((r) => offset >= r.start && offset < r.end);
}

/**
 * Find all local image references in markdown and upload them.
 * Handles both wiki-style ![[image.png]] and standard ![alt](path) syntax.
 * Returns the markdown with local paths replaced by uploaded URLs.
 * Skips image references inside fenced code blocks and inline code.
 */
async function processImages(
	md: string,
	vault: Vault,
	apiKey: string,
	sourceFile: TFile
): Promise<string> {
	const imageExtensions = /\.(png|jpe?g|gif|webp|svg)$/i;
	const codeRegions = buildCodeRegions(md);

	// Collect all image references to process
	const replacements: { original: string; url: string }[] = [];

	// Match wiki-style images: ![[filename.ext]] or ![[filename.ext|alt]]
	const wikiImageRegex = /!\[\[([^\]|]+(?:\.[a-zA-Z]+))(?:\|[^\]]*)?\]\]/g;
	let match;
	while ((match = wikiImageRegex.exec(md)) !== null) {
		if (isInsideCode(match.index, codeRegions)) continue;
		const imageName = match[0];
		const fileName = match[1];
		if (!imageExtensions.test(fileName)) continue;

		const url = await resolveAndUploadImage(vault, fileName, apiKey, sourceFile);
		if (url) {
			replacements.push({ original: imageName, url });
		}
	}

	// Match standard markdown images: ![alt](path)
	// Only process local paths (not http/https URLs)
	const mdImageRegex = /!\[([^\]]*)\]\((?!https?:\/\/)([^)]+)\)/g;
	while ((match = mdImageRegex.exec(md)) !== null) {
		if (isInsideCode(match.index, codeRegions)) continue;
		const imageName = match[0];
		const alt = match[1];
		const path = match[2];
		if (!imageExtensions.test(path)) continue;

		const url = await resolveAndUploadImage(vault, path, apiKey, sourceFile);
		if (url) {
			replacements.push({ original: imageName, url: `![${alt}](${url})` });
		}
	}

	// Apply replacements (use split/join to replace all occurrences and avoid $-pattern issues)
	for (const { original, url } of replacements) {
		const replacement = original.startsWith("![[") ? `![](${url})` : url;
		md = md.split(original).join(replacement);
	}

	return md;
}

async function resolveAndUploadImage(
	vault: Vault,
	fileName: string,
	apiKey: string,
	sourceFile: TFile
): Promise<string | null> {
	// Try to resolve the file using Obsidian's link resolution
	const resolved = vault.getFiles().find((f) => {
		return f.path === fileName || f.name === fileName || f.path.endsWith("/" + fileName);
	});

	if (!resolved) return null;

	try {
		const data = await vault.readBinary(resolved);
		const mimeType = getMimeType(resolved.extension);
		if (!mimeType) return null;

		const result = await uploadImage(apiKey, data, resolved.name, mimeType);
		return result.url;
	} catch {
		return null;
	}
}

function getMimeType(ext: string): string | null {
	const map: Record<string, string> = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
		svg: "image/svg+xml",
	};
	return map[ext.toLowerCase()] ?? null;
}

/**
 * Process markdown content for publishing.
 * Strips frontmatter, converts wiki links, strips comments,
 * optionally strips tags, and uploads local images.
 */
export async function processMarkdown(
	content: string,
	vault: Vault,
	sourceFile: TFile,
	apiKey: string,
	shouldStripTags: boolean
): Promise<string> {
	let md = stripFrontmatter(content);
	md = stripComments(md);
	// Process images before converting wiki links, so ![[image.png]] is still intact
	md = await processImages(md, vault, apiKey, sourceFile);
	md = convertWikiLinks(md);
	if (shouldStripTags) {
		md = stripTags(md);
	}
	// Trim leading/trailing whitespace
	md = md.trim();
	return md;
}

/**
 * Extract a title from the note. Uses the first H1 heading if present,
 * otherwise falls back to the filename without extension.
 */
export function extractTitle(content: string, file: TFile): string {
	// Try frontmatter title first
	const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
	if (fmMatch) {
		const titleMatch = fmMatch[0].match(/^title:\s*(.+)$/m);
		if (titleMatch) {
			return titleMatch[1].trim().replace(/^["']|["']$/g, "");
		}
	}

	// Try first H1
	const stripped = stripFrontmatter(content);
	const h1Match = stripped.match(/^#\s+(.+)$/m);
	if (h1Match) {
		return h1Match[1].trim();
	}

	// Fall back to filename
	return file.basename;
}
