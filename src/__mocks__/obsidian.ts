import { vi } from "vitest";

// --- addIcon / setIcon mock ---
export const addIcon = vi.fn();
export const setIcon = vi.fn();

// --- requestUrl mock ---
export const requestUrl = vi.fn();

// --- Notice mock ---
export class Notice {
	message: string;
	constructor(message: string, _timeout?: number) {
		this.message = message;
	}
}

// --- TAbstractFile / TFile / TFolder ---
export class TAbstractFile {
	path: string = "";
	name: string = "";
	vault: unknown = null;
}

export class TFile extends TAbstractFile {
	basename: string = "";
	extension: string = "md";
	stat = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot(): boolean {
		return this.path === "/";
	}
}

// --- Vault mock ---
export class Vault {
	read = vi.fn();
	readBinary = vi.fn();
	getFiles = vi.fn().mockReturnValue([]);
	getMarkdownFiles = vi.fn().mockReturnValue([]);
	getAbstractFileByPath = vi.fn().mockReturnValue(null);
	on = vi.fn();
}

// --- MarkdownView mock ---
export class MarkdownView {
	file: TFile | null = null;
	getViewType() {
		return "markdown";
	}
}

// --- Workspace mock ---
export class Workspace {
	getActiveViewOfType = vi.fn().mockReturnValue(null);
	getActiveFile = vi.fn().mockReturnValue(null);
	on = vi.fn();
	onLayoutReady = vi.fn().mockImplementation((cb: () => void) => cb());
}

// --- FileManager mock ---
export class FileManager {
	processFrontMatter = vi.fn().mockImplementation(
		async (_file: unknown, fn: (fm: Record<string, unknown>) => void) => {
			fn({});
		}
	);
}

// --- MetadataCache mock ---
export class MetadataCache {
	getFileCache = vi.fn().mockReturnValue(null);
}

// --- Setting mock ---
export class Setting {
	settingEl = createMockEl();
	controlEl = createMockEl();
	constructor(_containerEl: unknown) {}
	setName(_name: string) {
		return this;
	}
	setDesc(_desc: string) {
		return this;
	}
	addText(cb: (text: TextComponent) => void) {
		cb(new TextComponent());
		return this;
	}
	addToggle(cb: (toggle: ToggleComponent) => void) {
		cb(new ToggleComponent());
		return this;
	}
	addButton(cb: (btn: ButtonComponent) => void) {
		cb(new ButtonComponent());
		return this;
	}
	then(cb: (setting: Setting) => void) {
		cb(this);
		return this;
	}
}

class TextComponent {
	setPlaceholder(_p: string) {
		return this;
	}
	setValue(_v: string) {
		return this;
	}
	onChange(_cb: (value: string) => void) {
		return this;
	}
}

class ToggleComponent {
	setValue(_v: boolean) {
		return this;
	}
	onChange(_cb: (value: boolean) => void) {
		return this;
	}
}

class ButtonComponent {
	setButtonText(_t: string) {
		return this;
	}
	setCta() {
		return this;
	}
	setWarning() {
		return this;
	}
	onClick(_cb: () => void) {
		return this;
	}
}

// --- Modal mock ---
export class Modal {
	app: unknown;
	contentEl = createMockEl();
	constructor(app: unknown) {
		this.app = app;
	}
	open() {}
	close() {}
	onOpen() {}
	onClose() {}
}

// --- PluginSettingTab mock ---
export class PluginSettingTab {
	app: unknown;
	plugin: unknown;
	containerEl = createMockEl();
	constructor(app: unknown, plugin: unknown) {
		this.app = app;
		this.plugin = plugin;
	}
	display() {}
	hide() {}
}

// --- Plugin mock ---
export class Plugin {
	app: MockApp;
	manifest = { id: "jotbird", name: "JotBird", version: "0.1.0" };

	private _data: unknown = null;

	constructor() {
		this.app = createMockApp();
	}

	addRibbonIcon = vi.fn();
	addCommand = vi.fn();
	addSettingTab = vi.fn();
	addStatusBarItem = vi.fn();
	registerEvent = vi.fn();
	registerInterval = vi.fn();
	registerDomEvent = vi.fn();
	registerObsidianProtocolHandler = vi.fn();

	async loadData(): Promise<unknown> {
		return this._data;
	}
	async saveData(data: unknown): Promise<void> {
		this._data = data;
	}

	/** Test helper: seed the data that loadData returns */
	_setData(data: unknown) {
		this._data = data;
	}
}

// --- MetadataTypeManager mock ---
export class MetadataTypeManager {
	setType = vi.fn();
}

// --- App mock helper ---
export interface MockApp {
	vault: Vault;
	workspace: Workspace;
	fileManager: FileManager;
	metadataCache: MetadataCache;
	metadataTypeManager: MetadataTypeManager;
}

export function createMockApp(): MockApp {
	return {
		vault: new Vault(),
		workspace: new Workspace(),
		fileManager: new FileManager(),
		metadataCache: new MetadataCache(),
		metadataTypeManager: new MetadataTypeManager(),
	};
}

// --- DOM element mock (minimal) ---
function createMockEl(): MockElement {
	const el: MockElement = {
		children: [],
		classList: { add: vi.fn() },
		style: {},
		createEl: vi.fn((_tag: string, _opts?: unknown) => createMockEl()),
		addClass: vi.fn(),
		empty: vi.fn(),
		setText: vi.fn(),
		setAttr: vi.fn(),
		querySelector: vi.fn().mockReturnValue(null),
	};
	return el;
}

interface MockElement {
	children: unknown[];
	classList: { add: (...args: string[]) => void };
	style: Record<string, string>;
	createEl: ReturnType<typeof vi.fn>;
	addClass: ReturnType<typeof vi.fn>;
	empty: ReturnType<typeof vi.fn>;
	setText: ReturnType<typeof vi.fn>;
	setAttr: ReturnType<typeof vi.fn>;
	querySelector: ReturnType<typeof vi.fn>;
}
