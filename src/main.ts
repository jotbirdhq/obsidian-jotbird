import { addIcon, Notice, Plugin, TFile, TAbstractFile, MarkdownView, setIcon } from "obsidian";
import {
	JotBirdSettings,
	DEFAULT_SETTINGS,
	PublishedNote,
	PluginData,
} from "./types";
import {
	publishNote,
	trialPublish,
	listDocuments,
	deleteDocument,
	trialDeleteDocument,
	claimDocument,
} from "./api";
import { processMarkdown, extractTitle } from "./markdown";
import { JotBirdSettingTab } from "./settings";
import { ConfirmModal, DocumentListModal } from "./modals";

export default class JotBirdPlugin extends Plugin {
	settings: JotBirdSettings = DEFAULT_SETTINGS;
	publishedNotes: Record<string, PublishedNote> = {};
	deviceFingerprint: string = "";
	isPro = false;
	private settingTab: JotBirdSettingTab | null = null;
	proRefreshDone = false;
	private proCheckInFlight: Promise<void> | null = null;

	async onload(): Promise<void> {
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

		// Register custom icon (scaled to fit 0 0 100 100 viewBox)
		addIcon(
			"jotbird",
			'<g transform="translate(2,14) scale(0.1197)" fill="currentColor"><path d="m749.18 258.35c-17.18-46.97-31.77-92.07-87.4-104.45-52.34-9.51-98.9 3.62-158.2 78.02-23.9-98.52-120.15-173.3-206.36-218.41 0 0 39.67 122.68 33.16 241.48 101.25 37.59 203.44 39.32 255.73 35.87-13.25 21.65-27.89 43.56-46.28 65.41-123.12-31.45-290.9-107.02-353.28-288.37 0 0-58.06 158.56 69.86 364.6-48.81 39.83-126.77 56.24-248.36 27.89 45.81 40.48 141.02 65.94 205.14 68.41-36.03 1.8-77.33 44.13-90.24 63.68 100.36-29.78 167.59-26.26 242.21-45.38q3.18-0.81 6.38-1.68c106.87-29.09 157.17-105.05 218.16-164.14 61.02-59.07 143.16-76.02 204.25-53.73 0 0-36.12-45.54-44.77-69.2z"/></g>'
		);

		// Ribbon icon
		this.addRibbonIcon("jotbird", "Publish to JotBird", () => {
			this.publishActiveNote();
		});

		// Command: Publish / Update current note
		this.addCommand({
			id: "publish-current-note",
			name: "Publish current note",
			checkCallback: (checking) => {
				const file = this.getActiveMarkdownFile();
				if (!file) return false;
				if (!checking) this.publishActiveNote();
				return true;
			},
		});

		// Command: Copy JotBird link
		this.addCommand({
			id: "copy-jotbird-link",
			name: "Copy JotBird link",
			checkCallback: (checking) => {
				const file = this.getActiveMarkdownFile();
				if (!file) return false;
				const published = this.publishedNotes[file.path];
				if (!published) return false;
				if (!checking) {
					navigator.clipboard.writeText(published.url);
					new Notice("JotBird link copied to clipboard");
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

		// Command: List published documents
		this.addCommand({
			id: "list-published-documents",
			name: "List published documents",
			callback: () => {
				this.showDocumentList();
			},
		});

		// File menu (right-click in file explorer)
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;

				const published = this.publishedNotes[file.path];

				if (published) {
					menu.addItem((item) => {
						item.setTitle("Update on JotBird")
							.setIcon("jotbird")
							.onClick(() => this.publishFile(file));
					});
					menu.addItem((item) => {
						item.setTitle("Copy JotBird link")
							.setIcon("link")
							.onClick(() => {
								navigator.clipboard.writeText(published.url);
								new Notice("JotBird link copied to clipboard");
							});
					});
					menu.addItem((item) => {
						item.setTitle("Unpublish from JotBird")
							.setIcon("trash")
							.onClick(() => this.unpublishNote(file));
					});
				} else {
					menu.addItem((item) => {
						item.setTitle("Publish to JotBird")
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
					this.saveSettings();
				}
			})
		);

		// Track file deletions to clean up mapping
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (!(file instanceof TFile)) return;
				if (this.publishedNotes[file.path]) {
					delete this.publishedNotes[file.path];
					this.saveSettings();
				}
			})
		);

		// Settings tab
		this.settingTab = new JotBirdSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		// Check Pro status in the background on startup
		this.checkProStatus();

		// Register obsidian:// protocol handler for API key and Pro upgrade flows
		this.registerObsidianProtocolHandler("jotbird", async (params) => {
			const p = params as Record<string, string>;

			if (p.token && p.token.startsWith("jb_")) {
				this.settings.apiKey = p.token;
				await this.saveSettings();
				new Notice("JotBird: Account connected successfully!");
				this.settingTab?.display();
				// Check Pro status and claim anonymous documents in the background
				this.checkProStatus();
				this.claimAnonymousDocuments();
			} else if (p.upgraded === "1") {
				await this.handleProUpgrade();
			} else {
				new Notice("JotBird: Invalid token received. Please try again.");
			}
		});
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
		let count = 0;
		const timer = setInterval(() => {
			if (++count > 8) {
				clearInterval(timer);
				return;
			}
			const file = this.app.workspace.getActiveFile?.();
			if (!(file instanceof TFile)) return;
			const published = this.publishedNotes[file.path];
			if (!published) return;

			document
				.querySelectorAll(
					'div.metadata-property[data-property-key="jotbird_link"]'
				)
				.forEach((propertyEl) => {
					const valueEl = propertyEl.querySelector(
						"div.metadata-property-value"
					);
					if (!valueEl || valueEl.querySelector("div.jotbird-icons"))
						return;

					const iconsEl = document.createElement("div");
					iconsEl.classList.add("jotbird-icons");

					const updateIcon = iconsEl.createEl("span");
					updateIcon.title = "Update on JotBird";
					setIcon(updateIcon, "upload-cloud");
					updateIcon.onclick = () => this.publishFile(file);

					const copyIcon = iconsEl.createEl("span");
					copyIcon.title = "Copy link";
					setIcon(copyIcon, "copy");
					copyIcon.onclick = async () => {
						await navigator.clipboard.writeText(published.url);
						new Notice("JotBird link copied to clipboard");
					};

					const deleteIcon = iconsEl.createEl("span");
					deleteIcon.title = "Unpublish";
					setIcon(deleteIcon, "trash-2");
					deleteIcon.onclick = () => this.unpublishNote(file);

					valueEl.prepend(iconsEl);
				});
			clearInterval(timer);
		}, 50);
	}

	private requireApiKey(): boolean {
		if (!this.settings.apiKey) {
			new Notice("JotBird: Please set your API key in Settings → JotBird.");
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
			await this.app.fileManager.processFrontMatter(file, (fm) => {
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
			await this.app.fileManager.processFrontMatter(file, (fm) => {
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

	private reconcileFrontmatter(): void {
		if (!this.settings.storeFrontmatter) return;

		const mdFiles = this.app.vault.getMarkdownFiles();
		let changed = false;

		for (const file of mdFiles) {
			if (this.publishedNotes[file.path]) continue;

			const cache = this.app.metadataCache.getFileCache(file);
			const fm = cache?.frontmatter;
			// Support current property (jotbird_link) and legacy (jotbird_url)
			const link = fm?.["jotbird_link"] ?? fm?.["jotbird_url"];
			if (!link) continue;

			// Extract slug from the last path segment of the URL
			let slug: string;
			try {
				slug = new URL(link).pathname.split("/").pop() ?? "";
			} catch {
				// Malformed URL in frontmatter — skip this file
				continue;
			}
			if (!slug) continue;

			this.publishedNotes[file.path] = {
				slug,
				url: link,
				publishedAt: fm?.["jotbird_published"] ?? "",
			};
			changed = true;
		}

		if (changed) {
			this.saveSettings();
		}
	}

	private async publishActiveNote(): Promise<void> {
		const file = this.getActiveMarkdownFile();
		if (!file) {
			new Notice("JotBird: No active markdown file.");
			return;
		}
		await this.publishFile(file);
	}

	async publishFile(file: TFile): Promise<void> {
		const hasApiKey = !!this.settings.apiKey;
		const existing = this.publishedNotes[file.path];

		const action = existing ? "Updating" : "Publishing";
		new Notice(`JotBird: ${action}...`);

		try {
			const content = await this.app.vault.read(file);
			const title = extractTitle(content, file);
			let markdown = await processMarkdown(
				content,
				this.app.vault,
				file,
				this.settings.apiKey,
				this.settings.stripTags
			);
			// Prepend title as H1 if the content doesn't already start with one
			if (!/^# /.test(markdown)) {
				markdown = `# ${title}\n\n${markdown}`;
			}

			let result;
			let retried = false;
			try {
				if (hasApiKey) {
					result = await publishNote(
						this.settings.apiKey,
						markdown,
						title,
						existing?.slug
					);
				} else {
					result = await trialPublish(
						this.deviceFingerprint,
						markdown,
						title,
						existing?.slug,
						existing?.editToken
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
							title
						);
					} else {
						result = await trialPublish(
							this.deviceFingerprint,
							markdown,
							title
						);
					}
				} else {
					throw e;
				}
			}

			this.publishedNotes[file.path] = {
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
					`JotBird: ${verb}!${copyMsg}\nExpires in 30 days — connect a JotBird account for longer links.`,
					8000
				);
			} else if (this.settings.autoCopyLink) {
				new Notice(`JotBird: ${verb}! Link copied.`, 5000);
			} else {
				new Notice(`JotBird: ${verb}!`, 5000);
			}
			this.addPropertyIcons();
		} catch (e) {
			new Notice(`JotBird: ${e instanceof Error ? e.message : "Unknown error"}`, 10000);
		}
	}

	private async unpublishNote(file: TFile): Promise<void> {
		const published = this.publishedNotes[file.path];
		if (!published) {
			new Notice("JotBird: This note is not published.");
			return;
		}

		new ConfirmModal(
			this.app,
			`Unpublish "${file.basename}" from JotBird? This will permanently remove it from ${published.url}.`,
			async () => {
				try {
					if (this.settings.apiKey) {
						await deleteDocument(this.settings.apiKey, published.slug);
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
					new Notice("JotBird: Note unpublished.");
				} catch (e) {
					new Notice(
						`JotBird: ${e instanceof Error ? e.message : "Unknown error"}`,
						10000
					);
				}
			}
		).open();
	}

	private async showDocumentList(): Promise<void> {
		if (!this.requireApiKey()) return;

		try {
			new Notice("JotBird: Loading documents...");
			const result = await listDocuments(this.settings.apiKey);
			new DocumentListModal(this.app, result.documents).open();
		} catch (e) {
			new Notice(
				`JotBird: ${e instanceof Error ? e.message : "Unknown error"}`,
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
				`JotBird: ${claimed} existing document${claimed === 1 ? "" : "s"} linked to your account.`
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
				`JotBird: Updated ${updated} note${updated === 1 ? "" : "s"} to Pro (no expiration).`
			);
		}
	}

	async checkProStatus(): Promise<void> {
		if (!this.settings.apiKey) return;
		// Serialize concurrent calls — wait for any in-flight check to finish,
		// then make a fresh call so the caller always gets up-to-date data.
		while (this.proCheckInFlight) {
			try { await this.proCheckInFlight; } catch { /* ignore */ }
		}
		this.proCheckInFlight = (async () => {
			try {
				const result = await listDocuments(this.settings.apiKey);
				const wasPro = this.isPro;
				this.isPro = !!result.isPro;
				if (this.isPro && !wasPro) {
					this.settingTab?.display();
				}
			} catch { /* ignore — non-critical */ }
		})();
		try {
			await this.proCheckInFlight;
		} finally {
			this.proCheckInFlight = null;
		}
	}

	private async handleProUpgrade(): Promise<void> {
		await this.checkProStatus();
		if (this.isPro) {
			this.proRefreshDone = true;
			await this.refreshProExpiration("");
			new Notice("JotBird: Welcome to Pro! All your links are now permanent.");
			this.settingTab?.display();
		} else {
			new Notice("JotBird: Upgrade not detected yet. Try publishing a note — it will update automatically.");
		}
	}

	async loadSettings(): Promise<void> {
		const data: Partial<PluginData> = (await this.loadData()) ?? {};
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
