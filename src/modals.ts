import { App, Modal, Setting } from "obsidian";
import { DocumentListItem } from "./types";

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
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
