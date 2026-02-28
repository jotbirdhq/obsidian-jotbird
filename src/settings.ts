import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type JotBirdPlugin from "./main";
import { getPortalUrl } from "./api";

const SITE_URL = "https://jotbird.com";

export class JotBirdSettingTab extends PluginSettingTab {
	plugin: JotBirdPlugin;

	constructor(app: App, plugin: JotBirdPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("JotBird").setHeading();

		const connectUrl = `${SITE_URL}/account/api-key?obsidian=1`;

		if (this.plugin.settings.apiKey) {
			const accountDesc = this.plugin.isPro
				? "Connected (Pro)."
				: "Connected. Your published links get extended expiration.";
			new Setting(containerEl)
				.setName("JotBird account")
				.setDesc(accountDesc)
				.addButton((btn) =>
					btn
						.setButtonText("Disconnect")
						.setWarning()
						.onClick(async () => {
							this.plugin.settings.apiKey = "";
							this.plugin.isPro = false;
							this.plugin.proRefreshDone = false;
							await this.plugin.saveSettings();
							this.display();
						})
				);

			if (this.plugin.isPro) {
				new Setting(containerEl)
					.setName("JotBird Pro")
					.setDesc(
						"You're a Pro subscriber! All your published links are permanent and will never expire."
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
					.setName("Upgrade to Pro")
					.setDesc(
						"Get permanent links that never expire, plus priority support."
					)
					.addButton((btn) =>
						btn
							.setButtonText("Upgrade to Pro")
							.setCta()
							.onClick(() => {
								window.open(upgradeUrl);
							})
					);
			}
		} else {
			new Setting(containerEl)
				.setName("JotBird account")
				.setDesc(
					"Connect your JotBird account for 90-day links (free) or permanent links (Pro)."
				)
				.addButton((btn) =>
					btn
						.setButtonText("Connect to JotBird")
						.setCta()
						.onClick(() => {
							window.open(connectUrl);
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
						.setPlaceholder("jb_...")
						.setValue(this.plugin.settings.apiKey)
						.onChange(async (value) => {
							this.plugin.settings.apiKey = value.trim();
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
				"After publishing, save the JotBird URL and expiration in your note's frontmatter properties. Disable if you prefer not to modify your notes."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.storeFrontmatter)
					.onChange(async (value) => {
						this.plugin.settings.storeFrontmatter = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
