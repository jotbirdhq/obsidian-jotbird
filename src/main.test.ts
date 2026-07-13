import { describe, it, expect, vi, beforeEach } from "vitest";
import { TFile, MarkdownView, Notice, requestUrl } from "obsidian";
import JotBirdPlugin from "./main";
import type { PluginData, PublishedNote } from "./types";

// Mock the API module
vi.mock("./api", () => ({
	publishNote: vi.fn(),
	trialPublish: vi.fn(),
	listDocuments: vi.fn(),
	deleteDocument: vi.fn(),
	trialDeleteDocument: vi.fn(),
	claimDocument: vi.fn(),
	uploadImage: vi.fn(),
	getPageSettings: vi.fn(),
	updatePageSettings: vi.fn(),
	setClientVersion: vi.fn(),
}));

// Mock the modals module
vi.mock("./modals", () => ({
	ConfirmModal: vi.fn().mockImplementation((_app: unknown, _msg: string, onConfirm: () => void) => ({
		open: () => onConfirm(),
		close: vi.fn(),
	})),
	DocumentListModal: vi.fn().mockImplementation(() => ({
		open: vi.fn(),
		close: vi.fn(),
	})),
	PageSettingsModal: vi.fn().mockImplementation(() => ({
		open: vi.fn(),
		close: vi.fn(),
	})),
}));

import { publishNote, trialPublish, listDocuments, deleteDocument, trialDeleteDocument, claimDocument, getPageSettings } from "./api";
import { DocumentListModal, PageSettingsModal } from "./modals";

const mockPublishNote = vi.mocked(publishNote);
const mockTrialPublish = vi.mocked(trialPublish);
const mockListDocuments = vi.mocked(listDocuments);
const mockDeleteDocument = vi.mocked(deleteDocument);
const mockTrialDeleteDocument = vi.mocked(trialDeleteDocument);
const mockClaimDocument = vi.mocked(claimDocument);
const mockGetPageSettings = vi.mocked(getPageSettings);
const mockNotice = vi.mocked(Notice);

function makeFile(path: string, basename?: string): TFile {
	const file = new TFile();
	file.path = path;
	file.name = basename ? `${basename}.md` : path.split("/").pop()!;
	file.basename = basename ?? file.name.replace(/\.[^.]+$/, "");
	file.extension = "md";
	return file;
}

function createPlugin(initialData?: Partial<PluginData>): JotBirdPlugin {
	const plugin = new JotBirdPlugin();
	if (initialData) {
		(plugin as unknown as { _setData(d: unknown): void })._setData(initialData);
	}
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
});

// ---- Settings persistence ----

describe("settings persistence", () => {
	it("loads default settings when no data exists", async () => {
		const plugin = createPlugin();
		await plugin.loadSettings();

		expect(plugin.settings.apiKey).toBe("");
		expect(plugin.settings.stripTags).toBe(true);
		expect(plugin.settings.autoCopyLink).toBe(true);
		expect(plugin.publishedNotes).toEqual({});
	});

	it("loads saved settings from data", async () => {
		const plugin = createPlugin({
			settings: {
				apiKey: "jb_saved_key",
				stripTags: false,
				autoCopyLink: false,
			},
			publishedNotes: {
				"notes/test.md": {
					slug: "my-slug",
					url: "https://share.jotbird.com/my-slug",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		await plugin.loadSettings();

		expect(plugin.settings.apiKey).toBe("jb_saved_key");
		expect(plugin.settings.stripTags).toBe(false);
		expect(plugin.settings.autoCopyLink).toBe(false);
		expect(plugin.publishedNotes["notes/test.md"].slug).toBe("my-slug");
	});

	it("merges partial settings with defaults", async () => {
		const plugin = createPlugin({
			settings: {
				apiKey: "jb_key",
				// stripTags and autoCopyLink not provided
			} as PluginData["settings"],
		});
		await plugin.loadSettings();

		expect(plugin.settings.apiKey).toBe("jb_key");
		expect(plugin.settings.stripTags).toBe(true); // default
		expect(plugin.settings.autoCopyLink).toBe(true); // default
	});

	it("saves settings and published notes together", async () => {
		const plugin = createPlugin();
		await plugin.loadSettings();

		plugin.settings.apiKey = "jb_new_key";
		plugin.publishedNotes["test.md"] = {
			slug: "test-slug",
			url: "https://share.jotbird.com/test-slug",
			publishedAt: "2026-01-01T00:00:00.000Z",
		};

		await plugin.saveSettings();

		// Load again to verify persistence
		await plugin.loadSettings();
		expect(plugin.settings.apiKey).toBe("jb_new_key");
		expect(plugin.publishedNotes["test.md"].slug).toBe("test-slug");
	});
});

// ---- onload registration ----

describe("onload", () => {
	it("registers ribbon icon, commands, event handlers, and settings tab", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.onload();

		expect(plugin.addRibbonIcon).toHaveBeenCalledWith("jotbird", "Publish note", expect.any(Function));
		expect(plugin.addCommand).toHaveBeenCalledTimes(6);
		expect(plugin.addSettingTab).toHaveBeenCalledOnce();
		// 4 registerEvent calls: file-menu, active-leaf-change, vault.rename, vault.delete
		expect(plugin.registerEvent).toHaveBeenCalledTimes(4);

		// Verify command IDs
		const commandIds = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.map(
			(call: unknown[]) => (call[0] as { id: string }).id
		);
		expect(commandIds).toContain("publish-current-note");
		expect(commandIds).toContain("copy-link");
		expect(commandIds).toContain("unpublish-current-note");
		expect(commandIds).toContain("list-published-documents");
		expect(commandIds).toContain("page-settings");
		expect(commandIds).toContain("pull-page-settings");
	});

	it("registers frontmatter property types with metadataTypeManager", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.onload();

		const mtm = (plugin.app as unknown as Record<string, unknown>).metadataTypeManager as
			| { setType: ReturnType<typeof vi.fn> }
			| undefined;
		expect(mtm?.setType).toHaveBeenCalledWith("jotbird_link", "text");
		expect(mtm?.setType).toHaveBeenCalledWith("jotbird_expires", "text");
		expect(mtm?.setType).toHaveBeenCalledWith("jotbird_theme", "text");
		expect(mtm?.setType).toHaveBeenCalledWith("jotbird_hide_branding", "checkbox");
	});
});

// ---- publishFile ----

describe("publishFile", () => {
	it("publishes a new note and stores mapping", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		const file = makeFile("notes/hello.md", "hello");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Hello World\n\nSome content");

		mockPublishNote.mockResolvedValue({
			slug: "bright-calm-meadow",
			url: "https://share.jotbird.com/bright-calm-meadow",
			title: "Hello World",
			expiresAt: "2026-05-10T12:00:00.000Z",
			ttlDays: 90,
			created: true,
		});

		await plugin.publishFile(file);

		expect(mockPublishNote).toHaveBeenCalledWith(
			"jb_key",
			"# Hello World\n\nSome content",
			"Hello World",
			undefined, // no existing slug
			undefined, // no existing documentId
			false, // auto title mode → no dedicated header
			undefined // no settings frontmatter / vault defaults
		);

		const stored = plugin.publishedNotes["notes/hello.md"];
		expect(stored).toBeDefined();
		expect(stored.slug).toBe("bright-calm-meadow");
		expect(stored.url).toBe("https://share.jotbird.com/bright-calm-meadow");
	});

	it("updates an existing note using the stored slug", async () => {
		const existingNote: PublishedNote = {
			slug: "my-existing-doc",
			url: "https://share.jotbird.com/my-existing-doc",
			publishedAt: "2026-01-01T00:00:00.000Z",
		};

		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false },
			publishedNotes: { "notes/update.md": existingNote },
		});
		await plugin.loadSettings();

		const file = makeFile("notes/update.md", "update");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Updated content");

		mockPublishNote.mockResolvedValue({
			slug: "my-existing-doc",
			url: "https://share.jotbird.com/my-existing-doc",
			title: "Updated content",
			expiresAt: "2026-06-10T12:00:00.000Z",
			ttlDays: 90,
			created: false,
		});

		await plugin.publishFile(file);

		expect(mockPublishNote).toHaveBeenCalledWith(
			"jb_key",
			"# Updated content",
			"Updated content",
			"my-existing-doc", // existing slug passed
			undefined, // no existing documentId
			false, // auto title mode
			undefined // no settings frontmatter / vault defaults
		);
	});

	it("forwards the stored documentId and persists the server-resolved slug after a web-app rename", async () => {
		const existingNote: PublishedNote = {
			documentId: "doc-uuid-abc",
			slug: "old-slug",
			url: "https://share.jotbird.com/old-slug",
			publishedAt: "2026-01-01T00:00:00.000Z",
		};

		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false },
			publishedNotes: { "notes/doc.md": existingNote },
			proRefreshDone: true, // skip the Pro-expiry refresh branch (ttlDays:null would trigger it)
		});
		await plugin.loadSettings();

		const file = makeFile("notes/doc.md", "doc");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Updated content");

		// The slug was changed in the web app; the server resolves the documentId to its
		// CURRENT namespaced slug and returns that.
		mockPublishNote.mockResolvedValue({
			documentId: "doc-uuid-abc",
			slug: "new-namespaced-slug",
			username: "matt",
			url: "https://share.jotbird.com/@matt/new-namespaced-slug",
			title: "Updated content",
			expiresAt: null,
			ttlDays: null,
			created: false,
		});

		await plugin.publishFile(file);

		// documentId is forwarded as the authoritative 5th arg
		expect(mockPublishNote).toHaveBeenCalledWith(
			"jb_key",
			"# Updated content",
			"Updated content",
			"old-slug",
			"doc-uuid-abc",
			false, // auto title mode
			undefined // no settings frontmatter / vault defaults
		);

		// Stored mapping keeps the documentId and adopts the server's current slug/url
		const stored = plugin.publishedNotes["notes/doc.md"];
		expect(stored.documentId).toBe("doc-uuid-abc");
		expect(stored.slug).toBe("new-namespaced-slug");
		expect(stored.url).toBe("https://share.jotbird.com/@matt/new-namespaced-slug");
	});

	it("uses trial publish when no API key is set", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: false },
			publishedNotes: {},
			deviceFingerprint: "fp_test123",
		});
		await plugin.loadSettings();

		const file = makeFile("test.md", "test");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Trial Note\n\nContent");

		mockTrialPublish.mockResolvedValue({
			slug: "trial-note",
			url: "https://share.jotbird.com/trial-note",
			title: "Trial Note",
			expiresAt: "2026-03-17T12:00:00.000Z",
			ttlDays: 30,
			created: true,
			editToken: "tok_edit123",
		});

		await plugin.publishFile(file);

		expect(mockPublishNote).not.toHaveBeenCalled();
		expect(mockTrialPublish).toHaveBeenCalledWith(
			"fp_test123",
			"# Trial Note\n\nContent",
			"Trial Note",
			undefined,
			undefined,
			false // auto title mode; trial publishes never carry page settings
		);

		const stored = plugin.publishedNotes["test.md"];
		expect(stored).toBeDefined();
		expect(stored.slug).toBe("trial-note");
		expect(stored.editToken).toBe("tok_edit123");
	});

	it("ignores a re-entrant publish of the same file while one is in flight", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		const file = makeFile("notes/dupe.md", "dupe");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Dupe\n\nContent");

		// Hold the publish open so the second call lands while the first is in flight.
		let resolvePublish!: (v: Awaited<ReturnType<typeof publishNote>>) => void;
		mockPublishNote.mockReturnValue(
			new Promise((resolve) => {
				resolvePublish = resolve;
			})
		);

		const first = plugin.publishFile(file);
		const second = plugin.publishFile(file); // re-entrant: should be a no-op

		resolvePublish({
			slug: "gentle-stellar-hawk",
			url: "https://share.jotbird.com/gentle-stellar-hawk",
			title: "Dupe",
			expiresAt: "2026-08-26T12:00:00.000Z",
			ttlDays: 90,
			created: true,
		});
		await Promise.all([first, second]);

		// Only one network publish should have fired — no duplicate page.
		expect(mockPublishNote).toHaveBeenCalledTimes(1);
		expect(plugin.publishedNotes["notes/dupe.md"].slug).toBe("gentle-stellar-hawk");

		// Lock is released, so a later publish goes through normally.
		mockPublishNote.mockResolvedValue({
			slug: "gentle-stellar-hawk",
			url: "https://share.jotbird.com/gentle-stellar-hawk",
			title: "Dupe",
			expiresAt: "2026-08-26T12:00:00.000Z",
			ttlDays: 90,
			created: false,
		});
		await plugin.publishFile(file);
		expect(mockPublishNote).toHaveBeenCalledTimes(2);
	});

	it("prepends filename as H1 when content has no heading", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		const file = makeFile("notes/My Vacation.md", "My Vacation");
		plugin.app.vault.read = vi.fn().mockResolvedValue("Just some content without a heading");

		mockPublishNote.mockResolvedValue({
			slug: "my-vacation",
			url: "https://share.jotbird.com/my-vacation",
			title: "My Vacation",
			expiresAt: "2026-05-10T12:00:00.000Z",
			ttlDays: 90,
			created: true,
		});

		await plugin.publishFile(file);

		expect(mockPublishNote).toHaveBeenCalledWith(
			"jb_key",
			"# My Vacation\n\nJust some content without a heading",
			"My Vacation",
			undefined,
			undefined,
			false, // auto title mode
			undefined // no settings frontmatter / vault defaults
		);
	});

	it("uses frontmatter title for H1 when available", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		const file = makeFile("notes/draft-1.md", "draft-1");
		plugin.app.vault.read = vi.fn().mockResolvedValue("---\ntitle: My Document Title\n---\nSome content");

		mockPublishNote.mockResolvedValue({
			slug: "my-doc",
			url: "https://share.jotbird.com/my-doc",
			title: "My Document Title",
			expiresAt: "2026-05-10T12:00:00.000Z",
			ttlDays: 90,
			created: true,
		});

		await plugin.publishFile(file);

		expect(mockPublishNote).toHaveBeenCalledWith(
			"jb_key",
			"# My Document Title\n\nSome content",
			"My Document Title",
			undefined,
			undefined,
			false, // auto title mode
			undefined // no settings frontmatter / vault defaults
		);
	});

	it("does not prepend H1 when content already has one", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		const file = makeFile("notes/hello.md", "hello");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# My Custom Title\n\nContent here");

		mockPublishNote.mockResolvedValue({
			slug: "hello",
			url: "https://share.jotbird.com/hello",
			title: "My Custom Title",
			expiresAt: "2026-05-10T12:00:00.000Z",
			ttlDays: 90,
			created: true,
		});

		await plugin.publishFile(file);

		expect(mockPublishNote).toHaveBeenCalledWith(
			"jb_key",
			"# My Custom Title\n\nContent here",
			"My Custom Title",
			undefined,
			undefined,
			false, // auto title mode
			undefined // no settings frontmatter / vault defaults
		);
	});

	it("titleMode 'filename' sends renderTitle and does not inject a body heading", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false, titleMode: "filename" } as PluginData["settings"],
			publishedNotes: {},
		});
		await plugin.loadSettings();

		const file = makeFile("notes/Trial for Headings.md", "Trial for Headings");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Heading 1\n\nText");

		mockPublishNote.mockResolvedValue({
			slug: "trial-for-headings",
			url: "https://share.jotbird.com/trial-for-headings",
			title: "Trial for Headings",
			expiresAt: null,
			ttlDays: null,
			created: true,
		});

		await plugin.publishFile(file);

		expect(mockPublishNote).toHaveBeenCalledWith(
			"jb_key",
			"# Heading 1\n\nText", // body NOT modified — no injected filename heading
			"Trial for Headings", // filename used as the page title
			undefined,
			undefined,
			true, // renderTitle on
			undefined // no settings frontmatter / vault defaults
		);
	});

	it("titleMode 'h1' lifts the first heading into the title and removes it from the body", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false, titleMode: "h1" } as PluginData["settings"],
			publishedNotes: {},
		});
		await plugin.loadSettings();

		const file = makeFile("notes/x.md", "x");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Heading 1\n\nText");

		mockPublishNote.mockResolvedValue({
			slug: "x",
			url: "https://share.jotbird.com/x",
			title: "Heading 1",
			expiresAt: null,
			ttlDays: null,
			created: true,
		});

		await plugin.publishFile(file);

		expect(mockPublishNote).toHaveBeenCalledWith(
			"jb_key",
			"Text", // first H1 pulled out of the body
			"Heading 1",
			undefined,
			undefined,
			true,
			undefined // no settings frontmatter / vault defaults
		);
	});

	it("handles API errors gracefully", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		const file = makeFile("test.md");
		plugin.app.vault.read = vi.fn().mockResolvedValue("content");
		mockPublishNote.mockRejectedValue(new Error("Publish: Rate limit exceeded"));

		// Should not throw
		await plugin.publishFile(file);

		// Should not have stored anything
		expect(plugin.publishedNotes["test.md"]).toBeUndefined();
	});

	it("retries as fresh publish when update returns 404 (expired page)", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false, storeFrontmatter: true },
			publishedNotes: {
				"notes/expired.md": {
					slug: "old-expired-slug",
					url: "https://share.jotbird.com/old-expired-slug",
					publishedAt: "2025-12-01T00:00:00.000Z",
				},
			},
		});
		await plugin.loadSettings();

		const file = makeFile("notes/expired.md", "expired");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Expired Note\n\nContent");

		// First call (update attempt) returns 404
		mockPublishNote
			.mockRejectedValueOnce(new Error("Publish: Document not found"))
			.mockResolvedValueOnce({
				slug: "fresh-new-slug",
				url: "https://share.jotbird.com/fresh-new-slug",
				title: "Expired Note",
				expiresAt: "2026-05-18T12:00:00.000Z",
				ttlDays: 90,
				created: true,
			});

		const written: Record<string, unknown> = {};
		plugin.app.fileManager.processFrontMatter = vi.fn().mockImplementation(
			async (_f: TFile, fn: (fm: Record<string, unknown>) => void) => {
				fn(written);
			}
		);

		await plugin.publishFile(file);

		// First call: update attempt with old slug
		expect(mockPublishNote).toHaveBeenCalledTimes(2);
		expect(mockPublishNote.mock.calls[0]).toEqual([
			"jb_key", "# Expired Note\n\nContent", "Expired Note", "old-expired-slug", undefined, false, undefined,
		]);
		// Second call: fresh publish without slug
		expect(mockPublishNote.mock.calls[1]).toEqual([
			"jb_key", "# Expired Note\n\nContent", "Expired Note", undefined, undefined, false, undefined,
		]);

		// data.json updated with new slug
		const stored = plugin.publishedNotes["notes/expired.md"];
		expect(stored.slug).toBe("fresh-new-slug");
		expect(stored.url).toBe("https://share.jotbird.com/fresh-new-slug");

		// Frontmatter updated with new URL
		expect(written["jotbird_link"]).toBe("https://share.jotbird.com/fresh-new-slug");
	});

	it("retries trial publish as fresh when update returns 404", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: false, storeFrontmatter: true },
			publishedNotes: {
				"notes/expired-trial.md": {
					slug: "old-trial-slug",
					url: "https://share.jotbird.com/old-trial-slug",
					editToken: "tok_old",
					publishedAt: "2025-12-01T00:00:00.000Z",
				},
			},
			deviceFingerprint: "fp_test",
		});
		await plugin.loadSettings();

		const file = makeFile("notes/expired-trial.md", "expired-trial");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Trial Expired\n\nContent");

		mockTrialPublish
			.mockRejectedValueOnce(new Error("Publish: Document not found"))
			.mockResolvedValueOnce({
				slug: "new-trial-slug",
				url: "https://share.jotbird.com/new-trial-slug",
				title: "Trial Expired",
				expiresAt: "2026-03-18T12:00:00.000Z",
				ttlDays: 30,
				created: true,
				editToken: "tok_new",
			});

		await plugin.publishFile(file);

		// First call: update with old slug and editToken
		expect(mockTrialPublish).toHaveBeenCalledTimes(2);
		expect(mockTrialPublish.mock.calls[0]).toEqual([
			"fp_test", "# Trial Expired\n\nContent", "Trial Expired", "old-trial-slug", "tok_old", false,
		]);
		// Second call: fresh publish without slug/editToken
		expect(mockTrialPublish.mock.calls[1]).toEqual([
			"fp_test", "# Trial Expired\n\nContent", "Trial Expired", undefined, undefined, false,
		]);

		const stored = plugin.publishedNotes["notes/expired-trial.md"];
		expect(stored.slug).toBe("new-trial-slug");
		expect(stored.editToken).toBe("tok_new");
	});

	it("does not retry on non-404 errors", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false },
			publishedNotes: {
				"notes/fail.md": {
					slug: "existing-slug",
					url: "https://share.jotbird.com/existing-slug",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		await plugin.loadSettings();

		const file = makeFile("notes/fail.md", "fail");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Content");
		mockPublishNote.mockRejectedValue(new Error("Publish: Rate limit exceeded"));

		await plugin.publishFile(file);

		// Should only have been called once (no retry)
		expect(mockPublishNote).toHaveBeenCalledTimes(1);
		// Old mapping should remain unchanged
		expect(plugin.publishedNotes["notes/fail.md"].slug).toBe("existing-slug");
	});

	// ---- Anonymous → account transition (claim-at-publish) ----
	// Repro: a note published anonymously (trial) carries an editToken. The user later
	// adds an API key, so publishFile switches to the account path. Without claiming
	// first, cli/publish 403s ("Document not owned by user"). The fix claims it first.

	it("claims an anonymous note before publishing once an API key is present", async () => {
		const anon: PublishedNote = {
			slug: "gentle-shimmering-dunefield",
			url: "https://share.jotbird.com/gentle-shimmering-dunefield",
			editToken: "tok_anon_123",
			publishedAt: "2026-06-05T04:59:00.000Z",
		};
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false },
			publishedNotes: { "notes/anon.md": anon },
		});
		await plugin.loadSettings();

		const file = makeFile("notes/anon.md", "anon");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Updated body");

		mockClaimDocument.mockResolvedValue({
			ok: true,
			slug: "gentle-shimmering-dunefield",
			url: "https://share.jotbird.com/gentle-shimmering-dunefield",
			expiresAt: null,
			ttlDays: null,
		});
		mockPublishNote.mockResolvedValue({
			slug: "gentle-shimmering-dunefield",
			url: "https://share.jotbird.com/gentle-shimmering-dunefield",
			title: "Updated body",
			expiresAt: null,
			ttlDays: null,
			created: false,
		});

		await plugin.publishFile(file);

		// Claimed first, with the stored slug + editToken...
		expect(mockClaimDocument).toHaveBeenCalledWith("jb_key", "gentle-shimmering-dunefield", "tok_anon_123");
		// ...then published via the account path.
		expect(mockPublishNote).toHaveBeenCalledTimes(1);
		expect(mockTrialPublish).not.toHaveBeenCalled();
		// Claim must happen before publish.
		expect(mockClaimDocument.mock.invocationCallOrder[0])
			.toBeLessThan(mockPublishNote.mock.invocationCallOrder[0]);
		// Publish uses the now-account-owned slug from the claim, with no stale documentId.
		expect(mockPublishNote).toHaveBeenCalledWith(
			"jb_key",
			expect.any(String),
			expect.any(String),
			"gentle-shimmering-dunefield",
			undefined,
			false,
			undefined // no settings frontmatter / vault defaults
		);
		// Local record is now account-owned: editToken dropped.
		expect(plugin.publishedNotes["notes/anon.md"].editToken).toBeUndefined();
	});

	it("does NOT claim when the note is already account-owned (no editToken)", async () => {
		const owned: PublishedNote = {
			slug: "my-owned-doc",
			url: "https://share.jotbird.com/my-owned-doc",
			publishedAt: "2026-01-01T00:00:00.000Z",
		};
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false },
			publishedNotes: { "notes/owned.md": owned },
		});
		await plugin.loadSettings();

		const file = makeFile("notes/owned.md", "owned");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Body");
		mockPublishNote.mockResolvedValue({
			slug: "my-owned-doc",
			url: "https://share.jotbird.com/my-owned-doc",
			title: "Body",
			expiresAt: null,
			ttlDays: null,
			created: false,
		});

		await plugin.publishFile(file);

		expect(mockClaimDocument).not.toHaveBeenCalled();
		expect(mockPublishNote).toHaveBeenCalledTimes(1);
	});

	it("does NOT claim an anonymous note when there is no API key (stays on the trial path)", async () => {
		const anon: PublishedNote = {
			slug: "anon-slug",
			url: "https://share.jotbird.com/anon-slug",
			editToken: "tok_anon",
			publishedAt: "2026-06-05T04:59:00.000Z",
		};
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: false },
			publishedNotes: { "notes/anon.md": anon },
			deviceFingerprint: "fp_test",
		});
		await plugin.loadSettings();

		const file = makeFile("notes/anon.md", "anon");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Body");
		mockTrialPublish.mockResolvedValue({
			slug: "anon-slug",
			url: "https://share.jotbird.com/anon-slug",
			title: "Body",
			expiresAt: "2026-07-05T00:00:00.000Z",
			ttlDays: 30,
			created: false,
			editToken: "tok_anon",
		});

		await plugin.publishFile(file);

		expect(mockClaimDocument).not.toHaveBeenCalled();
		expect(mockTrialPublish).toHaveBeenCalledWith(
			"fp_test", "# Body", "Body", "anon-slug", "tok_anon", false
		);
	});

	it("falls through to publish if the claim fails (does not throw, still publishes)", async () => {
		const anon: PublishedNote = {
			slug: "anon-slug",
			url: "https://share.jotbird.com/anon-slug",
			editToken: "tok_anon",
			publishedAt: "2026-06-05T04:59:00.000Z",
		};
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false },
			publishedNotes: { "notes/anon.md": anon },
		});
		await plugin.loadSettings();

		const file = makeFile("notes/anon.md", "anon");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Body");
		mockClaimDocument.mockRejectedValue(new Error("Claim: transient failure"));
		mockPublishNote.mockResolvedValue({
			slug: "anon-slug",
			url: "https://share.jotbird.com/anon-slug",
			title: "Body",
			expiresAt: null,
			ttlDays: null,
			created: false,
		});

		await expect(plugin.publishFile(file)).resolves.toBeUndefined();
		expect(mockClaimDocument).toHaveBeenCalledTimes(1);
		expect(mockPublishNote).toHaveBeenCalledTimes(1);
	});
});

// ---- File rename tracking ----

describe("file rename tracking", () => {
	it("updates published note mapping when a file is renamed", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {
				"old/path.md": {
					slug: "my-doc",
					url: "https://share.jotbird.com/my-doc",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		await plugin.onload();

		// Find the rename handler that was registered
		const registerEventCalls = (plugin.registerEvent as ReturnType<typeof vi.fn>).mock.calls;

		// The vault.on('rename') call — we need to get the callback from vault.on
		const vaultOnCalls = (plugin.app.vault.on as ReturnType<typeof vi.fn>).mock.calls;
		const renameCall = vaultOnCalls.find((call: unknown[]) => call[0] === "rename");
		expect(renameCall).toBeDefined();

		const renameHandler = renameCall![1] as (file: TFile, oldPath: string) => void;

		// Simulate a file rename
		const renamedFile = makeFile("new/path.md", "path");
		renameHandler(renamedFile, "old/path.md");

		expect(plugin.publishedNotes["new/path.md"]).toBeDefined();
		expect(plugin.publishedNotes["new/path.md"].slug).toBe("my-doc");
		expect(plugin.publishedNotes["old/path.md"]).toBeUndefined();
	});

	it("does nothing for renames of unpublished files", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.onload();

		const vaultOnCalls = (plugin.app.vault.on as ReturnType<typeof vi.fn>).mock.calls;
		const renameCall = vaultOnCalls.find((call: unknown[]) => call[0] === "rename");
		const renameHandler = renameCall![1] as (file: TFile, oldPath: string) => void;

		const renamedFile = makeFile("new/path.md", "path");
		renameHandler(renamedFile, "old/path.md");

		expect(Object.keys(plugin.publishedNotes)).toHaveLength(0);
	});
});

// ---- File delete tracking ----

describe("file delete tracking", () => {
	it("removes published note mapping when a file is deleted", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {
				"notes/deleted.md": {
					slug: "deleted-doc",
					url: "https://share.jotbird.com/deleted-doc",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		await plugin.onload();

		const vaultOnCalls = (plugin.app.vault.on as ReturnType<typeof vi.fn>).mock.calls;
		const deleteCall = vaultOnCalls.find((call: unknown[]) => call[0] === "delete");
		expect(deleteCall).toBeDefined();

		const deleteHandler = deleteCall![1] as (file: TFile) => void;

		const deletedFile = makeFile("notes/deleted.md", "deleted");
		deleteHandler(deletedFile);

		expect(plugin.publishedNotes["notes/deleted.md"]).toBeUndefined();
	});

	it("does nothing for deletions of unpublished files", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {
				"notes/other.md": {
					slug: "other",
					url: "https://share.jotbird.com/other",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		await plugin.onload();

		const vaultOnCalls = (plugin.app.vault.on as ReturnType<typeof vi.fn>).mock.calls;
		const deleteCall = vaultOnCalls.find((call: unknown[]) => call[0] === "delete");
		const deleteHandler = deleteCall![1] as (file: TFile) => void;

		const deletedFile = makeFile("notes/unrelated.md", "unrelated");
		deleteHandler(deletedFile);

		// The other published note should still be there
		expect(plugin.publishedNotes["notes/other.md"]).toBeDefined();
	});
});

// ---- Command checks ----

describe("command availability", () => {
	it("publish command is available when a markdown file is active", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.onload();

		const view = new MarkdownView();
		view.file = makeFile("test.md");
		plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(view);

		const publishCmd = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.find(
			(call: unknown[]) => (call[0] as { id: string }).id === "publish-current-note"
		);
		const checkCallback = (publishCmd![0] as { checkCallback: (checking: boolean) => boolean }).checkCallback;

		expect(checkCallback(true)).toBe(true);
	});

	it("publish command falls back to getActiveFile when view is not MarkdownView", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.onload();

		const file = makeFile("note.md", "note");
		plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(null);
		plugin.app.workspace.getActiveFile = vi.fn().mockReturnValue(file);

		const publishCmd = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.find(
			(call: unknown[]) => (call[0] as { id: string }).id === "publish-current-note"
		);
		const checkCallback = (publishCmd![0] as { checkCallback: (checking: boolean) => boolean }).checkCallback;

		expect(checkCallback(true)).toBe(true);
	});

	it("publish command is unavailable when no markdown file is active", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.onload();

		plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(null);
		plugin.app.workspace.getActiveFile = vi.fn().mockReturnValue(null);

		const publishCmd = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.find(
			(call: unknown[]) => (call[0] as { id: string }).id === "publish-current-note"
		);
		const checkCallback = (publishCmd![0] as { checkCallback: (checking: boolean) => boolean }).checkCallback;

		expect(checkCallback(true)).toBe(false);
	});

	it("copy-link command is only available for published notes", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {
				"published.md": {
					slug: "my-doc",
					url: "https://share.jotbird.com/my-doc",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		await plugin.onload();

		const copyCmd = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.find(
			(call: unknown[]) => (call[0] as { id: string }).id === "copy-link"
		);
		const checkCallback = (copyCmd![0] as { checkCallback: (checking: boolean) => boolean }).checkCallback;

		// Published note - should be available
		const view = new MarkdownView();
		view.file = makeFile("published.md", "published");
		plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(view);
		expect(checkCallback(true)).toBe(true);

		// Unpublished note - should not be available
		view.file = makeFile("unpublished.md", "unpublished");
		expect(checkCallback(true)).toBe(false);
	});

	it("unpublish command is only available for published notes", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {
				"published.md": {
					slug: "my-doc",
					url: "https://share.jotbird.com/my-doc",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		await plugin.onload();

		const unpublishCmd = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.find(
			(call: unknown[]) => (call[0] as { id: string }).id === "unpublish-current-note"
		);
		const checkCallback = (unpublishCmd![0] as { checkCallback: (checking: boolean) => boolean }).checkCallback;

		// Published note
		const view = new MarkdownView();
		view.file = makeFile("published.md", "published");
		plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(view);
		expect(checkCallback(true)).toBe(true);

		// Unpublished note
		view.file = makeFile("other.md", "other");
		expect(checkCallback(true)).toBe(false);
	});
});

// ---- List documents ----

describe("list documents", () => {
	it("fetches and displays documents in a modal", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.onload();

		mockListDocuments.mockResolvedValue({
			documents: [
				{
					slug: "doc-1",
					title: "First Doc",
					url: "https://share.jotbird.com/doc-1",
					source: "api",
					updatedAt: "2026-01-01T00:00:00.000Z",
					expiresAt: "2026-04-01T00:00:00.000Z",
				},
			],
		});

		const listCmd = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.find(
			(call: unknown[]) => (call[0] as { id: string }).id === "list-published-documents"
		);
		const callback = (listCmd![0] as { callback: () => void }).callback;

		await callback();

		// Wait for the async operation
		await vi.waitFor(() => {
			expect(mockListDocuments).toHaveBeenCalledWith("jb_key");
			expect(DocumentListModal).toHaveBeenCalled();
		});
	});
});

// ---- Unpublish flow ----

describe("unpublish", () => {
	it("calls delete API and removes mapping after confirmation", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {
				"notes/remove.md": {
					documentId: "remove-doc-id",
					slug: "remove-doc",
					url: "https://share.jotbird.com/remove-doc",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		await plugin.onload();

		mockDeleteDocument.mockResolvedValue({ ok: true });

		const view = new MarkdownView();
		view.file = makeFile("notes/remove.md", "remove");
		plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(view);

		const unpublishCmd = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.find(
			(call: unknown[]) => (call[0] as { id: string }).id === "unpublish-current-note"
		);
		const checkCallback = (unpublishCmd![0] as { checkCallback: (checking: boolean) => boolean }).checkCallback;

		// Execute (not just check)
		checkCallback(false);

		await vi.waitFor(() => {
			expect(mockDeleteDocument).toHaveBeenCalledWith("jb_key", "remove-doc", "remove-doc-id");
		});

		await vi.waitFor(() => {
			expect(plugin.publishedNotes["notes/remove.md"]).toBeUndefined();
		});
	});

	it("uses trialDeleteDocument when no API key is set", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: true },
			publishedNotes: {
				"notes/trial-remove.md": {
					slug: "trial-doc",
					url: "https://share.jotbird.com/trial-doc",
					editToken: "tok_edit456",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
			deviceFingerprint: "fp_test123",
		});
		await plugin.onload();

		mockTrialDeleteDocument.mockResolvedValue({ ok: true });

		const view = new MarkdownView();
		view.file = makeFile("notes/trial-remove.md", "trial-remove");
		plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(view);

		const unpublishCmd = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.find(
			(call: unknown[]) => (call[0] as { id: string }).id === "unpublish-current-note"
		);
		const checkCallback = (unpublishCmd![0] as { checkCallback: (checking: boolean) => boolean }).checkCallback;

		checkCallback(false);

		await vi.waitFor(() => {
			expect(mockTrialDeleteDocument).toHaveBeenCalledWith("trial-doc", "tok_edit456", "fp_test123");
		});

		await vi.waitFor(() => {
			expect(plugin.publishedNotes["notes/trial-remove.md"]).toBeUndefined();
		});
	});
});

// ---- Unauthenticated publishing ----

describe("unauthenticated publishing", () => {
	it("updates a previously-published note with slug and editToken", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: false },
			publishedNotes: {
				"notes/existing-trial.md": {
					slug: "trial-existing",
					url: "https://share.jotbird.com/trial-existing",
					editToken: "tok_edit789",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
			deviceFingerprint: "fp_test123",
		});
		await plugin.loadSettings();

		const file = makeFile("notes/existing-trial.md", "existing-trial");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Updated content");

		mockTrialPublish.mockResolvedValue({
			slug: "trial-existing",
			url: "https://share.jotbird.com/trial-existing",
			title: "Updated content",
			expiresAt: "2026-03-17T12:00:00.000Z",
			ttlDays: 30,
			created: false,
			editToken: "tok_edit789",
		});

		await plugin.publishFile(file);

		expect(mockTrialPublish).toHaveBeenCalledWith(
			"fp_test123",
			"# Updated content",
			"Updated content",
			"trial-existing",
			"tok_edit789",
			false // auto title mode
		);
	});

	it("generates deviceFingerprint on first load and persists it", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		expect(plugin.deviceFingerprint).toBeTruthy();
		expect(typeof plugin.deviceFingerprint).toBe("string");

		// Save and reload - should persist the same fingerprint
		await plugin.saveSettings();
		const fingerprint = plugin.deviceFingerprint;
		await plugin.loadSettings();
		expect(plugin.deviceFingerprint).toBe(fingerprint);
	});
});

// ---- Frontmatter on publish ----

describe("frontmatter on publish", () => {
	it("writes jotbird_link and jotbird_expires after publishing", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false, storeFrontmatter: true },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		const file = makeFile("notes/fm.md", "fm");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Test\n\nContent");

		mockPublishNote.mockResolvedValue({
			slug: "fm-test",
			url: "https://share.jotbird.com/fm-test",
			title: "Test",
			expiresAt: "2026-05-10T12:00:00.000Z",
			ttlDays: 90,
			created: true,
		});

		const written: Record<string, unknown> = {};
		plugin.app.fileManager.processFrontMatter = vi.fn().mockImplementation(
			async (_f: TFile, fn: (fm: Record<string, unknown>) => void) => {
				fn(written);
			}
		);

		await plugin.publishFile(file);

		expect(plugin.app.fileManager.processFrontMatter).toHaveBeenCalledWith(
			file,
			expect.any(Function)
		);
		expect(written["jotbird_link"]).toBe("https://share.jotbird.com/fm-test");
		expect(written["jotbird_expires"]).toBe("2026-05-10");
		// Old properties should not be written
		expect(written["jotbird_url"]).toBeUndefined();
		expect(written["jotbird_slug"]).toBeUndefined();
		expect(written["jotbird_published"]).toBeUndefined();
	});

	it("writes 'never' for Pro accounts (ttlDays === null)", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false, storeFrontmatter: true },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		const file = makeFile("notes/pro.md", "pro");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Pro Note");

		mockPublishNote.mockResolvedValue({
			slug: "pro-note",
			url: "https://share.jotbird.com/pro-note",
			title: "Pro Note",
			expiresAt: "9999-12-31T23:59:59.000Z",
			ttlDays: null,
			created: true,
		});

		const written: Record<string, unknown> = {};
		plugin.app.fileManager.processFrontMatter = vi.fn().mockImplementation(
			async (_f: TFile, fn: (fm: Record<string, unknown>) => void) => {
				fn(written);
			}
		);

		await plugin.publishFile(file);

		expect(written["jotbird_link"]).toBe("https://share.jotbird.com/pro-note");
		expect(written["jotbird_expires"]).toBe("never");
	});

	it("skips frontmatter write when storeFrontmatter is false", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false, storeFrontmatter: false },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		const file = makeFile("notes/nofm.md", "nofm");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# No FM");

		mockPublishNote.mockResolvedValue({
			slug: "no-fm",
			url: "https://share.jotbird.com/no-fm",
			title: "No FM",
			expiresAt: "2026-05-10T12:00:00.000Z",
			ttlDays: 90,
			created: true,
		});

		await plugin.publishFile(file);

		expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
	});

	it("continues successfully even if frontmatter write fails", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false, storeFrontmatter: true },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		const file = makeFile("notes/fail-fm.md", "fail-fm");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Fail FM");

		mockPublishNote.mockResolvedValue({
			slug: "fail-fm",
			url: "https://share.jotbird.com/fail-fm",
			title: "Fail FM",
			expiresAt: "2026-05-10T12:00:00.000Z",
			ttlDays: 90,
			created: true,
		});

		plugin.app.fileManager.processFrontMatter = vi.fn().mockRejectedValue(
			new Error("File locked")
		);

		await plugin.publishFile(file);

		expect(plugin.publishedNotes["notes/fail-fm.md"]).toBeDefined();
		expect(plugin.publishedNotes["notes/fail-fm.md"].slug).toBe("fail-fm");
	});

	it("updates jotbird_expires on republish", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false, storeFrontmatter: true },
			publishedNotes: {
				"notes/update.md": {
					slug: "update-doc",
					url: "https://share.jotbird.com/update-doc",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		await plugin.loadSettings();

		const file = makeFile("notes/update.md", "update");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Updated");

		mockPublishNote.mockResolvedValue({
			slug: "update-doc",
			url: "https://share.jotbird.com/update-doc",
			title: "Updated",
			expiresAt: "2026-06-15T12:00:00.000Z",
			ttlDays: 90,
			created: false,
		});

		const written: Record<string, unknown> = {};
		plugin.app.fileManager.processFrontMatter = vi.fn().mockImplementation(
			async (_f: TFile, fn: (fm: Record<string, unknown>) => void) => {
				fn(written);
			}
		);

		await plugin.publishFile(file);

		expect(written["jotbird_link"]).toBe("https://share.jotbird.com/update-doc");
		expect(written["jotbird_expires"]).toBe("2026-06-15");
	});

	it("cleans up old property names on publish", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false, storeFrontmatter: true },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		const file = makeFile("notes/migrate.md", "migrate");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Migrate\n\nContent");

		mockPublishNote.mockResolvedValue({
			slug: "migrate-doc",
			url: "https://share.jotbird.com/migrate-doc",
			title: "Migrate",
			expiresAt: "2026-05-10T12:00:00.000Z",
			ttlDays: 90,
			created: true,
		});

		// Simulate existing old-format frontmatter
		const written: Record<string, unknown> = {
			jotbird_url: "https://share.jotbird.com/old-doc",
			jotbird_slug: "old-doc",
			jotbird_published: "2026-01-01T00:00:00.000Z",
		};
		plugin.app.fileManager.processFrontMatter = vi.fn().mockImplementation(
			async (_f: TFile, fn: (fm: Record<string, unknown>) => void) => {
				fn(written);
			}
		);

		await plugin.publishFile(file);

		// New properties written
		expect(written["jotbird_link"]).toBe("https://share.jotbird.com/migrate-doc");
		expect(written["jotbird_expires"]).toBe("2026-05-10");
		// Old properties removed
		expect(written["jotbird_url"]).toBeUndefined();
		expect(written["jotbird_slug"]).toBeUndefined();
		expect(written["jotbird_published"]).toBeUndefined();
	});
});

// ---- Pro upgrade frontmatter refresh ----

describe("Pro upgrade frontmatter refresh", () => {
	it("updates all other notes to 'never' when publish returns ttlDays null", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false, storeFrontmatter: true },
			publishedNotes: {
				"notes/other1.md": {
					slug: "other-1",
					url: "https://share.jotbird.com/other-1",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
				"notes/other2.md": {
					slug: "other-2",
					url: "https://share.jotbird.com/other-2",
					publishedAt: "2026-01-05T00:00:00.000Z",
				},
			},
		});
		await plugin.loadSettings();

		const publishedFile = makeFile("notes/pro-publish.md", "pro-publish");
		const otherFile1 = makeFile("notes/other1.md", "other1");
		const otherFile2 = makeFile("notes/other2.md", "other2");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Pro Note");
		plugin.app.vault.getAbstractFileByPath = vi.fn().mockImplementation((path: string) => {
			if (path === "notes/other1.md") return otherFile1;
			if (path === "notes/other2.md") return otherFile2;
			return null;
		});

		const frontmatters: Record<string, Record<string, unknown>> = {};
		plugin.app.fileManager.processFrontMatter = vi.fn().mockImplementation(
			async (f: TFile, fn: (fm: Record<string, unknown>) => void) => {
				const fm: Record<string, unknown> = {};
				fn(fm);
				frontmatters[f.path] = fm;
			}
		);

		mockPublishNote.mockResolvedValue({
			slug: "pro-publish",
			url: "https://share.jotbird.com/pro-publish",
			title: "Pro Note",
			expiresAt: "",
			ttlDays: null,
			created: true,
		});

		await plugin.publishFile(publishedFile);

		// The published file itself should get "never"
		expect(frontmatters["notes/pro-publish.md"]?.["jotbird_expires"]).toBe("never");

		// The other two notes should also be updated to "never"
		expect(frontmatters["notes/other1.md"]?.["jotbird_expires"]).toBe("never");
		expect(frontmatters["notes/other2.md"]?.["jotbird_expires"]).toBe("never");
	});

	it("only refreshes once per session", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false, storeFrontmatter: true },
			publishedNotes: {
				"notes/existing.md": {
					slug: "existing-doc",
					url: "https://share.jotbird.com/existing-doc",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		await plugin.loadSettings();

		const existingFile = makeFile("notes/existing.md", "existing");
		plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(existingFile);

		const frontmatters: Record<string, Record<string, unknown>> = {};
		plugin.app.fileManager.processFrontMatter = vi.fn().mockImplementation(
			async (f: TFile, fn: (fm: Record<string, unknown>) => void) => {
				const fm: Record<string, unknown> = {};
				fn(fm);
				frontmatters[f.path] = fm;
			}
		);

		mockPublishNote.mockResolvedValue({
			slug: "pro-note",
			url: "https://share.jotbird.com/pro-note",
			title: "Pro Note",
			expiresAt: "",
			ttlDays: null,
			created: true,
		});

		const file1 = makeFile("notes/first.md", "first");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# First");
		await plugin.publishFile(file1);

		// First publish: frontmatter updated for the published file + the existing note
		const firstCallCount = (plugin.app.fileManager.processFrontMatter as ReturnType<typeof vi.fn>).mock.calls.length;
		expect(firstCallCount).toBe(2); // published file + existing note

		const file2 = makeFile("notes/second.md", "second");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Second");
		await plugin.publishFile(file2);

		// Second publish: only the published file gets frontmatter, no refresh
		const secondCallCount = (plugin.app.fileManager.processFrontMatter as ReturnType<typeof vi.fn>).mock.calls.length;
		expect(secondCallCount).toBe(3); // previous 2 + just the published file
	});

	it("does not trigger for non-Pro publishes", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false, storeFrontmatter: true },
			publishedNotes: {
				"notes/other.md": {
					slug: "other-doc",
					url: "https://share.jotbird.com/other-doc",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		await plugin.loadSettings();

		plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(makeFile("notes/other.md", "other"));

		const frontmatters: Record<string, Record<string, unknown>> = {};
		plugin.app.fileManager.processFrontMatter = vi.fn().mockImplementation(
			async (f: TFile, fn: (fm: Record<string, unknown>) => void) => {
				const fm: Record<string, unknown> = {};
				fn(fm);
				frontmatters[f.path] = fm;
			}
		);

		mockPublishNote.mockResolvedValue({
			slug: "free-note",
			url: "https://share.jotbird.com/free-note",
			title: "Free Note",
			expiresAt: "2026-05-10T00:00:00.000Z",
			ttlDays: 90,
			created: true,
		});

		const file = makeFile("notes/free.md", "free");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Free Note");
		await plugin.publishFile(file);

		// Only the published file should get frontmatter, not the other note
		expect(frontmatters["notes/free.md"]?.["jotbird_expires"]).toBe("2026-05-10");
		expect(frontmatters["notes/other.md"]).toBeUndefined();
	});

	it("skips refresh when storeFrontmatter is false", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false, storeFrontmatter: false },
			publishedNotes: {
				"notes/other.md": {
					slug: "other-doc",
					url: "https://share.jotbird.com/other-doc",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		await plugin.loadSettings();

		mockPublishNote.mockResolvedValue({
			slug: "pro-note",
			url: "https://share.jotbird.com/pro-note",
			title: "Pro Note",
			expiresAt: "",
			ttlDays: null,
			created: true,
		});

		const file = makeFile("notes/pro.md", "pro");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Pro");
		await plugin.publishFile(file);

		// processFrontMatter should not have been called at all
		expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
	});
});

// ---- Frontmatter on unpublish ----

describe("frontmatter on unpublish", () => {
	it("clears jotbird_* frontmatter properties after unpublishing", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true, storeFrontmatter: true },
			publishedNotes: {
				"notes/rm.md": {
					slug: "rm-doc",
					url: "https://share.jotbird.com/rm-doc",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		await plugin.onload();

		mockDeleteDocument.mockResolvedValue({ ok: true });

		const written: Record<string, unknown> = {
			jotbird_link: "https://share.jotbird.com/rm-doc",
			jotbird_expires: "2026-04-01",
			// Also include old properties to verify they get cleaned up
			jotbird_url: "https://share.jotbird.com/rm-doc",
			jotbird_slug: "rm-doc",
			jotbird_published: "2026-01-01T00:00:00.000Z",
		};
		plugin.app.fileManager.processFrontMatter = vi.fn().mockImplementation(
			async (_f: TFile, fn: (fm: Record<string, unknown>) => void) => {
				fn(written);
			}
		);

		const view = new MarkdownView();
		view.file = makeFile("notes/rm.md", "rm");
		plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(view);

		const unpublishCmd = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.find(
			(call: unknown[]) => (call[0] as { id: string }).id === "unpublish-current-note"
		);
		const checkCallback = (unpublishCmd![0] as { checkCallback: (checking: boolean) => boolean }).checkCallback;
		checkCallback(false);

		await vi.waitFor(() => {
			expect(plugin.app.fileManager.processFrontMatter).toHaveBeenCalled();
		});

		expect(written["jotbird_link"]).toBeUndefined();
		expect(written["jotbird_expires"]).toBeUndefined();
		expect(written["jotbird_url"]).toBeUndefined();
		expect(written["jotbird_slug"]).toBeUndefined();
		expect(written["jotbird_published"]).toBeUndefined();
	});
});

// ---- Frontmatter reconciliation ----

describe("frontmatter reconciliation", () => {
	it("recovers published notes from jotbird_link frontmatter", async () => {
		const file = makeFile("notes/synced.md", "synced");

		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true, storeFrontmatter: true },
			publishedNotes: {},
		});

		plugin.app.vault.getMarkdownFiles = vi.fn().mockReturnValue([file]);
		plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({
			frontmatter: {
				jotbird_link: "https://share.jotbird.com/synced-note",
				jotbird_expires: "2026-05-01",
			},
		});

		await plugin.onload();

		expect(plugin.publishedNotes["notes/synced.md"]).toBeDefined();
		expect(plugin.publishedNotes["notes/synced.md"].slug).toBe("synced-note");
		expect(plugin.publishedNotes["notes/synced.md"].url).toBe("https://share.jotbird.com/synced-note");
	});

	it("recovers published notes from legacy jotbird_url frontmatter", async () => {
		const file = makeFile("notes/legacy.md", "legacy");

		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true, storeFrontmatter: true },
			publishedNotes: {},
		});

		plugin.app.vault.getMarkdownFiles = vi.fn().mockReturnValue([file]);
		plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({
			frontmatter: {
				jotbird_url: "https://share.jotbird.com/legacy-note",
				jotbird_slug: "legacy-note",
				jotbird_published: "2026-02-01T12:00:00.000Z",
			},
		});

		await plugin.onload();

		expect(plugin.publishedNotes["notes/legacy.md"]).toBeDefined();
		expect(plugin.publishedNotes["notes/legacy.md"].slug).toBe("legacy-note");
		expect(plugin.publishedNotes["notes/legacy.md"].url).toBe("https://share.jotbird.com/legacy-note");
	});

	it("does not overwrite existing publishedNotes entries", async () => {
		const file = makeFile("notes/existing.md", "existing");

		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true, storeFrontmatter: true },
			publishedNotes: {
				"notes/existing.md": {
					slug: "existing-doc",
					url: "https://share.jotbird.com/existing-doc",
					editToken: "tok_secret",
					publishedAt: "2026-01-15T10:00:00.000Z",
				},
			},
		});

		plugin.app.vault.getMarkdownFiles = vi.fn().mockReturnValue([file]);
		plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({
			frontmatter: {
				jotbird_link: "https://share.jotbird.com/existing-doc",
			},
		});

		await plugin.onload();

		expect(plugin.publishedNotes["notes/existing.md"].editToken).toBe("tok_secret");
	});

	it("skips reconciliation when storeFrontmatter is false", async () => {
		const file = makeFile("notes/skip.md", "skip");

		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true, storeFrontmatter: false },
			publishedNotes: {},
		});

		plugin.app.vault.getMarkdownFiles = vi.fn().mockReturnValue([file]);
		plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({
			frontmatter: { jotbird_link: "https://share.jotbird.com/skip-note" },
		});

		await plugin.onload();

		expect(plugin.publishedNotes["notes/skip.md"]).toBeUndefined();
	});
});

// ---- Protocol handler (obsidian:// API key flow) ----

describe("obsidian protocol handler", () => {
	function getProtocolHandler(plugin: JotBirdPlugin) {
		const calls = (plugin.registerObsidianProtocolHandler as ReturnType<typeof vi.fn>).mock.calls;
		const call = calls.find((c: unknown[]) => c[0] === "jotbird");
		return call?.[1] as ((params: Record<string, string>) => Promise<void>) | undefined;
	}

	it("registers the jotbird protocol handler on load", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.onload();

		expect(plugin.registerObsidianProtocolHandler).toHaveBeenCalledWith(
			"jotbird",
			expect.any(Function)
		);
	});

	it("saves API key when valid token is received", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.onload();

		const handler = getProtocolHandler(plugin)!;
		// Simulate the user clicking "Connect account", which mints the CSRF nonce that
		// the callback's `state` must match.
		const state = plugin.beginAccountConnect();
		await handler({ action: "jotbird", token: "jb_abc123def456", state });

		expect(plugin.settings.apiKey).toBe("jb_abc123def456");
	});

	it("rejects a valid token whose state does not match the pending nonce (CSRF)", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.onload();

		const handler = getProtocolHandler(plugin)!;
		plugin.beginAccountConnect(); // a connect is pending, but the attacker guesses state
		await handler({ action: "jotbird", token: "jb_attacker_key", state: "wrong-nonce" });

		expect(plugin.settings.apiKey).toBe("");
	});

	it("rejects a valid token when no connect was initiated (no nonce)", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.onload();

		const handler = getProtocolHandler(plugin)!;
		// No beginAccountConnect() → a drive-by obsidian://jotbird?token=… must be ignored.
		await handler({ action: "jotbird", token: "jb_attacker_key", state: "anything" });

		expect(plugin.settings.apiKey).toBe("");
	});

	it("consumes the nonce (single-use): replaying the same state is rejected", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.onload();

		const handler = getProtocolHandler(plugin)!;
		const state = plugin.beginAccountConnect();
		await handler({ action: "jotbird", token: "jb_first", state });
		expect(plugin.settings.apiKey).toBe("jb_first");

		// A second callback replaying the same state must not swap the key again.
		await handler({ action: "jotbird", token: "jb_replayed", state });
		expect(plugin.settings.apiKey).toBe("jb_first");
	});

	it("rejects token that does not start with jb_", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.onload();

		const handler = getProtocolHandler(plugin)!;
		await handler({ action: "jotbird", token: "invalid_token" });

		expect(plugin.settings.apiKey).toBe("");
	});

	it("rejects when no token is provided", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.onload();

		const handler = getProtocolHandler(plugin)!;
		await handler({ action: "jotbird" });

		expect(plugin.settings.apiKey).toBe("");
	});

	it("claims anonymous documents after receiving a valid token", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: true, storeFrontmatter: true },
			publishedNotes: {
				"notes/anon1.md": {
					slug: "anon-doc-1",
					url: "https://share.jotbird.com/anon-doc-1",
					editToken: "tok_edit_1",
					publishedAt: "2026-01-15T00:00:00.000Z",
				},
				"notes/anon2.md": {
					slug: "anon-doc-2",
					url: "https://share.jotbird.com/anon-doc-2",
					editToken: "tok_edit_2",
					publishedAt: "2026-01-20T00:00:00.000Z",
				},
				"notes/owned.md": {
					slug: "owned-doc",
					url: "https://share.jotbird.com/owned-doc",
					publishedAt: "2026-01-10T00:00:00.000Z",
					// No editToken — already account-owned
				},
			},
		});
		await plugin.onload();

		// Mock vault.getAbstractFileByPath so frontmatter can be written
		const file1 = makeFile("notes/anon1.md", "anon1");
		const file2 = makeFile("notes/anon2.md", "anon2");
		plugin.app.vault.getAbstractFileByPath = vi.fn().mockImplementation((path: string) => {
			if (path === "notes/anon1.md") return file1;
			if (path === "notes/anon2.md") return file2;
			return null;
		});

		const frontmatters: Record<string, Record<string, unknown>> = {};
		plugin.app.fileManager.processFrontMatter = vi.fn().mockImplementation(
			async (f: TFile, fn: (fm: Record<string, unknown>) => void) => {
				const fm: Record<string, unknown> = {};
				fn(fm);
				frontmatters[f.path] = fm;
			}
		);

		mockClaimDocument
			.mockResolvedValueOnce({
				ok: true,
				slug: "anon-doc-1",
				url: "https://share.jotbird.com/anon-doc-1",
				expiresAt: "2026-05-15T00:00:00.000Z",
				ttlDays: 90,
			})
			.mockResolvedValueOnce({
				ok: true,
				slug: "anon-doc-2",
				url: "https://share.jotbird.com/anon-doc-2",
				expiresAt: "2026-05-20T00:00:00.000Z",
				ttlDays: 90,
			});

		const handler = getProtocolHandler(plugin)!;
		const state = plugin.beginAccountConnect();
		await handler({ action: "jotbird", token: "jb_newkey123", state });

		// Wait for async claim reconciliation to complete
		await vi.waitFor(() => {
			expect(mockClaimDocument).toHaveBeenCalledTimes(2);
		});

		// Verify claimDocument was called for each anonymous doc
		expect(mockClaimDocument).toHaveBeenCalledWith("jb_newkey123", "anon-doc-1", "tok_edit_1");
		expect(mockClaimDocument).toHaveBeenCalledWith("jb_newkey123", "anon-doc-2", "tok_edit_2");

		// editToken should be removed from claimed documents
		expect(plugin.publishedNotes["notes/anon1.md"].editToken).toBeUndefined();
		expect(plugin.publishedNotes["notes/anon2.md"].editToken).toBeUndefined();

		// Owned doc should be untouched
		expect(plugin.publishedNotes["notes/owned.md"].slug).toBe("owned-doc");

		// Frontmatter should be updated with new expiration
		expect(frontmatters["notes/anon1.md"]?.["jotbird_expires"]).toBe("2026-05-15");
		expect(frontmatters["notes/anon2.md"]?.["jotbird_expires"]).toBe("2026-05-20");
	});

	it("skips claim for documents without editToken", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: true },
			publishedNotes: {
				"notes/owned.md": {
					slug: "owned-doc",
					url: "https://share.jotbird.com/owned-doc",
					publishedAt: "2026-01-10T00:00:00.000Z",
				},
			},
		});
		await plugin.onload();

		const handler = getProtocolHandler(plugin)!;
		const state = plugin.beginAccountConnect();
		await handler({ action: "jotbird", token: "jb_key123", state });

		// claimDocument should not be called for docs without editToken
		expect(mockClaimDocument).not.toHaveBeenCalled();
	});

	it("continues claiming remaining docs when one fails", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: true, storeFrontmatter: false },
			publishedNotes: {
				"notes/fail.md": {
					slug: "fail-doc",
					url: "https://share.jotbird.com/fail-doc",
					editToken: "tok_fail",
					publishedAt: "2026-01-15T00:00:00.000Z",
				},
				"notes/ok.md": {
					slug: "ok-doc",
					url: "https://share.jotbird.com/ok-doc",
					editToken: "tok_ok",
					publishedAt: "2026-01-20T00:00:00.000Z",
				},
			},
		});
		await plugin.onload();

		mockClaimDocument
			.mockRejectedValueOnce(new Error("Claim: Document not found"))
			.mockResolvedValueOnce({
				ok: true,
				slug: "ok-doc",
				url: "https://share.jotbird.com/ok-doc",
				expiresAt: "2026-05-20T00:00:00.000Z",
				ttlDays: 90,
			});

		const handler = getProtocolHandler(plugin)!;
		const state = plugin.beginAccountConnect();
		await handler({ action: "jotbird", token: "jb_key123", state });

		await vi.waitFor(() => {
			expect(mockClaimDocument).toHaveBeenCalledTimes(2);
		});

		// Failed doc should still have its editToken
		expect(plugin.publishedNotes["notes/fail.md"].editToken).toBe("tok_fail");

		// Successful doc should have editToken removed
		expect(plugin.publishedNotes["notes/ok.md"].editToken).toBeUndefined();
	});

	it("handles upgraded=1 and refreshes frontmatter when Pro", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true, storeFrontmatter: true },
			publishedNotes: {
				"notes/doc1.md": {
					slug: "doc-1",
					url: "https://share.jotbird.com/doc-1",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
				"notes/doc2.md": {
					slug: "doc-2",
					url: "https://share.jotbird.com/doc-2",
					publishedAt: "2026-01-05T00:00:00.000Z",
				},
			},
		});
		await plugin.onload();

		// Mock listDocuments to return isPro: true
		mockListDocuments.mockResolvedValue({
			documents: [],
			isPro: true,
		});

		const file1 = makeFile("notes/doc1.md", "doc1");
		const file2 = makeFile("notes/doc2.md", "doc2");
		plugin.app.vault.getAbstractFileByPath = vi.fn().mockImplementation((path: string) => {
			if (path === "notes/doc1.md") return file1;
			if (path === "notes/doc2.md") return file2;
			return null;
		});

		const frontmatters: Record<string, Record<string, unknown>> = {};
		plugin.app.fileManager.processFrontMatter = vi.fn().mockImplementation(
			async (f: TFile, fn: (fm: Record<string, unknown>) => void) => {
				const fm: Record<string, unknown> = {};
				fn(fm);
				frontmatters[f.path] = fm;
			}
		);

		const handler = getProtocolHandler(plugin)!;
		await handler({ upgraded: "1" });

		// Should have checked Pro status
		expect(mockListDocuments).toHaveBeenCalledWith("jb_key");
		expect(plugin.isPro).toBe(true);

		// All notes should have frontmatter updated to "never"
		expect(frontmatters["notes/doc1.md"]?.["jotbird_expires"]).toBe("never");
		expect(frontmatters["notes/doc2.md"]?.["jotbird_expires"]).toBe("never");
	});

	it("handles upgraded=1 when not actually Pro yet", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.onload();

		// Mock listDocuments to return isPro: false
		mockListDocuments.mockResolvedValue({
			documents: [],
			isPro: false,
		});

		const handler = getProtocolHandler(plugin)!;
		await handler({ upgraded: "1" });

		expect(plugin.isPro).toBe(false);
		// No frontmatter refresh should happen
		expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
	});
});

// ---- Pro status checks ----

describe("checkProStatus", () => {
	it("sets isPro to true when API returns isPro", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		mockListDocuments.mockResolvedValue({
			documents: [],
			isPro: true,
		});

		await plugin.checkProStatus();

		expect(mockListDocuments).toHaveBeenCalledWith("jb_key");
		expect(plugin.isPro).toBe(true);
	});

	it("sets isPro to false when API returns isPro false", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		mockListDocuments.mockResolvedValue({
			documents: [],
			isPro: false,
		});

		await plugin.checkProStatus();

		expect(plugin.isPro).toBe(false);
	});

	it("does not call API when no API key is set", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		await plugin.checkProStatus();

		expect(mockListDocuments).not.toHaveBeenCalled();
		expect(plugin.isPro).toBe(false);
	});

	it("ignores API errors silently", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		mockListDocuments.mockRejectedValue(new Error("Network error"));

		await plugin.checkProStatus();

		// Should not throw and isPro should remain false
		expect(plugin.isPro).toBe(false);
	});

	it("handles missing isPro field in response", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		mockListDocuments.mockResolvedValue({
			documents: [],
			// isPro not included
		});

		await plugin.checkProStatus();

		expect(plugin.isPro).toBe(false);
	});
});

// ---- Page settings ----

describe("page settings on publish", () => {
	function publishedPlugin(extraSettings: Record<string, unknown> = {}) {
		return createPlugin({
			settings: {
				apiKey: "jb_key",
				stripTags: true,
				autoCopyLink: false,
				...extraSettings,
			} as PluginData["settings"],
			publishedNotes: {},
		});
	}

	it("sends settings properties from frontmatter with the publish", async () => {
		const plugin = publishedPlugin();
		await plugin.loadSettings();

		const file = makeFile("notes/themed.md", "themed");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Themed\n\nBody");
		plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({
			frontmatter: { jotbird_theme: "essay", jotbird_hide_branding: true },
		});

		mockPublishNote.mockResolvedValue({
			slug: "themed-doc",
			url: "https://share.jotbird.com/themed-doc",
			title: "Themed",
			expiresAt: null,
			ttlDays: null,
			created: true,
		});

		await plugin.publishFile(file);

		expect(mockPublishNote).toHaveBeenCalledWith(
			"jb_key",
			expect.any(String),
			expect.any(String),
			undefined,
			undefined,
			false,
			{ theme: "essay", hideBranding: true }
		);
	});

	it("reads settings properties even when storeFrontmatter is off", async () => {
		const plugin = publishedPlugin({ storeFrontmatter: false });
		await plugin.loadSettings();

		const file = makeFile("notes/nofm.md", "nofm");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# NoFM\n\nBody");
		plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({
			frontmatter: { jotbird_theme: "minimal" },
		});

		mockPublishNote.mockResolvedValue({
			slug: "nofm-doc",
			url: "https://share.jotbird.com/nofm-doc",
			title: "NoFM",
			expiresAt: null,
			ttlDays: null,
			created: true,
		});

		await plugin.publishFile(file);

		expect(mockPublishNote.mock.calls[0][6]).toEqual({ theme: "minimal" });
	});

	it("sends the vault-wide default when the note has no override", async () => {
		const plugin = publishedPlugin({ defaultTheme: "terminal", defaultHideBranding: "hide" });
		await plugin.loadSettings();

		const file = makeFile("notes/default.md", "default");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Default\n\nBody");

		mockPublishNote.mockResolvedValue({
			slug: "default-doc",
			url: "https://share.jotbird.com/default-doc",
			title: "Default",
			expiresAt: null,
			ttlDays: null,
			created: true,
		});

		await plugin.publishFile(file);

		expect(mockPublishNote.mock.calls[0][6]).toEqual({ theme: "terminal", hideBranding: true });
	});

	it("sends nothing when no properties or defaults are set (server preserves)", async () => {
		const plugin = publishedPlugin();
		await plugin.loadSettings();

		const file = makeFile("notes/plain.md", "plain");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Plain\n\nBody");

		mockPublishNote.mockResolvedValue({
			slug: "plain-doc",
			url: "https://share.jotbird.com/plain-doc",
			title: "Plain",
			expiresAt: null,
			ttlDays: null,
			created: true,
		});

		await plugin.publishFile(file);

		expect(mockPublishNote.mock.calls[0][6]).toBeUndefined();
	});

	it("shows a Notice for each server warning in the publish response", async () => {
		const plugin = publishedPlugin();
		await plugin.loadSettings();

		const file = makeFile("notes/warned.md", "warned");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Warned\n\nBody");
		plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({
			frontmatter: { jotbird_theme: "essay" },
		});

		mockPublishNote.mockResolvedValue({
			slug: "warned-doc",
			url: "https://share.jotbird.com/warned-doc",
			title: "Warned",
			expiresAt: "2026-10-10T00:00:00.000Z",
			ttlDays: 90,
			created: true,
			warnings: [
				{
					setting: "theme",
					reason: "pro_required",
					message: 'The "essay" theme requires a Pro subscription — published with the default theme.',
				},
			],
		});

		await plugin.publishFile(file);

		const noticeMessages = mockNotice.mock.calls.map((call) => call[0]);
		expect(noticeMessages).toContain(
			'The "essay" theme requires a Pro subscription — published with the default theme.'
		);
	});
});

describe("page settings commands", () => {
	it("page-settings and pull commands are unavailable without an API key or on anonymous notes", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {
				"notes/anon.md": {
					slug: "anon-doc",
					url: "https://share.jotbird.com/anon-doc",
					editToken: "tok_anon",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
				"notes/owned.md": {
					documentId: "doc-uuid-1",
					slug: "owned-doc",
					url: "https://share.jotbird.com/owned-doc",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		await plugin.onload();

		const getCheck = (id: string) => {
			const cmd = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.find(
				(call: unknown[]) => (call[0] as { id: string }).id === id
			);
			return (cmd![0] as { checkCallback: (checking: boolean) => boolean }).checkCallback;
		};

		const activate = (path: string, basename: string) => {
			const view = new MarkdownView();
			view.file = makeFile(path, basename);
			plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(view);
		};

		// Account-owned published note → available
		activate("notes/owned.md", "owned");
		expect(getCheck("page-settings")(true)).toBe(true);
		expect(getCheck("pull-page-settings")(true)).toBe(true);

		// Anonymous note (still carries an editToken) → no settings to manage
		activate("notes/anon.md", "anon");
		expect(getCheck("page-settings")(true)).toBe(false);

		// Unpublished note → nothing to configure
		activate("notes/new.md", "new");
		expect(getCheck("page-settings")(true)).toBe(false);

		// No API key → settings API unreachable
		plugin.settings.apiKey = "";
		activate("notes/owned.md", "owned");
		expect(getCheck("page-settings")(true)).toBe(false);
	});

	it("page-settings command opens the modal for the active published note", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {
				"notes/owned.md": {
					documentId: "doc-uuid-1",
					slug: "owned-doc",
					url: "https://share.jotbird.com/owned-doc",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		await plugin.onload();

		const view = new MarkdownView();
		view.file = makeFile("notes/owned.md", "owned");
		plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(view);

		const cmd = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.find(
			(call: unknown[]) => (call[0] as { id: string }).id === "page-settings"
		);
		(cmd![0] as { checkCallback: (checking: boolean) => boolean }).checkCallback(false);

		expect(PageSettingsModal).toHaveBeenCalledOnce();
	});

	it("pull command writes settings properties even when storeFrontmatter is off", async () => {
		const plugin = createPlugin({
			settings: {
				apiKey: "jb_key",
				stripTags: true,
				autoCopyLink: true,
				storeFrontmatter: false,
			} as PluginData["settings"],
			publishedNotes: {
				"notes/pull.md": {
					documentId: "doc-uuid-2",
					slug: "pull-doc",
					url: "https://share.jotbird.com/pull-doc",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		await plugin.onload();

		mockGetPageSettings.mockResolvedValue({
			slug: "pull-doc",
			username: null,
			url: "https://share.jotbird.com/pull-doc",
			title: "Pull",
			theme: "essay",
			hideBranding: true,
			visibility: "unlisted",
			tags: [],
			expiresAt: null,
		});

		const written: Record<string, unknown> = {};
		plugin.app.fileManager.processFrontMatter = vi.fn().mockImplementation(
			async (_f: TFile, fn: (fm: Record<string, unknown>) => void) => {
				fn(written);
			}
		);

		const view = new MarkdownView();
		view.file = makeFile("notes/pull.md", "pull");
		plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(view);

		const cmd = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.find(
			(call: unknown[]) => (call[0] as { id: string }).id === "pull-page-settings"
		);
		(cmd![0] as { checkCallback: (checking: boolean) => boolean }).checkCallback(false);

		await vi.waitFor(() => {
			expect(plugin.app.fileManager.processFrontMatter).toHaveBeenCalled();
		});

		expect(mockGetPageSettings).toHaveBeenCalledWith("jb_key", {
			documentId: "doc-uuid-2",
			slug: "pull-doc",
		});
		expect(written["jotbird_theme"]).toBe("essay");
		expect(written["jotbird_hide_branding"]).toBe(true);
	});
});

describe("settings properties survive unpublish", () => {
	it("clearFrontmatter removes receipts but never the user's settings properties", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true, storeFrontmatter: true },
			publishedNotes: {
				"notes/keep.md": {
					slug: "keep-doc",
					url: "https://share.jotbird.com/keep-doc",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		await plugin.onload();

		mockDeleteDocument.mockResolvedValue({ ok: true });

		const written: Record<string, unknown> = {
			jotbird_link: "https://share.jotbird.com/keep-doc",
			jotbird_expires: "never",
			// User-authored settings: unpublish removes the receipt, not the intent.
			jotbird_theme: "essay",
			jotbird_hide_branding: true,
		};
		plugin.app.fileManager.processFrontMatter = vi.fn().mockImplementation(
			async (_f: TFile, fn: (fm: Record<string, unknown>) => void) => {
				fn(written);
			}
		);

		const view = new MarkdownView();
		view.file = makeFile("notes/keep.md", "keep");
		plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(view);

		const cmd = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.find(
			(call: unknown[]) => (call[0] as { id: string }).id === "unpublish-current-note"
		);
		(cmd![0] as { checkCallback: (checking: boolean) => boolean }).checkCallback(false);

		await vi.waitFor(() => {
			expect(plugin.app.fileManager.processFrontMatter).toHaveBeenCalled();
		});

		expect(written["jotbird_link"]).toBeUndefined();
		expect(written["jotbird_expires"]).toBeUndefined();
		expect(written["jotbird_theme"]).toBe("essay");
		expect(written["jotbird_hide_branding"]).toBe(true);
	});
});

// ---- Page settings: review fixes ----

describe("page settings review fixes", () => {
	it("warns locally when an anonymous publish can't carry settings properties", async () => {
		// /trial/publish has no settings channel, so the SERVER can't warn about a
		// field it never receives. Dropping it silently is the exact failure the
		// publish warnings exist to prevent — the plugin must say so itself.
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: false },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		const file = makeFile("notes/anon-theme.md", "anon-theme");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Anon\n\nBody");
		plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({
			frontmatter: { jotbird_theme: "essay" },
		});

		mockTrialPublish.mockResolvedValue({
			slug: "anon-doc",
			url: "https://share.jotbird.com/anon-doc",
			title: "Anon",
			expiresAt: "2026-08-11T00:00:00.000Z",
			ttlDays: 30,
			created: true,
			editToken: "tok_1",
		});

		await plugin.publishFile(file);

		const messages = mockNotice.mock.calls.map((c) => c[0] as string);
		expect(messages.some((m) => /connected JotBird account/i.test(m))).toBe(true);
	});

	it("does not warn on an anonymous publish when no settings properties are present", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: false },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		const file = makeFile("notes/anon-plain.md", "anon-plain");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Anon\n\nBody");

		mockTrialPublish.mockResolvedValue({
			slug: "anon-plain",
			url: "https://share.jotbird.com/anon-plain",
			title: "Anon",
			expiresAt: "2026-08-11T00:00:00.000Z",
			ttlDays: 30,
			created: true,
		});

		await plugin.publishFile(file);

		const messages = mockNotice.mock.calls.map((c) => c[0] as string);
		expect(messages.some((m) => /connected JotBird account/i.test(m))).toBe(false);
	});

	it("collapses multiple warnings into one Notice and does not repeat them on every publish", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		const file = makeFile("notes/warn.md", "warn");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Warn\n\nBody");

		const response = {
			slug: "warn-doc",
			url: "https://share.jotbird.com/warn-doc",
			title: "Warn",
			expiresAt: null,
			ttlDays: null,
			created: true,
			warnings: [
				{ setting: "theme", reason: "pro_required", message: "Theme needs Pro." },
				{ setting: "hideBranding", reason: "pro_required", message: "Branding needs Pro." },
			],
		};
		mockPublishNote.mockResolvedValue(response);

		await plugin.publishFile(file);

		// Both warnings, ONE Notice.
		const warningNotices = mockNotice.mock.calls
			.map((c) => c[0] as string)
			.filter((m) => /needs Pro/.test(m));
		expect(warningNotices).toHaveLength(1);
		expect(warningNotices[0]).toContain("Theme needs Pro.");
		expect(warningNotices[0]).toContain("Branding needs Pro.");

		// A standing condition (e.g. a vault default the account can't use) would
		// otherwise re-toast forever: the same warnings are suppressed next time.
		mockNotice.mockClear();
		await plugin.publishFile(file);
		const repeated = mockNotice.mock.calls
			.map((c) => c[0] as string)
			.filter((m) => /needs Pro/.test(m));
		expect(repeated).toHaveLength(0);
	});

	it("always shows a pro_lapsed warning (it fires once per page and is churn-worthy)", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		const file = makeFile("notes/lapsed.md", "lapsed");
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Lapsed\n\nBody");

		mockPublishNote.mockResolvedValue({
			slug: "lapsed-doc",
			url: "https://share.jotbird.com/lapsed-doc",
			title: "Lapsed",
			expiresAt: null,
			ttlDays: null,
			created: false,
			warnings: [
				{ setting: "theme", reason: "pro_lapsed", message: "Subscription inactive — theme removed." },
			],
		});

		await plugin.publishFile(file);
		expect(
			mockNotice.mock.calls.map((c) => c[0] as string).some((m) => /theme removed/.test(m))
		).toBe(true);

		// Not deduped: a different page could lapse next.
		mockNotice.mockClear();
		await plugin.publishFile(file);
		expect(
			mockNotice.mock.calls.map((c) => c[0] as string).some((m) => /theme removed/.test(m))
		).toBe(true);
	});

	it("pull command does not materialize default settings (which would clobber later web-app changes)", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {
				"notes/plain.md": {
					documentId: "doc-plain",
					slug: "plain-doc",
					url: "https://share.jotbird.com/plain-doc",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		await plugin.onload();

		// A page with NO settings: writing jotbird_theme:default + hide:false would
		// be an explicit CLEAR on every future publish, reverting any theme later
		// set in the web app.
		mockGetPageSettings.mockResolvedValue({
			slug: "plain-doc",
			username: null,
			url: "https://share.jotbird.com/plain-doc",
			title: "Plain",
			theme: "default",
			hideBranding: false,
			visibility: "unlisted",
			tags: [],
			expiresAt: null,
		});

		plugin.app.fileManager.processFrontMatter = vi.fn();

		const view = new MarkdownView();
		view.file = makeFile("notes/plain.md", "plain");
		plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(view);

		await plugin.pullPageSettings(view.file);

		expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
		expect(
			mockNotice.mock.calls.map((c) => c[0] as string).some((m) => /nothing to save/i.test(m))
		).toBe(true);
	});

	it("pull command writes only the settings the page actually has", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {
				"notes/themed.md": {
					documentId: "doc-themed",
					slug: "themed-doc",
					url: "https://share.jotbird.com/themed-doc",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		await plugin.onload();

		mockGetPageSettings.mockResolvedValue({
			slug: "themed-doc",
			username: null,
			url: "https://share.jotbird.com/themed-doc",
			title: "Themed",
			theme: "essay",
			hideBranding: false, // default → not materialized
			visibility: "unlisted",
			tags: [],
			expiresAt: null,
		});

		const written: Record<string, unknown> = {};
		plugin.app.fileManager.processFrontMatter = vi.fn().mockImplementation(
			async (_f: TFile, fn: (fm: Record<string, unknown>) => void) => {
				fn(written);
			}
		);

		const file = makeFile("notes/themed.md", "themed");
		await plugin.pullPageSettings(file);

		expect(written["jotbird_theme"]).toBe("essay");
		expect(written).not.toHaveProperty("jotbird_hide_branding");
	});
});

// ---- Page settings: second-review fixes ----

describe("publish warnings are deduped per NOTE, not globally", () => {
	function warnResponse(slug: string, message: string) {
		return {
			slug,
			url: `https://share.jotbird.com/${slug}`,
			title: "T",
			expiresAt: null,
			ttlDays: null,
			created: true,
			warnings: [{ setting: "theme", reason: "invalid_value", message }],
		};
	}

	it("still warns about a DIFFERENT note carrying the same kind of problem", async () => {
		// Keying suppression on setting:reason alone would swallow note B's typo
		// entirely because note A already reported one — a silent drop, which is
		// the exact failure this feature exists to end.
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false },
			publishedNotes: {},
		});
		await plugin.loadSettings();
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Body");

		const fileA = makeFile("notes/a.md", "a");
		const fileB = makeFile("notes/b.md", "b");

		mockPublishNote.mockResolvedValue(warnResponse("a-doc", 'Unknown theme "esay".'));
		await plugin.publishFile(fileA);
		expect(
			mockNotice.mock.calls.map((c) => c[0] as string).some((m) => /esay/.test(m))
		).toBe(true);

		mockNotice.mockClear();
		mockPublishNote.mockResolvedValue(warnResponse("b-doc", 'Unknown theme "termnal".'));
		await plugin.publishFile(fileB);
		expect(
			mockNotice.mock.calls.map((c) => c[0] as string).some((m) => /termnal/.test(m))
		).toBe(true);
	});

	it("suppresses the repeat for the SAME note (the standing-condition spam)", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false },
			publishedNotes: {},
		});
		await plugin.loadSettings();
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Body");

		const file = makeFile("notes/same.md", "same");
		mockPublishNote.mockResolvedValue(warnResponse("same-doc", 'Unknown theme "esay".'));

		await plugin.publishFile(file);
		mockNotice.mockClear();
		await plugin.publishFile(file);

		expect(
			mockNotice.mock.calls.map((c) => c[0] as string).some((m) => /esay/.test(m))
		).toBe(false);
	});

	it("deduped the anonymous 'needs an account' notice per note too", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: false },
			publishedNotes: {},
		});
		await plugin.loadSettings();
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Body");
		plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({
			frontmatter: { jotbird_theme: "essay" },
		});
		mockTrialPublish.mockResolvedValue({
			slug: "anon",
			url: "https://share.jotbird.com/anon",
			title: "T",
			expiresAt: null,
			ttlDays: 30,
			created: true,
		});

		const file = makeFile("notes/anon2.md", "anon2");
		await plugin.publishFile(file);
		mockNotice.mockClear();
		await plugin.publishFile(file);

		expect(
			mockNotice.mock.calls.map((c) => c[0] as string).some((m) => /connected JotBird account/i.test(m))
		).toBe(false);
	});
});

describe("pull page settings syncs the note to the page (both directions)", () => {
	function pluginWithNote() {
		return createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {
				"notes/sync.md": {
					documentId: "doc-sync",
					slug: "sync-doc",
					url: "https://share.jotbird.com/sync-doc",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
	}

	it("REMOVES a stale property when the page no longer has that setting", async () => {
		// The note says essay; the page was reset to Default in the web app. Merely
		// skipping the write would leave the note contradicting the page — and the
		// next publish would silently re-apply essay.
		const plugin = pluginWithNote();
		await plugin.onload();

		mockGetPageSettings.mockResolvedValue({
			slug: "sync-doc",
			username: null,
			url: "https://share.jotbird.com/sync-doc",
			title: "Sync",
			theme: "default",
			hideBranding: false,
			visibility: "unlisted",
			tags: [],
			expiresAt: null,
		});

		const written: Record<string, unknown> = {
			jotbird_theme: "essay",
			jotbird_hide_branding: true,
			jotbird_link: "https://share.jotbird.com/sync-doc",
		};
		plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({ frontmatter: written });
		plugin.app.fileManager.processFrontMatter = vi.fn().mockImplementation(
			async (_f: TFile, fn: (fm: Record<string, unknown>) => void) => fn(written)
		);

		await plugin.pullPageSettings(makeFile("notes/sync.md", "sync"));

		expect(written).not.toHaveProperty("jotbird_theme");
		expect(written).not.toHaveProperty("jotbird_hide_branding");
		// The receipt is untouched — only settings properties are synced.
		expect(written["jotbird_link"]).toBe("https://share.jotbird.com/sync-doc");
	});

	it("still reports 'nothing to save' when the note and page already agree on defaults", async () => {
		const plugin = pluginWithNote();
		await plugin.onload();

		mockGetPageSettings.mockResolvedValue({
			slug: "sync-doc",
			username: null,
			url: "https://share.jotbird.com/sync-doc",
			title: "Sync",
			theme: "default",
			hideBranding: false,
			visibility: "unlisted",
			tags: [],
			expiresAt: null,
		});
		plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({ frontmatter: {} });
		plugin.app.fileManager.processFrontMatter = vi.fn();

		await plugin.pullPageSettings(makeFile("notes/sync.md", "sync"));

		expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
		expect(
			mockNotice.mock.calls.map((c) => c[0] as string).some((m) => /nothing to save/i.test(m))
		).toBe(true);
	});

	it("replaces one setting while removing the other", async () => {
		const plugin = pluginWithNote();
		await plugin.onload();

		mockGetPageSettings.mockResolvedValue({
			slug: "sync-doc",
			username: null,
			url: "https://share.jotbird.com/sync-doc",
			title: "Sync",
			theme: "terminal", // page has a theme…
			hideBranding: false, // …but branding is back to default
			visibility: "unlisted",
			tags: [],
			expiresAt: null,
		});

		const written: Record<string, unknown> = {
			jotbird_theme: "essay",
			jotbird_hide_branding: true,
		};
		plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({ frontmatter: written });
		plugin.app.fileManager.processFrontMatter = vi.fn().mockImplementation(
			async (_f: TFile, fn: (fm: Record<string, unknown>) => void) => fn(written)
		);

		await plugin.pullPageSettings(makeFile("notes/sync.md", "sync"));

		expect(written["jotbird_theme"]).toBe("terminal");
		expect(written).not.toHaveProperty("jotbird_hide_branding");
	});
});

describe("pull page settings respects vault defaults (regression)", () => {
	it("keeps an explicit override instead of deleting it into a vault default", async () => {
		// The note pins `jotbird_hide_branding: false` to override a vault default
		// of "hide", and the page correctly shows branding. Deleting the property
		// would hand the next publish to the vault default and HIDE branding on a
		// page the user never touched — a "sync" that changes the page.
		const plugin = createPlugin({
			settings: {
				apiKey: "jb_key",
				stripTags: true,
				autoCopyLink: true,
				defaultTheme: "essay",
				defaultHideBranding: "hide",
			} as PluginData["settings"],
			publishedNotes: {
				"notes/pinned.md": {
					documentId: "doc-pinned",
					slug: "pinned-doc",
					url: "https://share.jotbird.com/pinned-doc",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		await plugin.onload();

		// The page is at BOTH defaults — precisely because the note overrides them.
		mockGetPageSettings.mockResolvedValue({
			slug: "pinned-doc",
			username: null,
			url: "https://share.jotbird.com/pinned-doc",
			title: "Pinned",
			theme: "default",
			hideBranding: false,
			visibility: "unlisted",
			tags: [],
			expiresAt: null,
		});

		const written: Record<string, unknown> = {
			jotbird_theme: "default",
			jotbird_hide_branding: false,
		};
		plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({ frontmatter: written });
		plugin.app.fileManager.processFrontMatter = vi.fn().mockImplementation(
			async (_f: TFile, fn: (fm: Record<string, unknown>) => void) => fn(written)
		);

		await plugin.pullPageSettings(makeFile("notes/pinned.md", "pinned"));

		// The overrides SURVIVE — removing them would have changed the page.
		expect(written["jotbird_theme"]).toBe("default");
		expect(written["jotbird_hide_branding"]).toBe(false);
	});

	it("pins a page at its default when a vault default would otherwise change it", async () => {
		const plugin = createPlugin({
			settings: {
				apiKey: "jb_key",
				stripTags: true,
				autoCopyLink: true,
				defaultTheme: "essay",
				defaultHideBranding: "",
			} as PluginData["settings"],
			publishedNotes: {
				"notes/bare.md": {
					documentId: "doc-bare",
					slug: "bare-doc",
					url: "https://share.jotbird.com/bare-doc",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		await plugin.onload();

		mockGetPageSettings.mockResolvedValue({
			slug: "bare-doc",
			username: null,
			url: "https://share.jotbird.com/bare-doc",
			title: "Bare",
			theme: "default",
			hideBranding: false,
			visibility: "unlisted",
			tags: [],
			expiresAt: null,
		});

		const written: Record<string, unknown> = {};
		plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({ frontmatter: written });
		plugin.app.fileManager.processFrontMatter = vi.fn().mockImplementation(
			async (_f: TFile, fn: (fm: Record<string, unknown>) => void) => fn(written)
		);

		await plugin.pullPageSettings(makeFile("notes/bare.md", "bare"));

		// Without this the vault default would silently theme the page next publish.
		expect(written["jotbird_theme"]).toBe("default");
	});
});

describe("dismissed warnings follow a renamed note", () => {
	it("does not resurface a warning just because the file moved", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: false },
			publishedNotes: {},
		});
		await plugin.onload();
		plugin.app.vault.read = vi.fn().mockResolvedValue("# Body");

		const response = {
			slug: "r-doc",
			url: "https://share.jotbird.com/r-doc",
			title: "R",
			expiresAt: null,
			ttlDays: null,
			created: true,
			warnings: [{ setting: "theme", reason: "pro_required", message: "Theme needs Pro." }],
		};
		mockPublishNote.mockResolvedValue(response);

		const oldFile = makeFile("notes/old.md", "old");
		await plugin.publishFile(oldFile);

		// Simulate the vault rename event the plugin registers in onload().
		const renameHandler = (plugin.app.vault.on as ReturnType<typeof vi.fn>).mock.calls.find(
			(call: unknown[]) => call[0] === "rename"
		)?.[1] as (file: TFile, oldPath: string) => void;
		const newFile = makeFile("notes/new.md", "new");
		renameHandler(newFile, "notes/old.md");

		mockNotice.mockClear();
		await plugin.publishFile(newFile);

		expect(
			mockNotice.mock.calls.map((c) => c[0] as string).some((m) => /needs Pro/.test(m))
		).toBe(false);
	});
});

describe("Pro-status cache freshness", () => {
	function proPlugin() {
		return createPlugin({
			settings: { apiKey: "jb_key", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
	}

	it("skips the check when it ran recently (the throttle)", async () => {
		const plugin = proPlugin();
		await plugin.loadSettings();
		mockListDocuments.mockResolvedValue({ documents: [], isPro: true });

		await plugin.checkProStatus();
		expect(mockListDocuments).toHaveBeenCalledTimes(1);

		// Opening the settings tab / the modal again must not re-hit the API.
		await plugin.refreshProStatusIfStale();
		await plugin.refreshProStatusIfStale();
		expect(mockListDocuments).toHaveBeenCalledTimes(1);
		expect(plugin.isPro).toBe(true);
	});

	it("reports whether the server ANSWERED, so the settings tab can tell a bad key from a free one", async () => {
		// `false` means "we don't know" (the key 401s / we're offline) — never
		// "not Pro". The settings tab relies on this to avoid re-rendering (and
		// deleting its own input field) on a half-typed key.
		const plugin = proPlugin();
		await plugin.loadSettings();

		mockListDocuments.mockResolvedValue({ documents: [], isPro: false });
		expect(await plugin.checkProStatus()).toBe(true); // key works, account is free
		expect(plugin.isPro).toBe(false);

		mockListDocuments.mockRejectedValueOnce(new Error("401"));
		expect(await plugin.checkProStatus()).toBe(false); // key does not work

		plugin.settings.apiKey = "";
		expect(await plugin.checkProStatus()).toBe(false); // nothing to check
	});

	it("⚠️ a FAILED check does not count as fresh — the offline-launch case must stay re-checkable", async () => {
		// This is the whole point of stamping lastProCheckAt inside the try: the
		// original bug was a Pro user locked out for the session after one failed
		// startup check. If the stamp ever moves outside the try, this fails.
		const plugin = proPlugin();
		await plugin.loadSettings();

		mockListDocuments.mockRejectedValueOnce(new Error("offline"));
		await plugin.checkProStatus();
		expect(plugin.isPro).toBe(false);
		expect(mockListDocuments).toHaveBeenCalledTimes(1);

		// The next gate re-asks, and the truth comes through.
		mockListDocuments.mockResolvedValue({ documents: [], isPro: true });
		await plugin.refreshProStatusIfStale();
		expect(mockListDocuments).toHaveBeenCalledTimes(2);
		expect(plugin.isPro).toBe(true);
	});

	it("invalidateProStatus forces the next gate to re-ask (account switch)", async () => {
		// A pasted API key is a new identity: a still-fresh timestamp from the old
		// account must not suppress the check for the new one.
		const plugin = proPlugin();
		await plugin.loadSettings();
		mockListDocuments.mockResolvedValue({ documents: [], isPro: false });

		await plugin.checkProStatus();
		expect(mockListDocuments).toHaveBeenCalledTimes(1);
		expect(plugin.isPro).toBe(false);

		// Simulate connecting a different (Pro) account.
		plugin.invalidateProStatus();
		mockListDocuments.mockResolvedValue({ documents: [], isPro: true });

		await plugin.refreshProStatusIfStale();
		expect(mockListDocuments).toHaveBeenCalledTimes(2);
		expect(plugin.isPro).toBe(true);
	});

	it("does nothing without an API key", async () => {
		const plugin = createPlugin({
			settings: { apiKey: "", stripTags: true, autoCopyLink: true },
			publishedNotes: {},
		});
		await plugin.loadSettings();

		await plugin.refreshProStatusIfStale();
		expect(mockListDocuments).not.toHaveBeenCalled();
	});
});
