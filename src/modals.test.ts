import { describe, it, expect, vi, beforeEach } from "vitest";
import { TFile, Notice, renderedSettings, resetRenderedSettings } from "obsidian";

vi.mock("./api", () => ({
	getPageSettings: vi.fn(),
	updatePageSettings: vi.fn(),
}));

import { getPageSettings, updatePageSettings } from "./api";
import { PageSettingsModal } from "./modals";
import type JotBirdPlugin from "./main";
import type { PageSettingsView, PublishedNote } from "./types";

const mockGetPageSettings = vi.mocked(getPageSettings);
const mockUpdatePageSettings = vi.mocked(updatePageSettings);
const mockNotice = vi.mocked(Notice);

function makeFile(path: string, basename: string): TFile {
	const file = new TFile();
	file.path = path;
	file.basename = basename;
	file.extension = "md";
	return file;
}

const PUBLISHED: PublishedNote = {
	documentId: "doc-1",
	slug: "my-doc",
	url: "https://share.jotbird.com/my-doc",
	publishedAt: "2026-01-01T00:00:00.000Z",
};

function baseView(overrides: Partial<PageSettingsView> = {}): PageSettingsView {
	return {
		slug: "my-doc",
		username: null,
		url: "https://share.jotbird.com/my-doc",
		title: "My Doc",
		theme: "default",
		hideBranding: false,
		visibility: "unlisted",
		tags: [],
		expiresAt: null,
		...overrides,
	};
}

/** A plugin stub with just what the modal touches. */
function makePlugin(isPro: boolean, proCheckFlipsTo?: boolean): JotBirdPlugin {
	const plugin = {
		settings: { apiKey: "jb_key", defaultTheme: "", defaultHideBranding: "" },
		isPro,
		app: { metadataCache: { getFileCache: vi.fn().mockReturnValue(null) } },
		// The real refreshProStatusIfStale refreshes `isPro` from the server
		// (unless it was checked recently).
		refreshProStatusIfStale: vi.fn().mockImplementation(async () => {
			if (proCheckFlipsTo !== undefined) plugin.isPro = proCheckFlipsTo;
		}),
		writePageSettingsFrontmatter: vi.fn(),
	};
	return plugin as unknown as JotBirdPlugin;
}

/** Open the modal and let its async load()/render() settle. */
async function openModal(plugin: JotBirdPlugin): Promise<PageSettingsModal> {
	const modal = new PageSettingsModal(
		plugin.app as never,
		plugin,
		makeFile("notes/my-doc.md", "my-doc"),
		PUBLISHED
	);
	modal.onOpen();
	await vi.waitFor(() => {
		expect(renderedSettings.some((s) => s.name === "Visibility")).toBe(true);
	});
	return modal;
}

function settingNamed(name: string) {
	// Exactly one must exist: contentEl.empty() at the top of render() drops the
	// previous render's Settings, so a stale duplicate here would mean the modal
	// leaked controls across a re-render.
	const matches = renderedSettings.filter((s) => s.name === name);
	expect(matches, `expected exactly one "${name}" setting on screen`).toHaveLength(1);
	return matches[0];
}

function saveButton() {
	const saves = renderedSettings.flatMap((s) => s.buttons).filter((b) => b.text === "Save");
	expect(saves, "expected exactly one Save button on screen").toHaveLength(1);
	return saves[0];
}

beforeEach(() => {
	vi.clearAllMocks();
	resetRenderedSettings();
});

describe("PageSettingsModal — Pro status", () => {
	it("refreshes Pro status on open instead of trusting the cached flag", async () => {
		// A Pro user whose startup check failed (offline launch) has isPro=false
		// cached. Hard-gating on that would disable every control for a paying
		// subscriber for the rest of the session.
		const plugin = makePlugin(false, true);
		mockGetPageSettings.mockResolvedValue(baseView());

		await openModal(plugin);

		expect(plugin.refreshProStatusIfStale).toHaveBeenCalled();
		expect(settingNamed("Theme").dropdowns[0].disabled).toBe(false);
		expect(settingNamed("Hide branding").toggles[0].disabled).toBe(false);
		// No upgrade prompt for a Pro user.
		expect(renderedSettings.some((s) => s.name === "Pro")).toBe(false);
	});

	it("keeps Pro controls disabled for a genuinely free account", async () => {
		const plugin = makePlugin(false, false);
		mockGetPageSettings.mockResolvedValue(baseView());

		await openModal(plugin);

		expect(settingNamed("Theme").dropdowns[0].disabled).toBe(true);
		expect(settingNamed("Hide branding").toggles[0].disabled).toBe(true);
		expect(renderedSettings.some((s) => s.name === "Pro")).toBe(true);
	});

	it("lets a lapsed-Pro account clear settings it can no longer enable", async () => {
		// Clearing is allowed for any account, so the controls must stay live.
		const plugin = makePlugin(false, false);
		mockGetPageSettings.mockResolvedValue(baseView({ theme: "essay", hideBranding: true }));

		await openModal(plugin);

		expect(settingNamed("Theme").dropdowns[0].disabled).toBe(false);
		expect(settingNamed("Hide branding").toggles[0].disabled).toBe(false);
	});
});

describe("PageSettingsModal — password", () => {
	it("sends the password EXACTLY as typed, without trimming", async () => {
		// Trimming would store a different secret than the user entered (a paste
		// with a trailing space is the common case) and lock them out of their own
		// page — the unlock form doesn't trim either.
		const plugin = makePlugin(true);
		mockGetPageSettings.mockResolvedValue(baseView());
		mockUpdatePageSettings.mockResolvedValue(baseView({ visibility: "password" }));

		await openModal(plugin);

		settingNamed("Visibility").dropdowns[0].select("password");
		settingNamed("Password").texts[0].type("  hunter2  ");
		saveButton().click();

		await vi.waitFor(() => {
			expect(mockUpdatePageSettings).toHaveBeenCalled();
		});
		expect(mockUpdatePageSettings.mock.calls[0][2]).toEqual({
			visibility: "password",
			password: "  hunter2  ",
		});
	});

	it("refuses to enable password protection with an empty password", async () => {
		const plugin = makePlugin(true);
		mockGetPageSettings.mockResolvedValue(baseView());

		await openModal(plugin);

		settingNamed("Visibility").dropdowns[0].select("password");
		saveButton().click();

		await vi.waitFor(() => {
			expect(
				mockNotice.mock.calls.map((c) => c[0] as string).some((m) => /Enter a password/i.test(m))
			).toBe(true);
		});
		expect(mockUpdatePageSettings).not.toHaveBeenCalled();
	});

	it("keeps the existing password when the field is left blank on an already-protected page", async () => {
		const plugin = makePlugin(true);
		mockGetPageSettings.mockResolvedValue(baseView({ visibility: "password", theme: "essay" }));
		mockUpdatePageSettings.mockResolvedValue(baseView({ visibility: "password", theme: "minimal" }));

		await openModal(plugin);

		// Change only the theme; leave the password field untouched.
		settingNamed("Theme").dropdowns[0].select("minimal");
		saveButton().click();

		await vi.waitFor(() => {
			expect(mockUpdatePageSettings).toHaveBeenCalled();
		});
		const patch = mockUpdatePageSettings.mock.calls[0][2];
		expect(patch).toEqual({ theme: "minimal" });
		expect(patch).not.toHaveProperty("password");
	});
});

describe("PageSettingsModal — patch construction", () => {
	it("sends only the fields that actually changed", async () => {
		const plugin = makePlugin(true);
		mockGetPageSettings.mockResolvedValue(baseView({ theme: "essay", hideBranding: true }));
		mockUpdatePageSettings.mockResolvedValue(baseView({ theme: "essay", hideBranding: false }));

		await openModal(plugin);

		settingNamed("Hide branding").toggles[0].toggle(false);
		saveButton().click();

		await vi.waitFor(() => {
			expect(mockUpdatePageSettings).toHaveBeenCalled();
		});
		expect(mockUpdatePageSettings.mock.calls[0][2]).toEqual({ hideBranding: false });
	});

	it("does not PATCH when nothing changed", async () => {
		const plugin = makePlugin(true);
		mockGetPageSettings.mockResolvedValue(baseView());

		await openModal(plugin);
		saveButton().click();

		await vi.waitFor(() => {
			expect(
				mockNotice.mock.calls.map((c) => c[0] as string).some((m) => /No changes/i.test(m))
			).toBe(true);
		});
		expect(mockUpdatePageSettings).not.toHaveBeenCalled();
	});

	it("carries the GET-resolved namespace into the PATCH (so the metered call never probes)", async () => {
		// The GET is free and can retry to discover a namespace; the PATCH is
		// charged even when it 404s, so it must be addressed correctly first time.
		const plugin = makePlugin(true);
		mockGetPageSettings.mockResolvedValue(
			baseView({ username: "tester", url: "https://share.jotbird.com/@tester/my-doc" })
		);
		mockUpdatePageSettings.mockResolvedValue(baseView({ username: "tester", theme: "minimal" }));

		const modal = new PageSettingsModal(
			plugin.app as never,
			plugin,
			makeFile("notes/ns.md", "ns"),
			{ slug: "my-doc", url: "u", publishedAt: "" } // no documentId
		);
		modal.onOpen();
		await vi.waitFor(() => {
			expect(renderedSettings.some((s) => s.name === "Visibility")).toBe(true);
		});

		settingNamed("Theme").dropdowns[0].select("minimal");
		saveButton().click();

		await vi.waitFor(() => {
			expect(mockUpdatePageSettings).toHaveBeenCalled();
		});
		expect(mockUpdatePageSettings.mock.calls[0][1]).toEqual({
			documentId: undefined,
			slug: "my-doc",
			namespaced: true,
		});
	});

	it("does not mark a flat page as namespaced", async () => {
		const plugin = makePlugin(true);
		mockGetPageSettings.mockResolvedValue(baseView()); // username: null
		mockUpdatePageSettings.mockResolvedValue(baseView({ theme: "minimal" }));

		await openModal(plugin);
		settingNamed("Theme").dropdowns[0].select("minimal");
		saveButton().click();

		await vi.waitFor(() => {
			expect(mockUpdatePageSettings).toHaveBeenCalled();
		});
		expect(mockUpdatePageSettings.mock.calls[0][1]).toMatchObject({ namespaced: false });
	});

	it("replaces controls on re-render rather than leaking stale ones", async () => {
		const plugin = makePlugin(true);
		mockGetPageSettings.mockResolvedValue(baseView());

		await openModal(plugin);
		// Changing visibility re-renders. settingNamed() asserts a single match, so
		// this would throw if the previous render's controls survived.
		settingNamed("Visibility").dropdowns[0].select("public");
		expect(settingNamed("Theme").dropdowns[0]).toBeDefined();
		expect(saveButton()).toBeDefined();
	});

	it("addresses the document by its stable documentId", async () => {
		const plugin = makePlugin(true);
		mockGetPageSettings.mockResolvedValue(baseView());
		mockUpdatePageSettings.mockResolvedValue(baseView({ theme: "minimal" }));

		await openModal(plugin);
		settingNamed("Theme").dropdowns[0].select("minimal");
		saveButton().click();

		await vi.waitFor(() => {
			expect(mockUpdatePageSettings).toHaveBeenCalled();
		});
		expect(mockUpdatePageSettings.mock.calls[0][1]).toEqual({
			documentId: "doc-1",
			slug: "my-doc",
			namespaced: false,
		});
	});
});
