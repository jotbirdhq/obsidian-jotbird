import { describe, it, expect, vi, beforeEach } from "vitest";
import { Notice, renderedSettings, resetRenderedSettings } from "obsidian";

vi.mock("./api", () => ({ getPortalUrl: vi.fn() }));

import { JotBirdSettingTab } from "./settings";
import type JotBirdPlugin from "./main";

const mockNotice = vi.mocked(Notice);

function makePlugin(over: Record<string, unknown> = {}): JotBirdPlugin {
	const plugin = {
		settings: {
			apiKey: "jb_key",
			stripTags: true,
			autoCopyLink: true,
			storeFrontmatter: true,
			titleMode: "auto",
			defaultTheme: "",
			defaultHideBranding: "",
		},
		isPro: false,
		refreshProStatusIfStale: vi.fn().mockResolvedValue(undefined),
		invalidateProStatus: vi.fn(),
		// Returns whether the server ANSWERED (i.e. the key is usable) — not
		// whether the account is Pro. Default: the key works.
		checkProStatus: vi.fn().mockResolvedValue(true),
		beginAccountConnect: vi.fn().mockReturnValue("nonce"),
		saveSettings: vi.fn().mockResolvedValue(undefined),
		...over,
	};
	return plugin as unknown as JotBirdPlugin;
}


/** A realistically-shaped key: "jb_" + 32 random bytes as hex, per the server's
 * key minting (app/api/auth/cli-token/route.ts). The settings tab rejects
 * anything else locally, so tests must use the real shape. */
const VALID_KEY = "jb_" + "ab12cd34".repeat(8);

function tabFor(plugin: JotBirdPlugin): JotBirdSettingTab {
	const tab = new JotBirdSettingTab({} as never, plugin);
	tab.display();
	return tab;
}

function settingNamed(name: string) {
	const matches = renderedSettings.filter((s) => s.name === name);
	expect(matches, `expected exactly one "${name}" setting`).toHaveLength(1);
	return matches[0];
}

beforeEach(() => {
	vi.clearAllMocks();
	resetRenderedSettings();
});

describe("settings tab — Pro status", () => {
	it("refreshes Pro status on open rather than trusting a possibly-stale cache", () => {
		// Same failure as the modal had: a Pro user whose startup check failed
		// (offline launch) would otherwise be told "Themes require Pro." all session.
		const plugin = makePlugin();
		tabFor(plugin);
		expect(plugin.refreshProStatusIfStale).toHaveBeenCalled();
	});

	it("does not re-check when already known to be Pro", () => {
		const plugin = makePlugin({ isPro: true });
		tabFor(plugin);
		expect(plugin.refreshProStatusIfStale).not.toHaveBeenCalled();
	});
});

describe("settings tab — vault defaults are gated per VALUE, not per control", () => {
	it("lets a free account select the non-Pro values (they clear, which anyone may do)", async () => {
		const plugin = makePlugin();
		tabFor(plugin);

		// "Default" theme clears a theme — allowed for any account.
		const theme = settingNamed("Default theme").dropdowns[0];
		theme.select("default");
		await vi.waitFor(() => {
			expect(plugin.saveSettings).toHaveBeenCalled();
		});
		expect(plugin.settings.defaultTheme).toBe("default");

		// "Show branding" likewise.
		const branding = settingNamed("Default branding").dropdowns[0];
		branding.select("show");
		expect(plugin.settings.defaultHideBranding).toBe("show");
	});

	it("bounces a free account off the Pro values with a Notice", () => {
		const plugin = makePlugin();
		tabFor(plugin);

		settingNamed("Default theme").dropdowns[0].select("essay");
		expect(plugin.settings.defaultTheme).toBe("");
		expect(
			mockNotice.mock.calls.map((c) => c[0] as string).some((m) => /Themes require Pro/i.test(m))
		).toBe(true);

		settingNamed("Default branding").dropdowns[0].select("hide");
		expect(plugin.settings.defaultHideBranding).toBe("");
	});

	it("lets a Pro account set the Pro values", async () => {
		const plugin = makePlugin({ isPro: true });
		tabFor(plugin);

		settingNamed("Default theme").dropdowns[0].select("essay");
		await vi.waitFor(() => {
			expect(plugin.settings.defaultTheme).toBe("essay");
		});

		settingNamed("Default branding").dropdowns[0].select("hide");
		await vi.waitFor(() => {
			expect(plugin.settings.defaultHideBranding).toBe("hide");
		});
	});
});

describe("settings tab — account switching invalidates the Pro cache", () => {
	it("drops the cached Pro answer on Disconnect", async () => {
		const plugin = makePlugin({ isPro: true });
		tabFor(plugin);

		const disconnect = renderedSettings
			.flatMap((s) => s.buttons)
			.find((b) => b.text === "Disconnect");
		expect(disconnect).toBeDefined();
		disconnect!.click();

		await vi.waitFor(() => {
			expect(plugin.invalidateProStatus).toHaveBeenCalled();
		});
		expect(plugin.settings.apiKey).toBe("");
	});

	it("⚠️ debounces: typing a key costs ONE request, not one per keystroke", async () => {
		// TextComponent.onChange fires on EVERY input event. Hitting the network
		// from there sent one authenticated request per character — each with a
		// truncated, invalid key (jb_, jb_a, jb_ab...) — and reset the Pro-check
		// TTL on every one, making the throttle useless.
		vi.useFakeTimers();
		try {
			const plugin = makePlugin({ settings: { apiKey: "" } as never });
			tabFor(plugin);
			// display() legitimately refreshes Pro on render; baseline from here so
			// the assertions below are about the KEY FIELD only.
			vi.mocked(plugin.refreshProStatusIfStale).mockClear();
			vi.mocked(plugin.invalidateProStatus).mockClear();

			const keyField = renderedSettings.find((s) => s.name === "API key")?.texts[0];
			expect(keyField).toBeDefined();

			// Simulate typing the key out, character by character.
			const key = VALID_KEY;
			for (let i = 1; i <= key.length; i++) {
				keyField!.type(key.slice(0, i));
			}

			// Nothing has gone out yet — the user is still typing.
			expect(plugin.invalidateProStatus).not.toHaveBeenCalled();
			expect(plugin.refreshProStatusIfStale).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(700);

			// Exactly one identity reset and one server check, for the COMPLETE key
			// — not one per prefix.
			expect(plugin.invalidateProStatus).toHaveBeenCalledTimes(1);
			expect(plugin.checkProStatus).toHaveBeenCalledTimes(1);
			expect(plugin.settings.apiKey).toBe(key);
		} finally {
			vi.useRealTimers();
		}
	});

	it("re-renders once a WORKING key is verified, even for a free account", async () => {
		// checkProStatus only re-renders itself on a false→true Pro transition, so
		// a valid FREE key would otherwise leave the pane showing "Connect account".
		vi.useFakeTimers();
		try {
			const plugin = makePlugin({ settings: { apiKey: "" } as never });
			const tab = tabFor(plugin);
			vi.mocked(plugin.checkProStatus).mockResolvedValue(true); // key works, free
			const displaySpy = vi.spyOn(tab, "display");

			const keyField = renderedSettings.find((s) => s.name === "API key")?.texts[0];
			keyField!.type(VALID_KEY);

			await vi.advanceTimersByTimeAsync(700);

			expect(displaySpy).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("⚠️ a half-typed key costs ZERO requests and never re-renders", async () => {
		// A prefix can't match the key format, so it is rejected locally: no round
		// trip, and no re-render (display() hides the API-key field once apiKey is
		// non-empty, which would delete the input mid-typing).
		vi.useFakeTimers();
		try {
			const plugin = makePlugin({ settings: { apiKey: "" } as never });
			const tab = tabFor(plugin);
			const displaySpy = vi.spyOn(tab, "display");

			const keyField = renderedSettings.find((s) => s.name === "API key")?.texts[0];
			keyField!.type("jb_ab12cd34"); // ...user pauses to think...

			await vi.advanceTimersByTimeAsync(700);

			expect(plugin.checkProStatus).not.toHaveBeenCalled();
			expect(displaySpy).not.toHaveBeenCalled();
			// The field the user is typing into is still there.
			expect(renderedSettings.some((s) => s.name === "API key")).toBe(true);
			// …and no scolding Notice, either: they are mid-word, not wrong.
			expect(
				mockNotice.mock.calls.map((c) => c[0] as string).some((m) => /API key/i.test(m))
			).toBe(false);

			// Finishing the key verifies it and connects.
			keyField!.type(VALID_KEY);
			await vi.advanceTimersByTimeAsync(700);
			expect(plugin.checkProStatus).toHaveBeenCalledTimes(1);
			expect(displaySpy).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("⚠️ an in-flight check does not render into a pane the user has closed", async () => {
		// hide() clearing the timer is not enough: once the timer has FIRED, the
		// code is parked on a network await that hide() cannot reach.
		vi.useFakeTimers();
		try {
			const plugin = makePlugin({ settings: { apiKey: "" } as never });
			const tab = tabFor(plugin);

			let resolveCheck!: (works: boolean) => void;
			vi.mocked(plugin.checkProStatus).mockReturnValue(
				new Promise<boolean>((res) => {
					resolveCheck = res;
				})
			);
			const displaySpy = vi.spyOn(tab, "display");

			const keyField = renderedSettings.find((s) => s.name === "API key")?.texts[0];
			keyField!.type(VALID_KEY);

			// Let the debounce fire: the check is now IN FLIGHT.
			await vi.advanceTimersByTimeAsync(700);
			expect(plugin.checkProStatus).toHaveBeenCalledTimes(1);

			// The user closes Settings while the request is still out...
			tab.hide();
			// ...and only then does it come back, successfully.
			resolveCheck(true);
			await vi.advanceTimersByTimeAsync(0);

			expect(displaySpy).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("a pending key check does not fire after the pane closes", async () => {
		vi.useFakeTimers();
		try {
			const plugin = makePlugin({ settings: { apiKey: "" } as never });
			const tab = tabFor(plugin);
			vi.mocked(plugin.refreshProStatusIfStale).mockClear();

			const keyField = renderedSettings.find((s) => s.name === "API key")?.texts[0];
			keyField!.type(VALID_KEY);
			tab.hide();

			await vi.advanceTimersByTimeAsync(700);

			expect(plugin.checkProStatus).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("settings tab — malformed API key", () => {
	it("tells the user when a value can NEVER be a key", async () => {
		// A wrong token (or a mangled paste) is otherwise saved in silence, and
		// only surfaces as a 401 at the next publish.
		vi.useFakeTimers();
		try {
			const plugin = makePlugin({ settings: { apiKey: "" } as never });
			tabFor(plugin);

			const keyField = renderedSettings.find((s) => s.name === "API key")?.texts[0];
			keyField!.type("sk-live-someone-elses-token");

			await vi.advanceTimersByTimeAsync(700);

			expect(plugin.checkProStatus).not.toHaveBeenCalled(); // no wasted request
			expect(
				mockNotice.mock.calls
					.map((c) => c[0] as string)
					.some((m) => /doesn't look like a JotBird API key/i.test(m))
			).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("⚠️ does NOT scold a key that is merely half-typed", async () => {
		// The debounce cannot tell "paused to think" from "finished", so anything
		// that could still grow into a key must stay silent — otherwise we nag
		// users for typing slowly.
		vi.useFakeTimers();
		try {
			const plugin = makePlugin({ settings: { apiKey: "" } as never });
			tabFor(plugin);

			const keyField = renderedSettings.find((s) => s.name === "API key")?.texts[0];
			keyField!.type(VALID_KEY.slice(0, -4)); // a valid prefix — still typing

			await vi.advanceTimersByTimeAsync(700);

			expect(
				mockNotice.mock.calls
					.map((c) => c[0] as string)
					.some((m) => /doesn't look like/i.test(m))
			).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not scold a valid key", async () => {
		vi.useFakeTimers();
		try {
			const plugin = makePlugin({ settings: { apiKey: "" } as never });
			tabFor(plugin);

			const keyField = renderedSettings.find((s) => s.name === "API key")?.texts[0];
			keyField!.type(VALID_KEY);

			await vi.advanceTimersByTimeAsync(700);

			expect(
				mockNotice.mock.calls
					.map((c) => c[0] as string)
					.some((m) => /doesn't look like/i.test(m))
			).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("settings tab — no duplicate render on connect", () => {
	it("leaves the Pro-flip re-render to checkProStatus", async () => {
		// checkProStatus already calls settingTab.display() on a false→true Pro
		// transition; rebuilding the pane again here would be pure churn.
		vi.useFakeTimers();
		try {
			const plugin = makePlugin({ settings: { apiKey: "" } as never });
			const tab = tabFor(plugin);
			// A Pro key: the check flips isPro and (in the real plugin) re-renders.
			vi.mocked(plugin.checkProStatus).mockImplementation(async () => {
				plugin.isPro = true;
				return true;
			});
			const displaySpy = vi.spyOn(tab, "display");

			const keyField = renderedSettings.find((s) => s.name === "API key")?.texts[0];
			keyField!.type(VALID_KEY);
			await vi.advanceTimersByTimeAsync(700);

			expect(displaySpy).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("still re-renders for a working FREE key (nobody else will)", async () => {
		vi.useFakeTimers();
		try {
			const plugin = makePlugin({ settings: { apiKey: "" } as never });
			const tab = tabFor(plugin);
			vi.mocked(plugin.checkProStatus).mockResolvedValue(true); // works, stays free
			const displaySpy = vi.spyOn(tab, "display");

			const keyField = renderedSettings.find((s) => s.name === "API key")?.texts[0];
			keyField!.type(VALID_KEY);
			await vi.advanceTimersByTimeAsync(700);

			expect(displaySpy).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
