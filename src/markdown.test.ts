import { describe, it, expect, vi, beforeEach } from "vitest";
import { TFile, Vault } from "obsidian";
import { processMarkdown, extractTitle, applyTitleMode } from "./markdown";

// Mock the api module to control uploadImage behavior
vi.mock("./api", () => ({
	uploadImage: vi.fn(),
}));

import { uploadImage } from "./api";
const mockUploadImage = vi.mocked(uploadImage);

function makeFile(path: string, basename?: string, extension?: string): TFile {
	const file = new TFile();
	file.path = path;
	file.name = basename ? `${basename}.${extension ?? "md"}` : path.split("/").pop()!;
	file.basename = basename ?? file.name.replace(/\.[^.]+$/, "");
	file.extension = extension ?? "md";
	return file;
}

function makeVault(files: TFile[] = []): Vault {
	const vault = new Vault();
	vault.getFiles = vi.fn().mockReturnValue(files);
	return vault;
}

// ---- Frontmatter stripping ----

describe("frontmatter stripping", () => {
	it("strips basic YAML frontmatter", async () => {
		const input = `---
title: My Note
tags: [test]
---
# Hello World`;
		const result = await processMarkdown(input, makeVault(), "key", false);
		expect(result).toBe("# Hello World");
	});

	it("strips frontmatter with various field types", async () => {
		const input = `---
title: Test
date: 2024-01-01
draft: false
---
Content here`;
		const result = await processMarkdown(input, makeVault(), "key", false);
		expect(result).toBe("Content here");
	});

	it("leaves content untouched when no frontmatter present", async () => {
		const input = "Just some markdown content";
		const result = await processMarkdown(input, makeVault(), "key", false);
		expect(result).toBe("Just some markdown content");
	});

	it("does not strip --- that appears later in the document", async () => {
		const input = `---
title: Test
---
Content

---

More content`;
		const result = await processMarkdown(input, makeVault(), "key", false);
		expect(result).toBe("Content\n\n---\n\nMore content");
	});

	it("handles frontmatter with CRLF line endings", async () => {
		const input = "---\r\ntitle: Test\r\n---\r\nContent";
		const result = await processMarkdown(input, makeVault(), "key", false);
		expect(result).toBe("Content");
	});
});

// ---- Wiki link conversion ----

describe("wiki link conversion", () => {
	it("converts simple wiki links to plain text", async () => {
		const input = "See [[My Page]] for details";
		const result = await processMarkdown(input, makeVault(), "key", false);
		expect(result).toBe("See My Page for details");
	});

	it("converts aliased wiki links to display text", async () => {
		const input = "See [[My Page|the page]] for details";
		const result = await processMarkdown(input, makeVault(), "key", false);
		expect(result).toBe("See the page for details");
	});

	it("handles multiple wiki links in one line", async () => {
		const input = "Link to [[Page A]] and [[Page B|B page]]";
		const result = await processMarkdown(input, makeVault(), "key", false);
		expect(result).toBe("Link to Page A and B page");
	});

	it("handles wiki links with paths", async () => {
		const input = "See [[folder/My Page]]";
		const result = await processMarkdown(input, makeVault(), "key", false);
		expect(result).toBe("See folder/My Page");
	});

	it("does not modify standard markdown links", async () => {
		const input = "See [display text](https://example.com)";
		const result = await processMarkdown(input, makeVault(), "key", false);
		expect(result).toBe("See [display text](https://example.com)");
	});
});

// ---- Comment stripping ----

describe("comment stripping", () => {
	it("strips inline comments", async () => {
		const input = "Hello %%this is hidden%% world";
		const result = await processMarkdown(input, makeVault(), "key", false);
		expect(result).toBe("Hello  world");
	});

	it("strips multi-line comments", async () => {
		const input = `Before
%%
This is a
multi-line comment
%%
After`;
		const result = await processMarkdown(input, makeVault(), "key", false);
		expect(result).toBe("Before\n\nAfter");
	});

	it("strips multiple comments in the same content", async () => {
		const input = "A %%hidden1%% B %%hidden2%% C";
		const result = await processMarkdown(input, makeVault(), "key", false);
		expect(result).toBe("A  B  C");
	});

	it("leaves content untouched when no comments", async () => {
		const input = "No comments here % just a percent sign";
		const result = await processMarkdown(input, makeVault(), "key", false);
		expect(result).toBe("No comments here % just a percent sign");
	});
});

// ---- Callout passthrough ----

describe("callout passthrough", () => {
	it("passes callout syntax through unchanged for server-side rendering", async () => {
		const input = "> [!note] My Title\n> Some content";
		const result = await processMarkdown(input, makeVault(), "key", false);
		expect(result).toBe("> [!note] My Title\n> Some content");
	});

	it("passes regular blockquotes through unchanged", async () => {
		const input = "> This is a normal blockquote";
		const result = await processMarkdown(input, makeVault(), "key", false);
		expect(result).toBe("> This is a normal blockquote");
	});
});

// ---- Tag stripping ----

describe("tag stripping", () => {
	it("strips tags when enabled", async () => {
		const input = "Some text #tag1 and #tag2";
		const result = await processMarkdown(input, makeVault(), "key", true);
		expect(result).toBe("Some text  and");
	});

	it("preserves tags when disabled", async () => {
		const input = "Some text #tag1 and #tag2";
		const result = await processMarkdown(input, makeVault(), "key", false);
		expect(result).toBe("Some text #tag1 and #tag2");
	});

	it("does not strip markdown headings", async () => {
		const input = "# Heading 1\n## Heading 2\n### Heading 3";
		const result = await processMarkdown(input, makeVault(), "key", true);
		expect(result).toBe("# Heading 1\n## Heading 2\n### Heading 3");
	});

	it("strips tags with slashes", async () => {
		const input = "Text #parent/child end";
		const result = await processMarkdown(input, makeVault(), "key", true);
		expect(result).toBe("Text  end");
	});

	it("strips tag at start of line", async () => {
		const input = "#standaloneTag";
		const result = await processMarkdown(input, makeVault(), "key", true);
		expect(result).toBe("");
	});
});

// ---- Image processing ----

describe("image processing", () => {
	beforeEach(() => {
		mockUploadImage.mockReset();
	});

	it("uploads wiki-style local images and rewrites paths", async () => {
		const imageFile = new TFile();
		imageFile.path = "attachments/photo.png";
		imageFile.name = "photo.png";
		imageFile.basename = "photo";
		imageFile.extension = "png";

		const vault = makeVault([imageFile]);
		vault.readBinary = vi.fn().mockResolvedValue(new ArrayBuffer(8));
		mockUploadImage.mockResolvedValue({ url: "https://share.jotbird.com/images/abc.png" });

		const input = "Here is an image ![[photo.png]]";
		const result = await processMarkdown(input, vault, "key", false);
		expect(result).toBe("Here is an image ![](https://share.jotbird.com/images/abc.png)");
		expect(mockUploadImage).toHaveBeenCalledWith("key", expect.any(ArrayBuffer), "photo.png", "image/png");
	});

	it("uploads wiki-style images with alt text", async () => {
		const imageFile = new TFile();
		imageFile.path = "img.jpg";
		imageFile.name = "img.jpg";
		imageFile.basename = "img";
		imageFile.extension = "jpg";

		const vault = makeVault([imageFile]);
		vault.readBinary = vi.fn().mockResolvedValue(new ArrayBuffer(8));
		mockUploadImage.mockResolvedValue({ url: "https://share.jotbird.com/images/def.jpg" });

		const input = "![[img.jpg|my alt text]]";
		const result = await processMarkdown(input, vault, "key", false);
		expect(result).toBe("![](https://share.jotbird.com/images/def.jpg)");
	});

	it("uploads standard-markdown images whose path is percent-encoded (spaces -> %20)", async () => {
		// Obsidian encodes spaces as %20 in standard-markdown links, but the vault file
		// on disk keeps literal spaces (its default "Pasted image ….png" naming). The path
		// must be URL-decoded before matching against the vault, or the image silently
		// fails to resolve and ships as a broken local reference. The file IS present here,
		// so a failure isolates the encoding mismatch (not a missing file).
		const imageFile = new TFile();
		imageFile.path = "assets/Pasted image 20260706.png";
		imageFile.name = "Pasted image 20260706.png";
		imageFile.basename = "Pasted image 20260706";
		imageFile.extension = "png";

		const vault = makeVault([imageFile]);
		vault.readBinary = vi.fn().mockResolvedValue(new ArrayBuffer(8));
		mockUploadImage.mockResolvedValue({ url: "https://share.jotbird.com/images/enc.png" });

		const input = "![](assets/Pasted%20image%2020260706.png)";
		const result = await processMarkdown(input, vault, "key", false);
		expect(mockUploadImage).toHaveBeenCalledWith("key", expect.any(ArrayBuffer), "Pasted image 20260706.png", "image/png");
		expect(result).toBe("![](https://share.jotbird.com/images/enc.png)");
	});

	it("uploads standard markdown local images and rewrites paths", async () => {
		const imageFile = new TFile();
		imageFile.path = "images/chart.png";
		imageFile.name = "chart.png";
		imageFile.basename = "chart";
		imageFile.extension = "png";

		const vault = makeVault([imageFile]);
		vault.readBinary = vi.fn().mockResolvedValue(new ArrayBuffer(8));
		mockUploadImage.mockResolvedValue({ url: "https://share.jotbird.com/images/xyz.png" });

		const input = "![My chart](images/chart.png)";
		const result = await processMarkdown(input, vault, "key", false);
		expect(result).toBe("![My chart](https://share.jotbird.com/images/xyz.png)");
	});

	it("leaves external image URLs unchanged", async () => {
		const input = "![External](https://example.com/photo.png)";
		const result = await processMarkdown(input, makeVault(), "key", false);
		expect(result).toBe("![External](https://example.com/photo.png)");
		expect(mockUploadImage).not.toHaveBeenCalled();
	});

	it("skips images that cannot be found in the vault", async () => {
		const vault = makeVault([]); // No files in vault
		const input = "![[missing.png]]";
		const result = await processMarkdown(input, vault, "key", false);
		// Image not found, so ![[missing.png]] stays, then convertWikiLinks turns it to !missing.png
		expect(result).toBe("!missing.png");
	});

	it("skips non-image wiki embeds", async () => {
		const input = "![[some-note]]";
		const result = await processMarkdown(input, makeVault(), "key", false);
		// Non-image embeds pass through image processing unchanged,
		// then convertWikiLinks converts ![[some-note]] to !some-note
		expect(result).toBe("!some-note");
	});

	it("handles upload failure gracefully", async () => {
		const imageFile = new TFile();
		imageFile.path = "fail.png";
		imageFile.name = "fail.png";
		imageFile.basename = "fail";
		imageFile.extension = "png";

		const vault = makeVault([imageFile]);
		vault.readBinary = vi.fn().mockRejectedValue(new Error("read error"));

		const input = "![[fail.png]]";
		const result = await processMarkdown(input, vault, "key", false);
		// Upload failed, so ![[fail.png]] stays, then convertWikiLinks turns it to !fail.png
		expect(result).toBe("!fail.png");
	});

	it("handles supported image extensions (webp, gif, svg)", async () => {
		const svgFile = new TFile();
		svgFile.path = "icon.svg";
		svgFile.name = "icon.svg";
		svgFile.basename = "icon";
		svgFile.extension = "svg";

		const vault = makeVault([svgFile]);
		vault.readBinary = vi.fn().mockResolvedValue(new ArrayBuffer(8));
		mockUploadImage.mockResolvedValue({ url: "https://share.jotbird.com/images/svg.svg" });

		const input = "![[icon.svg]]";
		const result = await processMarkdown(input, vault, "key", false);
		expect(result).toBe("![](https://share.jotbird.com/images/svg.svg)");
		expect(mockUploadImage).toHaveBeenCalledWith("key", expect.any(ArrayBuffer), "icon.svg", "image/svg+xml");
	});
});

// ---- Title extraction ----

describe("extractTitle", () => {
	it("extracts title from frontmatter", () => {
		const content = `---
title: My Document Title
---
# Different Heading`;
		const title = extractTitle(content, makeFile("test.md", "test"));
		expect(title).toBe("My Document Title");
	});

	it("extracts quoted title from frontmatter", () => {
		const content = `---
title: "Quoted Title"
---
Content`;
		const title = extractTitle(content, makeFile("test.md", "test"));
		expect(title).toBe("Quoted Title");
	});

	it("extracts single-quoted title from frontmatter", () => {
		const content = `---
title: 'Single Quoted'
---
Content`;
		const title = extractTitle(content, makeFile("test.md", "test"));
		expect(title).toBe("Single Quoted");
	});

	it("falls back to first H1 when no frontmatter title", () => {
		const content = `---
date: 2024-01-01
---
# My Heading
Content`;
		const title = extractTitle(content, makeFile("test.md", "test"));
		expect(title).toBe("My Heading");
	});

	it("uses first H1 when no frontmatter at all", () => {
		const content = "# First Heading\n\nSome content\n\n# Second Heading";
		const title = extractTitle(content, makeFile("test.md", "test"));
		expect(title).toBe("First Heading");
	});

	it("falls back to filename when no frontmatter title or H1", () => {
		const content = "Just some content without headings";
		const title = extractTitle(content, makeFile("notes/my-note.md", "my-note"));
		expect(title).toBe("my-note");
	});

	it("falls back to filename when frontmatter has no title field", () => {
		const content = `---
tags: [test]
---
No heading here`;
		const title = extractTitle(content, makeFile("doc.md", "doc"));
		expect(title).toBe("doc");
	});
});

// ---- Combined processing ----

describe("processMarkdown combined", () => {
	it("processes a full note with frontmatter, wiki links, comments, and tags", async () => {
		const input = `---
title: Test
tags: [a, b]
---
# Hello World

See [[Other Page|that page]] for more %%secret note%% details.

#tag1 #tag2

## Section Two

Some text with [[Simple Link]].`;

		const result = await processMarkdown(input, makeVault(), "key", true);
		// After stripping tags "#tag1 #tag2" becomes " " (trailing space from replacement),
		// then the whole result is trimmed at boundaries
		expect(result).toBe(
			"# Hello World\n\nSee that page for more  details.\n\n \n\n## Section Two\n\nSome text with Simple Link."
		);
	});

	it("trims leading and trailing whitespace", async () => {
		const input = `---
title: Test
---

  Content with spacing

`;
		const result = await processMarkdown(input, makeVault(), "key", false);
		expect(result).toBe("Content with spacing");
	});
});

// ---- applyTitleMode ----

describe("applyTitleMode", () => {
	describe("auto (default behavior preserved)", () => {
		it("injects '# title' as a heading when the body has none", () => {
			const file = makeFile("notes/My Note.md", "My Note");
			const r = applyTitleMode("auto", "Body without heading", "Body without heading", file);
			expect(r.renderTitle).toBe(false);
			expect(r.title).toBe("My Note"); // falls back to filename
			expect(r.markdown).toBe("# My Note\n\nBody without heading");
		});

		it("does not inject when the body already starts with a heading", () => {
			const file = makeFile("notes/My Note.md", "My Note");
			const r = applyTitleMode("auto", "# Real Heading\n\nText", "# Real Heading\n\nText", file);
			expect(r.renderTitle).toBe(false);
			expect(r.markdown).toBe("# Real Heading\n\nText");
		});

		it("prefers frontmatter title from raw content", () => {
			const file = makeFile("notes/x.md", "x");
			const content = "---\ntitle: FM Title\n---\nBody";
			const r = applyTitleMode("auto", "Body", content, file);
			expect(r.title).toBe("FM Title");
			expect(r.markdown).toBe("# FM Title\n\nBody");
		});
	});

	describe("filename", () => {
		it("uses the filename and renders a dedicated header; body untouched", () => {
			const file = makeFile("notes/Trial for Headings.md", "Trial for Headings");
			const r = applyTitleMode("filename", "# Heading 1\n\nText", "# Heading 1\n\nText", file);
			expect(r.renderTitle).toBe(true);
			expect(r.title).toBe("Trial for Headings");
			expect(r.markdown).toBe("# Heading 1\n\nText"); // body unchanged, not injected
		});
	});

	describe("h1", () => {
		it("pulls the first H1 as the title and removes it from the body", () => {
			const file = makeFile("notes/x.md", "x");
			const r = applyTitleMode("h1", "# Heading 1\n\nText\n\n## Heading 2", "raw", file);
			expect(r.renderTitle).toBe(true);
			expect(r.title).toBe("Heading 1");
			expect(r.markdown).toBe("Text\n\n## Heading 2"); // first H1 removed, no duplicate
		});

		it("falls back to the filename when the body has no H1", () => {
			const file = makeFile("notes/Fallback Name.md", "Fallback Name");
			const r = applyTitleMode("h1", "Just text, no heading", "raw", file);
			expect(r.renderTitle).toBe(true);
			expect(r.title).toBe("Fallback Name");
			expect(r.markdown).toBe("Just text, no heading");
		});

		it("does not treat an h2 as the title", () => {
			const file = makeFile("notes/x.md", "x");
			const r = applyTitleMode("h1", "## Only H2\n\nText", "raw", file);
			// No real H1 → falls back to filename, body untouched
			expect(r.title).toBe("x");
			expect(r.markdown).toBe("## Only H2\n\nText");
		});
	});
});
