import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type JotBirdPlugin from "./main";
import type { JotBirdSettings } from "./types";
import { SITE_URL, THEME_OPTIONS } from "./types";
import { getPortalUrl } from "./api";

/**
 * How long to wait after the user stops typing in the API-key field before
 * treating the key as final. The field's onChange fires on EVERY keystroke, so
 * acting on it directly would send one authenticated request per character —
 * each with a truncated, invalid key — and would reset the Pro-check TTL on
 * every one of them, making the throttle useless.
 */
const API_KEY_DEBOUNCE_MS = 600;

/**
 * The exact shape of a JotBird API key: `"jb_" + 32 random bytes as hex`
 * (see `app/api/auth/cli-token/route.ts`), i.e. 67 characters.
 *
 * Checking this locally is what makes a half-typed key FREE and harmless: a
 * prefix can never match, so it never costs a request, and it never reaches the
 * re-render path that would delete the field the user is typing into. Verifying
 * with the server is then reserved for the case that actually needs it — a
 * well-formed key that is revoked, or belongs to someone else.
 */
const API_KEY_PATTERN = /^jb_[0-9a-f]{64}$/;

/**
 * A value that could still GROW into a valid key — i.e. what the field looks
 * like mid-typing.
 *
 * The debounce cannot tell "paused to think" from "finished", so the malformed-
 * key warning must never fire on anything that is merely incomplete: that would
 * scold users for typing slowly. It fires only for values that can never become
 * a key (wrong characters, wrong prefix, too long) — which is exactly the case
 * that is otherwise saved in silence and only surfaces as a 401 at publish time.
 */
const API_KEY_PREFIX_PATTERN = /^(j|jb|jb_[0-9a-f]{0,63})$/;

export class JotBirdSettingTab extends PluginSettingTab {
	plugin: JotBirdPlugin;
	private keyDebounceTimer: number | null = null;
	// Bumped whenever a pending/in-flight key check is superseded or cancelled.
	// The async check compares against it after its await, so a check that is
	// already in flight when the pane closes can't render into a dead view.
	private keyCheckGeneration = 0;

	constructor(app: App, plugin: JotBirdPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Called on every keystroke in the API-key field. Decides, once the user
	 * stops typing, whether to verify the key with the server.
	 *
	 * ⚠️ **`API_KEY_PATTERN` is the load-bearing line here** — not the conditional
	 * re-render below it. `display()` hides the API-key field whenever
	 * `settings.apiKey` is non-empty, so anything that re-renders on a half-typed
	 * key ("jb_", after a pause) deletes the input the user is still typing into.
	 * The shape gate stops a prefix at the door: no request, no re-render, no way
	 * to reach either hazard. Do not remove it on the theory that the
	 * `if (keyWorks)` check downstream covers the same ground — it does not; it
	 * only covers a WELL-FORMED key that turns out to be revoked or wrong.
	 */
	private scheduleKeyConnect(): void {
		this.cancelKeyConnect();

		const key = this.plugin.settings.apiKey;
		if (!API_KEY_PATTERN.test(key)) {
			// Still growing into a key (the user is mid-typing): say nothing, spend
			// nothing. But a value that can NEVER be a key — a wrong token, a
			// mangled paste — is worth telling them about, because it is otherwise
			// saved in silence and only surfaces as a 401 at their next publish.
			if (key.length > 0 && !API_KEY_PREFIX_PATTERN.test(key)) {
				this.scheduleMalformedKeyNotice();
			}
			return;
		}

		const generation = this.keyCheckGeneration;
		// window.* timers, not the bare globals: Obsidian runs plugins in popout
		// windows too (obsidianmd/prefer-window-timers).
		this.keyDebounceTimer = window.setTimeout(() => {
			this.keyDebounceTimer = null;
			void (async () => {
				// A new key is a new identity, so drop the cached Pro answer —
				// otherwise a still-fresh stamp from the previous account would
				// suppress this check.
				this.plugin.invalidateProStatus();
				const keyWorks = await this.plugin.checkProStatus();
				// The await above is a network round trip; the pane may have closed
				// (or the key changed again) while it was in flight. cancelKeyConnect
				// bumps the generation, so a superseded check renders nothing.
				if (generation !== this.keyCheckGeneration) return;
				if (!keyWorks) return; // well-formed but revoked/wrong — leave the field up
				// Re-render so the pane stops showing "Connect account". Skip it when
				// the account turned out to be Pro: checkProStatus already re-rendered
				// on that false→true transition, and a second rebuild is pure churn.
				if (!this.plugin.isPro) this.display();
			})();
		}, API_KEY_DEBOUNCE_MS);
	}

	/**
	 * Tell the user their key is malformed — once they've stopped typing, so a
	 * prefix on its way to a valid key never triggers it.
	 */
	private scheduleMalformedKeyNotice(): void {
		this.keyDebounceTimer = window.setTimeout(() => {
			this.keyDebounceTimer = null;
			// Re-check on fire: the user may have fixed it during the debounce.
			const key = this.plugin.settings.apiKey;
			if (API_KEY_PATTERN.test(key) || API_KEY_PREFIX_PATTERN.test(key)) return;
			new Notice(
				"That doesn't look like a JotBird API key. Copy it again from your account page.",
				8000
			);
		}, API_KEY_DEBOUNCE_MS);
	}

	/**
	 * Cancel any pending key check — both one still waiting on its debounce timer
	 * AND one already awaiting the server (the generation bump makes the latter a
	 * no-op when it resolves).
	 */
	private cancelKeyConnect(): void {
		this.keyCheckGeneration++;
		if (this.keyDebounceTimer !== null) {
			window.clearTimeout(this.keyDebounceTimer);
			this.keyDebounceTimer = null;
		}
	}

	/** Obsidian calls this when the settings pane closes. */
	hide(): void {
		// Don't let a pending — or in-flight — check render into a closed view.
		this.cancelKeyConnect();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// `plugin.isPro` is a cache populated at startup. If that check failed (an
		// offline launch, a transient 5xx) it stays false for the session, and a
		// paying subscriber would find the Pro-gated defaults below refusing their
		// selections. Refresh in the background; checkProStatus re-renders this tab
		// itself when the answer flips to Pro, so the controls unlock on their own.
		// (Same reasoning as PageSettingsModal.load() — the server is the only
		// authority on Pro, never a cached local flag.)
		if (!this.plugin.isPro) {
			void this.plugin.refreshProStatusIfStale();
		}

		// Nonce is minted per click below (beginAccountConnect) and appended as `state`.
		const buildConnectUrl = () =>
			`${SITE_URL}/account/api-key?obsidian=1&state=${encodeURIComponent(this.plugin.beginAccountConnect())}`;

		if (this.plugin.settings.apiKey) {
			const accountDesc = this.plugin.isPro
				? "Connected (Pro)."
				: "Connected. Your published links get extended expiration.";
			new Setting(containerEl)
				.setName("Account")
				.setDesc(accountDesc)
				.addButton((btn) =>
					btn
						.setButtonText("Disconnect")
						.setWarning()
						.onClick(async () => {
							// A key-connect check may be pending from a paste the user
							// then disconnected; it must not fire against the new state.
							this.cancelKeyConnect();
							this.plugin.settings.apiKey = "";
							// Clears isPro AND the check's freshness stamp: a stale
							// timestamp from this account would otherwise suppress the
							// Pro check for whatever account is connected next.
							this.plugin.invalidateProStatus();
							this.plugin.proRefreshDone = false;
							await this.plugin.saveSettings();
							this.display();
						})
				);

			if (this.plugin.isPro) {
				new Setting(containerEl)
					.setName("Subscription")
					.setDesc(
						"Your subscription is active. All published links are permanent and will never expire."
					)
					.addButton((btn) =>
						btn
							.setButtonText("Manage subscription")
							.onClick(async () => {
								btn.setDisabled(true);
								btn.setButtonText("Loading...");
								try {
									const url = await getPortalUrl(
										this.plugin.settings.apiKey
									);
									window.open(url);
								} catch (e) {
									new Notice(`${e instanceof Error ? e.message : "Failed to open portal"}`);
								} finally {
									btn.setDisabled(false);
									btn.setButtonText("Manage subscription");
								}
							})
					);
			} else {
				const upgradeUrl = `${SITE_URL}/pro?obsidian=1`;
				new Setting(containerEl)
					.setName("Upgrade")
					.setDesc(
						"Get permanent links that never expire, plus priority support."
					)
					.addButton((btn) =>
						btn
							.setButtonText("Upgrade")
							.setCta()
							.onClick(() => {
								window.open(upgradeUrl);
							})
					);
			}
		} else {
			new Setting(containerEl)
				.setName("Account")
				.setDesc(
					"Connect an account for 90-day links, or upgrade for permanent links."
				)
				.addButton((btn) =>
					btn
						.setButtonText("Connect account")
						.setCta()
						.onClick(() => {
							window.open(buildConnectUrl());
						})
				);
		}

		if (!this.plugin.settings.apiKey) {
			new Setting(containerEl)
				.setName("API key")
				.setDesc(
					"Or paste your key manually. Without a key, links expire after 30 days."
				)
				.addText((text) =>
					text
						.setValue(this.plugin.settings.apiKey)
						.onChange(async (value) => {
							this.plugin.settings.apiKey = value.trim();
							// onChange fires per KEYSTROKE. Never hit the network from
							// here — debounce, so a typed-out key costs one request for
							// the finished key rather than one 401 per prefix.
							//
							// Schedule BEFORE the await: the timer must exist synchronously
							// so hide()/Disconnect can cancel it. Scheduling after the await
							// would let a pane the user already closed still fire a check.
							this.scheduleKeyConnect();
							await this.plugin.saveSettings();
						})
				)
				.then((setting) => {
					const input = setting.controlEl.querySelector("input");
					if (input) {
						input.type = "password";
						input.addClass("jotbird-api-key-input");
					}
				});
		}

		new Setting(containerEl)
			.setName("Strip tags")
			.setDesc("Remove #tags from notes before publishing.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.stripTags)
					.onChange(async (value) => {
						this.plugin.settings.stripTags = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Page title")
			.setDesc(
				"What to show as the title on the published page. Automatic keeps the original behavior (adds a heading from the filename only if the note has none)."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("auto", "Automatic")
					.addOption("filename", "Filename")
					.addOption("h1", "First heading")
					.setValue(this.plugin.settings.titleMode)
					.onChange(async (value) => {
						this.plugin.settings.titleMode = value as JotBirdSettings["titleMode"];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auto-copy link")
			.setDesc("Automatically copy the published URL to clipboard after publishing.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoCopyLink)
					.onChange(async (value) => {
						this.plugin.settings.autoCopyLink = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Store frontmatter")
			.setDesc(
				"After publishing, save the published URL and expiration in your note's frontmatter properties. Disable if you prefer not to modify your notes."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.storeFrontmatter)
					.onChange(async (value) => {
						this.plugin.settings.storeFrontmatter = value;
						await this.plugin.saveSettings();
					})
			);

		// --- Page settings defaults ---
		// Both defaults ship as "Leave as-is (don't manage)": nothing is sent
		// with a publish, so the server preserves whatever each page already has
		// (a theme set in the web app survives an Obsidian republish). Once the
		// user picks a value, they've declared the plugin authoritative and it
		// rides every publish. Per-note frontmatter overrides either default —
		// the small print here is the discoverability mechanism for those keys.
		new Setting(containerEl).setName("Published pages").setHeading();

		const isPro = this.plugin.isPro;
		const proNote = isPro ? "" : " Requires Pro.";

		new Setting(containerEl)
			.setName("Default theme")
			.setDesc(
				`Theme for every note you publish. "Leave as-is" keeps whatever each page already has (set per page in the web app or the page settings dialog). Add a jotbird_theme property to a note to override this for that note.${proNote}`
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("", "Leave as-is (don't manage)");
				for (const [value, label] of Object.entries(THEME_OPTIONS)) {
					dropdown.addOption(value, label);
				}
				dropdown.setValue(this.plugin.settings.defaultTheme);
				dropdown.onChange(async (value) => {
					// Only ENABLING a theme is Pro-gated. "Leave as-is" and "Default"
					// are the non-Pro values (the latter CLEARS a theme, which the
					// server allows any account to do), so never disable the whole
					// control — that would strand a lapsed subscriber who wants to
					// clear a theme across the vault. Bounce only the Pro values.
					if (!isPro && value !== "" && value !== "default") {
						dropdown.setValue(this.plugin.settings.defaultTheme);
						new Notice("Themes require Pro.");
						return;
					}
					this.plugin.settings.defaultTheme = value as JotBirdSettings["defaultTheme"];
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Default branding")
			.setDesc(
				`Whether published pages show "Published with JotBird". "Leave as-is" keeps each page's current setting. Add a jotbird_hide_branding property to a note to override this for that note.${proNote}`
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("", "Leave as-is (don't manage)");
				dropdown.addOption("show", "Show branding");
				dropdown.addOption("hide", "Hide branding");
				dropdown.setValue(this.plugin.settings.defaultHideBranding);
				dropdown.onChange(async (value) => {
					// Same rule as the theme above: only "hide" is Pro-gated.
					// "Show branding" clears the setting and is free to anyone.
					if (!isPro && value === "hide") {
						dropdown.setValue(this.plugin.settings.defaultHideBranding);
						new Notice("Hiding branding requires Pro.");
						return;
					}
					this.plugin.settings.defaultHideBranding = value as JotBirdSettings["defaultHideBranding"];
					await this.plugin.saveSettings();
				});
			});
	}
}
