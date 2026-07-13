import { addIcon, Notice, Plugin, TFile, TAbstractFile, MarkdownView, setIcon } from "obsidian";
import {
	JotBirdSettings,
	DEFAULT_SETTINGS,
	PublishedNote,
	PluginData,
	PublishWarning,
} from "./types";
import {
	publishNote,
	trialPublish,
	listDocuments,
	deleteDocument,
	trialDeleteDocument,
	claimDocument,
	getPageSettings,
	setClientVersion,
} from "./api";
import { processMarkdown, applyTitleMode } from "./markdown";
import {
	resolvePagePublishSettings,
	reconcileNoteProperty,
	FM_THEME,
	FM_HIDE_BRANDING,
	type SettingProperty,
} from "./pageSettings";
import { JotBirdSettingTab } from "./settings";
import { ConfirmModal, DocumentListModal, PageSettingsModal } from "./modals";

/** How long a Pro-status check stays fresh. Long enough that opening the
 * settings tab or the page-settings modal repeatedly doesn't spam the API,
 * short enough that a subscription change is picked up within a session. */
const PRO_CHECK_TTL_MS = 5 * 60 * 1000;

export default class JotBirdPlugin extends Plugin {
	settings: JotBirdSettings = DEFAULT_SETTINGS;
	publishedNotes: Record<string, PublishedNote> = {};
	deviceFingerprint: string = "";
	isPro = false;
	private settingTab: JotBirdSettingTab | null = null;
	proRefreshDone = false;
	// CSRF nonce for the browser sign-in flow: minted when the user clicks "Connect
	// account", verified against the `state` on the obsidian://jotbird?token=… callback,
	// then discarded. In-memory only (a restart mid-flow just means retrying). See the
	// protocol handler in onload().
	private pendingAuthNonce: string | null = null;
	private proCheckInFlight: Promise<void> | null = null;
	// Epoch ms of the last successful Pro check; drives refreshProStatusIfStale.
	private lastProCheckAt = 0;
	private propertyIconTimer: number | null = null;
	// File paths with a publish currently in flight, to block re-entrant calls.
	private publishing = new Set<string>();
	// "<path> <setting>:<reason>" of publish warnings already shown this session,
	// so a standing condition (a vault default the account can't use) doesn't
	// re-toast on every publish of that note — while a warning about a DIFFERENT
	// note is still reported. Scoped per note deliberately; see
	// noticePublishWarnings. In-memory: a restart shows each again once.
	private seenPublishWarnings = new Set<string>();

	// async onload() is the standard Obsidian pattern — the plugin loader awaits it.
	// The pinned 1.4.x typings type onload() as void-returning, which trips
	// @typescript-eslint/no-misused-promises, so the directive below is required.
	// eslint-disable-next-line @typescript-eslint/no-misused-promises -- async onload() is awaited by the Obsidian loader; only the pinned 1.4.x typings type it as void-returning.
	async onload(): Promise<void> {
		// Stamp the real installed version onto outgoing requests' User-Agent
		// before anything can publish, so the worker logs the accurate version.
		setClientVersion(this.manifest.version);
		await this.loadSettings();
		// Defer frontmatter scan until the workspace is ready so it doesn't
		// block plugin startup on vaults with many files.
		this.app.workspace.onLayoutReady(() => this.reconcileFrontmatter());

		// Register frontmatter property types so Obsidian renders them correctly
		const mtm = (this.app as unknown as Record<string, unknown>).metadataTypeManager as
			| { setType(name: string, type: string): void }
			| undefined;
		mtm?.setType("jotbird_link", "text");
		mtm?.setType("jotbird_expires", "text");
		// Settings overrides (user-authored, read-only for the plugin — see
		// pageSettings.ts). Registered so Obsidian renders them natively.
		mtm?.setType(FM_THEME, "text"); // no native enum property type
		mtm?.setType(FM_HIDE_BRANDING, "checkbox");

		// Register custom icon (scaled to fit 0 0 100 100 viewBox)
		addIcon(
			"jotbird",
			'<g transform="translate(2,14) scale(0.1197)" fill="currentColor"><path d="m749.18 258.35c-17.18-46.97-31.77-92.07-87.4-104.45-52.34-9.51-98.9 3.62-158.2 78.02-23.9-98.52-120.15-173.3-206.36-218.41 0 0 39.67 122.68 33.16 241.48 101.25 37.59 203.44 39.32 255.73 35.87-13.25 21.65-27.89 43.56-46.28 65.41-123.12-31.45-290.9-107.02-353.28-288.37 0 0-58.06 158.56 69.86 364.6-48.81 39.83-126.77 56.24-248.36 27.89 45.81 40.48 141.02 65.94 205.14 68.41-36.03 1.8-77.33 44.13-90.24 63.68 100.36-29.78 167.59-26.26 242.21-45.38q3.18-0.81 6.38-1.68c106.87-29.09 157.17-105.05 218.16-164.14 61.02-59.07 143.16-76.02 204.25-53.73 0 0-36.12-45.54-44.77-69.2z"/></g>'
		);

		// Ribbon icon
		this.addRibbonIcon("jotbird", "Publish note", () => {
			void this.publishActiveNote();
		});

		// Command: Publish / Update current note
		this.addCommand({
			id: "publish-current-note",
			name: "Publish current note",
			checkCallback: (checking) => {
				const file = this.getActiveMarkdownFile();
				if (!file) return false;
				if (!checking) void this.publishActiveNote();
				return true;
			},
		});

		// Command: Copy JotBird link
		this.addCommand({
			id: "copy-link",
			name: "Copy link",
			checkCallback: (checking) => {
				const file = this.getActiveMarkdownFile();
				if (!file) return false;
				const published = this.publishedNotes[file.path];
				if (!published) return false;
				if (!checking) {
					void navigator.clipboard.writeText(published.url);
					new Notice("Link copied to clipboard");
				}
				return true;
			},
		});

		// Command: Unpublish current note
		this.addCommand({
			id: "unpublish-current-note",
			name: "Unpublish current note",
			checkCallback: (checking) => {
				const file = this.getActiveMarkdownFile();
				if (!file) return false;
				const published = this.publishedNotes[file.path];
				if (!published) return false;
				if (!checking) this.unpublishNote(file);
				return true;
			},
		});

		// Command: Page settings (theme / branding / visibility of the live page).
		// Only available on a published, account-owned note — there are no page
		// settings until there's a page, and the settings API is API-key-only
		// (anonymous docs, which still carry an editToken, have no settings).
		this.addCommand({
			id: "page-settings",
			name: "Page settings",
			checkCallback: (checking) => {
				const file = this.getActiveMarkdownFile();
				if (!file || !this.canManagePageSettings(file)) return false;
				if (!checking) this.openPageSettings(file);
				return true;
			},
		});

		// Command: Pull page settings into frontmatter — the explicit,
		// user-initiated escape hatch for settings-as-code users. The plugin
		// never writes settings properties on its own (see pageSettings.ts).
		this.addCommand({
			id: "pull-page-settings",
			name: "Pull page settings into properties",
			checkCallback: (checking) => {
				const file = this.getActiveMarkdownFile();
				if (!file || !this.canManagePageSettings(file)) return false;
				if (!checking) void this.pullPageSettings(file);
				return true;
			},
		});

		// Command: List published documents
		this.addCommand({
			id: "list-published-documents",
			name: "List published documents",
			callback: () => {
				void this.showDocumentList();
			},
		});

		// File menu (right-click in file explorer)
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;

				const published = this.publishedNotes[file.path];

				if (published) {
					menu.addItem((item) => {
						item.setTitle("Republish")
							.setIcon("jotbird")
							.onClick(() => this.publishFile(file));
					});
					menu.addItem((item) => {
						item.setTitle("Copy link")
							.setIcon("link")
							.onClick(() => {
								void navigator.clipboard.writeText(published.url);
								new Notice("Link copied to clipboard");
							});
					});
					if (this.canManagePageSettings(file)) {
						menu.addItem((item) => {
							item.setTitle("Page settings")
								.setIcon("settings")
								.onClick(() => this.openPageSettings(file));
						});
					}
					menu.addItem((item) => {
						item.setTitle("Unpublish")
							.setIcon("trash")
							.onClick(() => this.unpublishNote(file));
					});
				} else {
					menu.addItem((item) => {
						item.setTitle("Publish")
							.setIcon("jotbird")
							.onClick(() => this.publishFile(file));
					});
				}
			})
		);

		// Inject action icons next to jotbird_link in the properties panel
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.addPropertyIcons();
			})
		);

		// Track file renames to keep published notes mapping current
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (!(file instanceof TFile)) return;
				const published = this.publishedNotes[oldPath];
				if (published) {
					this.publishedNotes[file.path] = published;
					delete this.publishedNotes[oldPath];
					void this.saveSettings();
				}
				// Dismissed publish warnings are keyed by path; move them with the
				// note so a rename doesn't resurface a warning already seen.
				this.remapNoticeKeys(oldPath, file.path);
			})
		);

		// Track file deletions to clean up mapping
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (!(file instanceof TFile)) return;
				if (this.publishedNotes[file.path]) {
					delete this.publishedNotes[file.path];
					void this.saveSettings();
				}
			})
		);

		// Settings tab
		this.settingTab = new JotBirdSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		// Check Pro status in the background on startup
		void this.checkProStatus();

		// Register obsidian:// protocol handler for API key and Pro upgrade flows
		this.registerObsidianProtocolHandler("jotbird", async (params) => {
			const p = params as Record<string, string>;

			if (p.token && p.token.startsWith("jb_")) {
				// CSRF guard: only accept a token whose `state` matches the nonce we minted
				// when the user clicked "Connect account". Without this, any web page could
				// navigate to obsidian://jotbird?token=jb_<attacker-key> and silently swap in
				// its own account, then auto-claim (and irreversibly transfer ownership of)
				// the user's anonymous documents. Mirrors the VS Code extension's nonce.
				const expected = this.pendingAuthNonce;
				this.pendingAuthNonce = null; // single-use, regardless of outcome
				if (!expected || p.state !== expected) {
					new Notice(
						"Sign-in couldn't be verified. Please try connecting your account again."
					);
					return;
				}
				this.settings.apiKey = p.token;
				await this.saveSettings();
				new Notice("Account connected successfully!");
				this.settingTab?.display();
				// Check Pro status and claim anonymous documents in the background
				void this.checkProStatus();
				void this.claimAnonymousDocuments();
			} else if (p.upgraded === "1") {
				await this.handleProUpgrade();
			} else {
				new Notice("Invalid token received. Please try again.");
			}
		});
	}

	/**
	 * Start the browser sign-in flow: mint a single-use CSRF nonce, remember it, and
	 * return it so the caller can pass it as `state` in the connect URL. The
	 * obsidian://jotbird?token=… callback is only honored when its `state` matches this
	 * nonce (see the protocol handler in onload()).
	 */
	beginAccountConnect(): string {
		this.pendingAuthNonce = crypto.randomUUID();
		return this.pendingAuthNonce;
	}

	private getActiveMarkdownFile(): TFile | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view?.file) return view.file;
		// Fallback: after a modal closes, the active view may not be a
		// MarkdownView yet. getActiveFile() still returns the correct file.
		const file = this.app.workspace.getActiveFile?.();
		return file instanceof TFile && file.extension === "md" ? file : null;
	}

	private addPropertyIcons(): void {
		if (this.propertyIconTimer !== null) {
			window.clearInterval(this.propertyIconTimer);
		}
		let count = 0;
		this.propertyIconTimer = window.setInterval(() => {
			if (++count > 8) {
				window.clearInterval(this.propertyIconTimer!);
				this.propertyIconTimer = null;
				return;
			}
			const file = this.app.workspace.getActiveFile?.();
			if (!(file instanceof TFile)) return;
			const published = this.publishedNotes[file.path];
			if (!published) return;

			activeDocument
				.querySelectorAll(
					'div.metadata-property[data-property-key="jotbird_link"]'
				)
				.forEach((propertyEl) => {
					const valueEl = propertyEl.querySelector(
						"div.metadata-property-value"
					);
					if (!valueEl || valueEl.querySelector("div.jotbird-icons"))
						return;

					const iconsEl = activeDocument.createElement("div");
					iconsEl.classList.add("jotbird-icons");

					const updateIcon = iconsEl.createEl("span");
					updateIcon.title = "Republish";
					setIcon(updateIcon, "upload-cloud");
					updateIcon.onclick = () => this.publishFile(file);

					const copyIcon = iconsEl.createEl("span");
					copyIcon.title = "Copy link";
					setIcon(copyIcon, "copy");
					copyIcon.onclick = async () => {
						await navigator.clipboard.writeText(published.url);
						new Notice("Link copied to clipboard");
					};

					const deleteIcon = iconsEl.createEl("span");
					deleteIcon.title = "Unpublish";
					setIcon(deleteIcon, "trash-2");
					deleteIcon.onclick = () => this.unpublishNote(file);

					valueEl.prepend(iconsEl);
				});
			window.clearInterval(this.propertyIconTimer!);
			this.propertyIconTimer = null;
		}, 50);
	}

	private requireApiKey(): boolean {
		if (!this.settings.apiKey) {
			new Notice("Please set your API key in settings.");
			return false;
		}
		return true;
	}

	private async writeFrontmatter(
		file: TFile,
		url: string,
		expiresAt: string,
		ttlDays: number | null
	): Promise<void> {
		if (!this.settings.storeFrontmatter) return;
		try {
			await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				// Delete and re-add to ensure jotbird_link appears before jotbird_expires
				delete fm["jotbird_link"];
				delete fm["jotbird_expires"];
				fm["jotbird_link"] = url;
				fm["jotbird_expires"] = !ttlDays ? "never" : (expiresAt?.slice(0, 10) ?? "never");
				// Clean up old property names from previous versions
				delete fm["jotbird_url"];
				delete fm["jotbird_slug"];
				delete fm["jotbird_published"];
			});
		} catch (e) {
			console.warn("JotBird: Failed to write frontmatter", e);
		}
	}

	private async clearFrontmatter(file: TFile): Promise<void> {
		if (!this.settings.storeFrontmatter) return;
		try {
			await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				// ⚠️ Delete only the plugin-written RECEIPTS (link/expires + legacy
				// names). NEVER add the user-authored settings properties
				// (jotbird_theme, jotbird_hide_branding) to this list: unpublish
				// removes the receipt, not the user's intent — stripping their
				// per-note configuration here would silently destroy it.
				delete fm["jotbird_link"];
				delete fm["jotbird_expires"];
				// Clean up old property names from previous versions
				delete fm["jotbird_url"];
				delete fm["jotbird_slug"];
				delete fm["jotbird_published"];
			});
		} catch (e) {
			console.warn("JotBird: Failed to clear frontmatter", e);
		}
	}

	/**
	 * Surface the settings the server dropped, as ONE Notice.
	 *
	 * A standing condition (a free/lapsed account with a vault-wide default, or a
	 * Pro property in a template note) makes the server warn on EVERY publish of
	 * that note, forever. Emitting one toast per warning on top of the
	 * "Published!" toast turns that into permanent noise, so warnings are
	 * collapsed into a single Notice and suppressed on repeat.
	 *
	 * ⚠️ The suppression key is scoped to the NOTE. Keying it on
	 * `setting:reason` alone silently swallows a genuine warning about a
	 * *different* file — publish note A with a typo'd theme, and note B's typo
	 * would never be reported — which is the very silent-drop failure this whole
	 * feature exists to end. Suppress the repeat, never the first word about a
	 * note.
	 *
	 * `pro_lapsed` is never suppressed: it fires once per page by construction
	 * (the strip removes the value) and is a churn-worthy event.
	 */
	private noticePublishWarnings(file: TFile, warnings: PublishWarning[] | undefined): void {
		if (!warnings || warnings.length === 0) return;

		const lapsed = warnings.filter((w) => w.reason === "pro_lapsed");
		const rest = warnings.filter((w) => w.reason !== "pro_lapsed");

		// Query, then record. Folding the mutation into the filter predicate makes
		// suppression a side effect of what reads like a pure query — any later
		// reorder or double-evaluation would silently change which warnings show.
		const fresh = rest.filter((w) => !this.hasSeenNotice(file.path, this.warningKey(w)));
		for (const w of fresh) {
			this.markNoticeSeen(file.path, this.warningKey(w));
		}

		const shown = [...lapsed, ...fresh];
		if (shown.length === 0) return;
		new Notice(shown.map((w) => w.message).join("\n\n"), 10000);
	}

	private warningKey(warning: PublishWarning): string {
		return `${warning.setting}:${warning.reason}`;
	}

	private scopedNoticeKey(path: string, key: string): string {
		return `${path} ${key}`;
	}

	private hasSeenNotice(path: string, key: string): boolean {
		return this.seenPublishWarnings.has(this.scopedNoticeKey(path, key));
	}

	private markNoticeSeen(path: string, key: string): void {
		this.seenPublishWarnings.add(this.scopedNoticeKey(path, key));
	}

	/**
	 * Show a note-scoped Notice at most once per session. Used for the anonymous
	 * "settings need an account" message, which is a standing condition and would
	 * otherwise toast on every republish of that note.
	 */
	private noticeOncePerNote(file: TFile, key: string, message: string): void {
		if (this.hasSeenNotice(file.path, key)) return;
		this.markNoticeSeen(file.path, key);
		new Notice(message, 8000);
	}

	/**
	 * Move a note's dismissed-notice keys with it on rename, so a warning the user
	 * already saw doesn't resurface just because the file moved. (The same handler
	 * remaps publishedNotes.)
	 */
	private remapNoticeKeys(oldPath: string, newPath: string): void {
		const prefix = `${oldPath} `;
		for (const scoped of [...this.seenPublishWarnings]) {
			if (!scoped.startsWith(prefix)) continue;
			this.seenPublishWarnings.delete(scoped);
			this.markNoticeSeen(newPath, scoped.slice(prefix.length));
		}
	}

	/**
	 * Page settings exist only for a published, account-owned page: the settings
	 * API is API-key-authenticated, and a note still carrying an editToken is an
	 * anonymous document with no settings to manage.
	 */
	canManagePageSettings(file: TFile): boolean {
		const published = this.publishedNotes[file.path];
		return !!(this.settings.apiKey && published && !published.editToken);
	}

	openPageSettings(file: TFile): void {
		const published = this.publishedNotes[file.path];
		if (!published) return;
		new PageSettingsModal(this.app, this, file, published).open();
	}

	/**
	 * Explicit, user-initiated write of the CURRENT server-side page settings
	 * into the note's properties — for users who want settings-as-code. This and
	 * the modal's per-note exception are the ONLY paths that write settings
	 * properties; the plugin never materializes them implicitly.
	 */
	async pullPageSettings(file: TFile): Promise<void> {
		const published = this.publishedNotes[file.path];
		if (!published) return;
		try {
			const view = await getPageSettings(this.settings.apiKey, {
				documentId: published.documentId,
				slug: published.slug,
			});

			// Make the NOTE agree with the PAGE — a sync, not an append. Every
			// decision (write the page's value / drop a stale property / write an
			// explicit clearing value because a vault default would otherwise take
			// over) belongs to reconcileNoteProperty, which owns the precedence
			// chain. Do NOT re-derive it here: a hand-rolled version that forgot
			// vault defaults is exactly how this command came to silently change
			// the page it was asked to sync.
			const fm: Record<string, unknown> | undefined =
				this.app.metadataCache.getFileCache(file)?.frontmatter;

			const fields: Record<string, unknown> = {};
			const removals: string[] = [];

			const pageValues: Record<SettingProperty, unknown> = {
				[FM_THEME]: view.theme,
				[FM_HIDE_BRANDING]: view.hideBranding,
			};

			for (const key of [FM_THEME, FM_HIDE_BRANDING] as SettingProperty[]) {
				const decision = reconcileNoteProperty(key, pageValues[key], fm, this.settings);
				if (decision.action === "write") fields[key] = decision.value;
				if (decision.action === "remove") removals.push(key);
			}

			if (Object.keys(fields).length === 0 && removals.length === 0) {
				new Notice("This note's properties already match the page — nothing to save.");
				return;
			}

			await this.writePageSettingsFrontmatter(file, fields, removals);
			new Notice("Page settings saved to note properties.");
		} catch (e) {
			new Notice(`${e instanceof Error ? e.message : "Failed to pull page settings"}`, 10000);
		}
	}

	/**
	 * Direct frontmatter write for the explicit settings-property paths (pull
	 * command, modal per-note exception). Deliberately IGNORES storeFrontmatter:
	 * that toggle means "don't write receipts automatically", and these writes
	 * are the user asking by name. Do not route through writeFrontmatter(),
	 * which early-returns when the toggle is off and would silently turn those
	 * buttons into no-ops.
	 */
	async writePageSettingsFrontmatter(
		file: TFile,
		fields: Record<string, unknown>,
		removals: string[] = []
	): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			for (const key of removals) {
				delete fm[key];
			}
			for (const [key, value] of Object.entries(fields)) {
				fm[key] = value;
			}
		});
	}

	private reconcileFrontmatter(): void {
		if (!this.settings.storeFrontmatter) return;

		const mdFiles = this.app.vault.getMarkdownFiles();
		let changed = false;

		for (const file of mdFiles) {
			if (this.publishedNotes[file.path]) continue;

			const cache = this.app.metadataCache.getFileCache(file);
			const fm: Record<string, unknown> | undefined = cache?.frontmatter;
			// Support current property (jotbird_link) and legacy (jotbird_url)
			const link = fm?.["jotbird_link"] ?? fm?.["jotbird_url"];
			if (!link || typeof link !== "string") continue;

			// Extract slug from the last path segment of the URL
			let slug: string;
			try {
				slug = new URL(link).pathname.split("/").pop() ?? "";
			} catch {
				// Malformed URL in frontmatter — skip this file
				continue;
			}
			if (!slug) continue;

			const publishedAt = fm?.["jotbird_published"];
			this.publishedNotes[file.path] = {
				slug,
				url: link,
				publishedAt: typeof publishedAt === "string" ? publishedAt : "",
			};
			changed = true;
		}

		if (changed) {
			void this.saveSettings();
		}
	}

	private async publishActiveNote(): Promise<void> {
		const file = this.getActiveMarkdownFile();
		if (!file) {
			new Notice("No active Markdown file.");
			return;
		}
		await this.publishFile(file);
	}

	async publishFile(file: TFile): Promise<void> {
		// Guard against double-submit. For a brand-new note, `existing` stays
		// undefined until the first publish returns and populates
		// publishedNotes, so a second call that lands during the round-trip
		// would publish the same note again with a fresh random slug, creating
		// a duplicate page. Ignore re-entrant calls for the same file.
		if (this.publishing.has(file.path)) {
			new Notice("Already publishing this note…");
			return;
		}
		this.publishing.add(file.path);

		const hasApiKey = !!this.settings.apiKey;
		const existing = this.publishedNotes[file.path];

		const action = existing ? "Updating" : "Publishing";
		new Notice(`${action}...`);

		try {
			const content = await this.app.vault.read(file);
			const processed = await processMarkdown(
				content,
				this.app.vault,
				this.settings.apiKey,
				this.settings.stripTags
			);
			// Resolve the title and body per the user's title mode. "auto" preserves the
			// original behavior (inject `# title` only when the body has no heading);
			// "filename"/"h1" render a dedicated page-title header on the published page.
			const { title, renderTitle, markdown } = applyTitleMode(
				this.settings.titleMode,
				processed,
				content,
				file
			);

			// Anonymous → account transition. If we now have an API key but this note is
			// still an anonymous doc (it carries an editToken from an earlier trial/anonymous
			// publish), claim it to the account BEFORE publishing. Otherwise the account-
			// authenticated publishNote() below 403s ("Document not owned by user") — the doc
			// isn't account-owned until claimed. The deep-link "Connect account" flow runs
			// claimAnonymousDocuments(), but pasting the API key into Settings does not, so we
			// claim lazily at publish time to cover every path (and stale/raced local state).
			if (hasApiKey && existing && existing.editToken && existing.slug) {
				try {
					const claim = await claimDocument(
						this.settings.apiKey,
						existing.slug,
						existing.editToken
					);
					existing.slug = claim.slug;
					existing.url = claim.url;
					existing.editToken = undefined; // now account-owned
					this.publishedNotes[file.path] = existing;
					await this.saveSettings();
				} catch (e) {
					// Claim failed (already claimed by this account, transient, etc.).
					// Fall through to publishNote — it succeeds if the doc is already
					// account-owned, or surfaces its own error otherwise. Log so a real
					// claim failure is still diagnosable (the editToken is preserved).
					console.warn("JotBird: claim-before-publish failed; publishing anyway", e);
				}
			}

			// Page settings rider: per-note properties (incl. explicit false) >
			// vault defaults > omitted (server preserves). Read from the metadata
			// cache, NOT gated on storeFrontmatter — that toggle governs writing.
			// Values go verbatim; the server warns about anything it drops.
			const resolvedSettings = resolvePagePublishSettings(
				this.app.metadataCache.getFileCache(file)?.frontmatter,
				this.settings
			);
			// Anonymous publishes have no settings channel at all (/trial/publish
			// takes no settings, and an anonymous page has none). Say so locally —
			// the server can't warn about a field it never receives, and silently
			// ignoring a property the user typed is the exact failure the publish
			// warnings exist to prevent. Deduped per note like the server warnings
			// (same standing-condition spam otherwise: this note would toast on
			// every single republish).
			if (!hasApiKey && resolvedSettings) {
				this.noticeOncePerNote(
					file,
					"anonymous",
					"Page settings need a connected JotBird account — published without them."
				);
			}
			const pageSettings = hasApiKey ? resolvedSettings : undefined;

			let result;
			let retried = false;
			try {
				if (hasApiKey) {
					result = await publishNote(
						this.settings.apiKey,
						markdown,
						title,
						existing?.slug,
						existing?.documentId,
						renderTitle,
						pageSettings
					);
				} else {
					result = await trialPublish(
						this.deviceFingerprint,
						markdown,
						title,
						existing?.slug,
						existing?.editToken,
						renderTitle
					);
				}
			} catch (e) {
				// If update failed because page expired (404), retry as fresh publish
				if (existing && e instanceof Error && /not found/i.test(e.message)) {
					retried = true;
					if (hasApiKey) {
						result = await publishNote(
							this.settings.apiKey,
							markdown,
							title,
							undefined,
							undefined,
							renderTitle,
							pageSettings
						);
					} else {
						result = await trialPublish(
							this.deviceFingerprint,
							markdown,
							title,
							undefined,
							undefined,
							renderTitle
						);
					}
				} else {
					throw e;
				}
			}

			this.publishedNotes[file.path] = {
				documentId: result.documentId ?? existing?.documentId,
				slug: result.slug,
				url: result.url,
				editToken: result.editToken,
				publishedAt: new Date().toISOString(),
			};

			await this.saveSettings();
			await this.writeFrontmatter(
				file,
				result.url,
				result.expiresAt ?? "",
				result.ttlDays
			);

			// Detect Pro upgrade and refresh all other notes' frontmatter
			if (!result.ttlDays && !this.proRefreshDone) {
				this.proRefreshDone = true;
				await this.refreshProExpiration(file.path);
			}

			const verb = (existing && !retried) ? "Updated" : "Published";
			if (this.settings.autoCopyLink) {
				await navigator.clipboard.writeText(result.url);
			}
			if (!hasApiKey) {
				const copyMsg = this.settings.autoCopyLink ? " Link copied." : "";
				new Notice(
					`${verb}!${copyMsg}\nExpires in 30 days — connect a JotBird account for longer links.`,
					8000
				);
			} else if (this.settings.autoCopyLink) {
				new Notice(`${verb}! Link copied.`, 5000);
			} else {
				new Notice(`${verb}!`, 5000);
			}
			// Settings the server could not honor (Pro-gated, invalid value, or a
			// lapsed subscription dropping a preserved setting). The publish itself
			// succeeded; the server is the authority on what applied — never rely
			// on a local isPro pre-check, which can be stale.
			this.noticePublishWarnings(file, result.warnings);
			this.addPropertyIcons();
		} catch (e) {
			new Notice(`${e instanceof Error ? e.message : "Unknown error"}`, 10000);
		} finally {
			this.publishing.delete(file.path);
		}
	}

	private unpublishNote(file: TFile): void {
		const published = this.publishedNotes[file.path];
		if (!published) {
			new Notice("This note is not published.");
			return;
		}

		new ConfirmModal(
			this.app,
			`Unpublish "${file.basename}" from JotBird? This will permanently remove it from ${published.url}.`,
			() => {
				void (async () => {
					try {
						if (this.settings.apiKey) {
							await deleteDocument(this.settings.apiKey, published.slug, published.documentId);
						} else {
							await trialDeleteDocument(
								published.slug,
								published.editToken ?? "",
								this.deviceFingerprint
							);
						}
						delete this.publishedNotes[file.path];
						await this.saveSettings();
						await this.clearFrontmatter(file);
						new Notice("Note unpublished.");
					} catch (e) {
						new Notice(
							`${e instanceof Error ? e.message : "Unknown error"}`,
							10000
						);
					}
				})();
			}
		).open();
	}

	private async showDocumentList(): Promise<void> {
		if (!this.requireApiKey()) return;

		try {
			new Notice("Loading documents...");
			const result = await listDocuments(this.settings.apiKey);
			new DocumentListModal(this.app, result.documents).open();
		} catch (e) {
			new Notice(
				`${e instanceof Error ? e.message : "Unknown error"}`,
				10000
			);
		}
	}

	private async claimAnonymousDocuments(): Promise<void> {
		if (!this.settings.apiKey) return;

		// Find all published notes that still have an editToken (anonymous docs)
		const toClaim = Object.entries(this.publishedNotes).filter(
			([, note]) => !!note.editToken
		);
		if (toClaim.length === 0) return;

		let claimed = 0;
		for (const [filePath, note] of toClaim) {
			try {
				const result = await claimDocument(
					this.settings.apiKey,
					note.slug,
					note.editToken!
				);

				// Update the local record: remove editToken, update URL
				this.publishedNotes[filePath] = {
					slug: result.slug,
					url: result.url,
					publishedAt: note.publishedAt,
					// editToken intentionally omitted — doc is now account-owned
				};

				// Update frontmatter with new expiration
				const file = this.app.vault.getAbstractFileByPath(filePath);
				if (file instanceof TFile) {
					await this.writeFrontmatter(
						file,
						result.url,
						result.expiresAt ?? "",
						result.ttlDays
					);
				}

				claimed++;
			} catch {
				// Skip documents that fail to claim (expired, already claimed, etc.)
			}
		}

		if (claimed > 0) {
			await this.saveSettings();
			new Notice(
				`${claimed} existing document${claimed === 1 ? "" : "s"} linked to your account.`
			);
		}
	}

	private async refreshProExpiration(excludePath: string): Promise<void> {
		if (!this.settings.storeFrontmatter) return;

		let updated = 0;
		for (const [filePath, note] of Object.entries(this.publishedNotes)) {
			if (filePath === excludePath) continue;
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (!(file instanceof TFile)) continue;
			try {
				await this.writeFrontmatter(file, note.url, "", 0);
				updated++;
			} catch { /* skip files that fail */ }
		}

		if (updated > 0) {
			new Notice(
				`Updated ${updated} note${updated === 1 ? "" : "s"} to Pro (no expiration).`
			);
		}
	}

	/**
	 * Refresh `isPro` from the server.
	 *
	 * Returns whether the server actually ANSWERED — i.e. whether the API key is
	 * usable. Callers that only want the Pro flag can ignore it, but the settings
	 * tab needs it: it must distinguish "this key works" (re-render into the
	 * connected state) from "this is a half-typed key that 401s" (leave the pane
	 * alone so the user can keep typing). A `false` here is NOT "not Pro" — it is
	 * "we don't know", which is why it must never be treated as a Pro answer.
	 */
	async checkProStatus(): Promise<boolean> {
		if (!this.settings.apiKey) return false;
		// Serialize concurrent calls — wait for any in-flight check to finish,
		// then make a fresh call so the caller always gets up-to-date data.
		while (this.proCheckInFlight) {
			try { await this.proCheckInFlight; } catch { /* ignore */ }
		}
		let answered = false;
		this.proCheckInFlight = (async () => {
			try {
				const result = await listDocuments(this.settings.apiKey);
				answered = true;
				this.lastProCheckAt = Date.now();
				const wasPro = this.isPro;
				this.isPro = !!result.isPro;
				if (this.isPro && !wasPro) {
					this.settingTab?.display();
				}
			} catch { /* ignore — non-critical; `answered` stays false */ }
		})();
		try {
			await this.proCheckInFlight;
		} finally {
			this.proCheckInFlight = null;
		}
		return answered;
	}

	/**
	 * Refresh `isPro` unless it was checked recently.
	 *
	 * Every Pro gate in the UI needs a truthful answer: a cache left stale by a
	 * failed startup check (an offline launch) would lock a paying subscriber out
	 * of controls the server would happily accept. But the surfaces that need it
	 * — the settings tab on every render, the page-settings modal on every open —
	 * would otherwise fire a round trip each time, mostly for accounts that are
	 * not Pro. One short TTL serves both.
	 */
	async refreshProStatusIfStale(): Promise<void> {
		if (!this.settings.apiKey) return;
		if (Date.now() - this.lastProCheckAt < PRO_CHECK_TTL_MS) return;
		await this.checkProStatus();
	}

	/**
	 * Drop the cached Pro answer. MUST be called whenever the API key changes —
	 * the TTL above is keyed on time, not on identity, so without this a fresh
	 * timestamp from the PREVIOUS account suppresses the check for the new one,
	 * and a subscriber who just pasted their key sits behind "Requires Pro."
	 * gates until the window expires.
	 */
	invalidateProStatus(): void {
		this.lastProCheckAt = 0;
		this.isPro = false;
	}

	private async handleProUpgrade(): Promise<void> {
		await this.checkProStatus();
		if (this.isPro) {
			this.proRefreshDone = true;
			await this.refreshProExpiration("");
			new Notice("Upgrade complete! All your links are now permanent.");
			this.settingTab?.display();
		} else {
			new Notice("Upgrade not detected yet. Try publishing a note — it will update automatically.");
		}
	}

	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) as Partial<PluginData> | null) ?? {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
		this.publishedNotes = data.publishedNotes ?? {};
		this.deviceFingerprint = data.deviceFingerprint || crypto.randomUUID();
		this.proRefreshDone = !!data.proRefreshDone;
	}

	async saveSettings(): Promise<void> {
		const data: PluginData = {
			settings: this.settings,
			publishedNotes: this.publishedNotes,
			deviceFingerprint: this.deviceFingerprint,
			proRefreshDone: this.proRefreshDone,
		};
		await this.saveData(data);
	}
}
