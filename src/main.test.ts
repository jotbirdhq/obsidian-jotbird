import { describe, it, expect, vi, beforeEach } from "vitest";
import { TFile, MarkdownView, requestUrl } from "obsidian";
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
}));

import { publishNote, trialPublish, listDocuments, deleteDocument, trialDeleteDocument, claimDocument } from "./api";
import { DocumentListModal } from "./modals";

const mockPublishNote = vi.mocked(publishNote);
const mockTrialPublish = vi.mocked(trialPublish);
const mockListDocuments = vi.mocked(listDocuments);
const mockDeleteDocument = vi.mocked(deleteDocument);
const mockTrialDeleteDocument = vi.mocked(trialDeleteDocument);
const mockClaimDocument = vi.mocked(claimDocument);

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

		expect(plugin.addRibbonIcon).toHaveBeenCalledWith("jotbird", "Publish to JotBird", expect.any(Function));
		expect(plugin.addCommand).toHaveBeenCalledTimes(4);
		expect(plugin.addSettingTab).toHaveBeenCalledOnce();
		// 4 registerEvent calls: file-menu, active-leaf-change, vault.rename, vault.delete
		expect(plugin.registerEvent).toHaveBeenCalledTimes(4);

		// Verify command IDs
		const commandIds = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.map(
			(call: unknown[]) => (call[0] as { id: string }).id
		);
		expect(commandIds).toContain("publish-current-note");
		expect(commandIds).toContain("copy-jotbird-link");
		expect(commandIds).toContain("unpublish-current-note");
		expect(commandIds).toContain("list-published-documents");
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
			undefined // no existing slug
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
			"my-existing-doc" // existing slug passed
		);
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
			undefined
		);

		const stored = plugin.publishedNotes["test.md"];
		expect(stored).toBeDefined();
		expect(stored.slug).toBe("trial-note");
		expect(stored.editToken).toBe("tok_edit123");
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
			undefined
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
			undefined
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
			undefined
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
			"jb_key", "# Expired Note\n\nContent", "Expired Note", "old-expired-slug",
		]);
		// Second call: fresh publish without slug
		expect(mockPublishNote.mock.calls[1]).toEqual([
			"jb_key", "# Expired Note\n\nContent", "Expired Note",
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
			"fp_test", "# Trial Expired\n\nContent", "Trial Expired", "old-trial-slug", "tok_old",
		]);
		// Second call: fresh publish without slug/editToken
		expect(mockTrialPublish.mock.calls[1]).toEqual([
			"fp_test", "# Trial Expired\n\nContent", "Trial Expired",
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
			(call: unknown[]) => (call[0] as { id: string }).id === "copy-jotbird-link"
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
			expect(mockDeleteDocument).toHaveBeenCalledWith("jb_key", "remove-doc");
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
			"tok_edit789"
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
		await handler({ action: "jotbird", token: "jb_abc123def456" });

		expect(plugin.settings.apiKey).toBe("jb_abc123def456");
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
		await handler({ action: "jotbird", token: "jb_newkey123" });

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
		await handler({ action: "jotbird", token: "jb_key123" });

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
		await handler({ action: "jotbird", token: "jb_key123" });

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
