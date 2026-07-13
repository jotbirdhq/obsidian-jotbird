import { App, Modal, Notice, Setting, TFile } from "obsidian";
import {
	DocumentListItem,
	PageSettingsPatch,
	PageSettingsView,
	PageVisibility,
	PublishedNote,
	SITE_URL,
	THEME_OPTIONS,
	VISIBILITY_OPTIONS,
} from "./types";
import { getPageSettings, updatePageSettings } from "./api";
import {
	nextPublishValue,
	FM_HIDE_BRANDING,
	FM_THEME,
	type SettingProperty,
} from "./pageSettings";
import type JotBirdPlugin from "./main";

export class ConfirmModal extends Modal {
	private message: string;
	private onConfirm: () => void;

	constructor(app: App, message: string, onConfirm: () => void) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("p", { text: this.message });

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => {
					this.close();
				})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Confirm")
					.setCta()
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Page settings for one published note: theme, branding, visibility — and
 * nothing else (tags stay web-app-only; expiry is owned by the publish flow).
 *
 * The server is the source of truth: state is loaded with GET /cli/settings and
 * written with PATCH on explicit save only (the PATCH spends from a rate-limited
 * bucket, so it must never ride the publish path). Theme and branding apply to
 * the live page immediately, without a republish. The password is prompted,
 * sent once, and never stored anywhere in the vault.
 */
export class PageSettingsModal extends Modal {
	private plugin: JotBirdPlugin;
	private file: TFile;
	private published: PublishedNote;
	private view: PageSettingsView | null = null;
	/** Resolved by the GET in load(); used to address the PATCH. */
	private namespaced = false;
	private pending: {
		theme: string;
		hideBranding: boolean;
		visibility: PageVisibility;
		password: string;
	} = { theme: "default", hideBranding: false, visibility: "unlisted", password: "" };
	private saving = false;

	constructor(app: App, plugin: JotBirdPlugin, file: TFile, published: PublishedNote) {
		super(app);
		this.plugin = plugin;
		this.file = file;
		this.published = published;
	}

	onOpen(): void {
		this.contentEl.addClass("jotbird-page-settings-modal");
		this.contentEl.createEl("h2", { text: "Page settings" });
		this.contentEl.createEl("p", {
			text: "Loading page settings…",
			cls: "jotbird-page-settings-loading",
		});
		void this.load();
	}

	private async load(): Promise<void> {
		try {
			// Refresh Pro status before gating anything on it. `plugin.isPro` is a
			// cache that is only populated at startup — if that call failed (an
			// offline launch, a transient 5xx), it stays false for the whole
			// session, and a real Pro subscriber would find every control here
			// disabled with "Requires Pro." We are already making an authenticated
			// round trip, so pay for a truthful answer rather than a stale one.
			const [settings] = await Promise.all([
				getPageSettings(this.plugin.settings.apiKey, {
					documentId: this.published.documentId,
					slug: this.published.slug,
				}),
				this.plugin.refreshProStatusIfStale(),
			]);
			this.view = settings;
			// The (unmetered) GET just told us whether this page is namespaced.
			// Remember it, so the (metered) PATCH addresses the document correctly
			// on the first try instead of probing — see updatePageSettings.
			this.namespaced = settings.username !== null;
			this.pending = {
				theme: this.view.theme,
				hideBranding: this.view.hideBranding,
				visibility: this.view.visibility,
				password: "",
			};
			this.render();
		} catch (e) {
			this.close();
			new Notice(`${e instanceof Error ? e.message : "Failed to load page settings"}`, 10000);
		}
	}

	private render(): void {
		const view = this.view;
		if (!view) return;
		const { contentEl } = this;
		contentEl.empty();

		const isPro = this.plugin.isPro;

		contentEl.createEl("h2", { text: "Page settings" });
		const urlLine = contentEl.createEl("p", { cls: "jotbird-page-settings-url" });
		urlLine.createEl("span", { text: this.file.basename, cls: "jotbird-page-settings-title" });
		const link = urlLine.createEl("a", { text: view.url, href: view.url });
		link.setAttr("target", "_blank");
		// Obsidian is a Chromium view, so a _blank link hands the destination a live
		// window.opener (reverse tabnabbing). The href is our own page, but that page
		// renders user-published content — close the class rather than reason about it.
		link.setAttr("rel", "noopener noreferrer");

		new Setting(contentEl)
			.setName("Theme")
			.setDesc(
				!isPro && view.theme === "default"
					? "Requires Pro."
					: "Applies to the live page immediately — no republish needed."
			)
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(THEME_OPTIONS)) {
					dropdown.addOption(value, label);
				}
				dropdown.setValue(this.pending.theme);
				dropdown.onChange((value) => {
					this.pending.theme = value;
				});
				// Free account, nothing to clear → a conversion surface, not a
				// silent no-op. A lapsed-Pro account (non-default current value)
				// keeps the control so it can still clear back to Default; the
				// server 403s any other change, naming the setting.
				if (!isPro && view.theme === "default") {
					dropdown.setDisabled(true);
				}
			});

		new Setting(contentEl)
			.setName("Hide branding")
			.setDesc(
				!isPro && !view.hideBranding
					? "Requires Pro."
					: 'Hide "Published with JotBird" on the page.'
			)
			.addToggle((toggle) => {
				toggle.setValue(this.pending.hideBranding);
				toggle.onChange((value) => {
					this.pending.hideBranding = value;
				});
				if (!isPro && !view.hideBranding) {
					toggle.setDisabled(true);
				}
			});

		new Setting(contentEl)
			.setName("Visibility")
			.setDesc("Unlisted pages are reachable only by link. Public pages allow search indexing.")
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(VISIBILITY_OPTIONS)) {
					dropdown.addOption(value, label);
				}
				dropdown.setValue(this.pending.visibility);
				dropdown.onChange((value) => {
					if (value === "password" && !isPro && view.visibility !== "password") {
						dropdown.setValue(this.pending.visibility);
						new Notice("Password protection requires Pro.");
						return;
					}
					this.pending.visibility = value as PageVisibility;
					this.render();
				});
			});

		if (this.pending.visibility === "password") {
			new Setting(contentEl)
				.setName("Password")
				.setDesc(
					view.visibility === "password"
						? "Leave blank to keep the current password. Sent once when you save — never stored in your vault."
						: "4–64 characters. Sent once when you save — never stored in your vault."
				)
				.addText((text) => {
					text.setValue(this.pending.password);
					text.onChange((value) => {
						this.pending.password = value;
					});
					text.inputEl.type = "password";
				});
		}

		if (!isPro) {
			new Setting(contentEl)
				.setName("Pro")
				.setDesc("Themes, hidden branding, and password protection require Pro.")
				.addButton((btn) =>
					btn
						.setButtonText("Upgrade")
						.setCta()
						.onClick(() => {
							window.open(`${SITE_URL}/pro?obsidian=1`);
						})
				);
		}

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => {
					this.close();
				})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Save")
					.setCta()
					.onClick(() => {
						void this.save(btn);
					})
			);
	}

	private buildPatch(): PageSettingsPatch | { error: string } {
		const view = this.view!;
		const patch: PageSettingsPatch = {};
		if (this.pending.theme !== view.theme) {
			patch.theme = this.pending.theme;
		}
		if (this.pending.hideBranding !== view.hideBranding) {
			patch.hideBranding = this.pending.hideBranding;
		}
		const visibilityChanged = this.pending.visibility !== view.visibility;
		// Send the password EXACTLY as typed — trimming it would store a different
		// secret than the user entered (a paste with a trailing space is the common
		// case) and lock them out of their own page, since the unlock form doesn't
		// trim either. `hasPassword` only tests whether the field was filled in.
		const newPassword = this.pending.password;
		const hasPassword = newPassword.length > 0;
		if (visibilityChanged || (this.pending.visibility === "password" && hasPassword)) {
			if (this.pending.visibility === "password") {
				if (!hasPassword && visibilityChanged) {
					return { error: "Enter a password to protect this page." };
				}
				if (hasPassword) {
					patch.visibility = "password";
					patch.password = newPassword;
				}
			} else {
				patch.visibility = this.pending.visibility;
			}
		}
		return patch;
	}

	private async save(btn: { setDisabled(d: boolean): unknown; setButtonText(t: string): unknown }): Promise<void> {
		if (this.saving || !this.view) return;
		const built = this.buildPatch();
		if ("error" in built) {
			new Notice(built.error);
			return;
		}
		const patch = built;
		if (Object.keys(patch).length === 0) {
			new Notice("No changes to save.");
			this.close();
			return;
		}

		this.saving = true;
		btn.setDisabled(true);
		btn.setButtonText("Saving…");
		try {
			await updatePageSettings(
				this.plugin.settings.apiKey,
				{
					documentId: this.published.documentId,
					slug: this.published.slug,
					namespaced: this.namespaced,
				},
				patch
			);
			this.close();
			new Notice("Page settings updated.");
			this.offerPerNoteException(patch);
		} catch (e) {
			new Notice(`${e instanceof Error ? e.message : "Failed to save page settings"}`, 10000);
			this.saving = false;
			btn.setDisabled(false);
			btn.setButtonText("Save");
		}
	}

	/**
	 * The modal PATCHes SERVER state, but the next publish of this note re-sends
	 * whatever the note's frontmatter or the vault-wide default says — silently
	 * reverting this change (the two-writer trap). When that would happen, warn
	 * and offer to write the saved value into the note's frontmatter, where it
	 * wins on every future publish. This is an explicit, user-confirmed write —
	 * not a violation of the never-auto-write rule — and it deliberately ignores
	 * the storeFrontmatter toggle (see writePageSettingsFrontmatter).
	 */
	private offerPerNoteException(patch: PageSettingsPatch): void {
		const fm: Record<string, unknown> | undefined =
			this.plugin.app.metadataCache.getFileCache(this.file)?.frontmatter;
		const fields: Record<string, unknown> = {};

		// "What will the next publish send?" is nextPublishValue's job — the same
		// helper the publish path and the pull command use. An undefined answer
		// means nothing is sent, so the server preserves what we just saved and
		// there is nothing to warn about.
		const saved: [SettingProperty, unknown][] = [
			[FM_THEME, patch.theme],
			[FM_HIDE_BRANDING, patch.hideBranding],
		];
		for (const [key, savedValue] of saved) {
			if (savedValue === undefined) continue;
			const willSend = nextPublishValue(key, fm, this.plugin.settings);
			if (willSend !== undefined && willSend !== savedValue) {
				fields[key] = savedValue;
			}
		}

		if (Object.keys(fields).length === 0) return;

		new ConfirmModal(
			this.app,
			"A note property or vault-wide default will revert this change the next time you publish this note. Save the new value to this note's properties so it wins?",
			() => {
				void (async () => {
					await this.plugin.writePageSettingsFrontmatter(this.file, fields);
					new Notice("Saved to note properties.");
				})();
			}
		).open();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class DocumentListModal extends Modal {
	private documents: DocumentListItem[];

	constructor(app: App, documents: DocumentListItem[]) {
		super(app);
		this.documents = documents;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("jotbird-doc-list-modal");
		contentEl.createEl("h2", { text: "Published documents" });

		if (this.documents.length === 0) {
			contentEl.createEl("p", {
				text: "No published documents found.",
				cls: "jotbird-doc-list-empty",
			});
			return;
		}

		const list = contentEl.createEl("div", { cls: "jotbird-doc-list" });

		for (const doc of this.documents) {
			const item = list.createEl("div", { cls: "jotbird-doc-item" });

			const titleRow = item.createEl("div", { cls: "jotbird-doc-title-row" });
			titleRow.createEl("span", {
				text: doc.title || doc.slug,
				cls: "jotbird-doc-title",
			});

			const updated = new Date(doc.updatedAt);
			titleRow.createEl("span", {
				text: updated.toLocaleDateString(),
				cls: "jotbird-doc-date",
			});

			const link = item.createEl("a", {
				text: doc.url,
				href: doc.url,
				cls: "jotbird-doc-url",
			});
			link.setAttr("target", "_blank");
			// See PageSettingsModal: _blank without rel=noopener leaks window.opener.
			link.setAttr("rel", "noopener noreferrer");
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
