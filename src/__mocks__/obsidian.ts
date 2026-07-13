import { vi } from "vitest";

// --- addIcon / setIcon mock ---
export const addIcon = vi.fn();
export const setIcon = vi.fn();

// --- requestUrl mock ---
export const requestUrl = vi.fn();

// --- Notice mock ---
// A vi.fn-backed constructor so tests can assert on shown notices via
// vi.mocked(Notice).mock.calls (cleared by vi.clearAllMocks in beforeEach).
export const Notice = vi.fn().mockImplementation(function (
	this: { message: string },
	message: string,
	_timeout?: number
) {
	this.message = message;
});

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
// Settings built during a render are recorded in `renderedSettings` so tests can
// drive real UI interactions (type a password, click Save) instead of reaching
// into private methods.
//
// ⚠️ A Setting remembers the container it was built into, and a mock element's
// empty() REMOVES that container's settings from this list — mirroring what
// containerEl.empty() does to the real DOM at the top of every render(). Without
// that, a re-render would leave the previous render's components in the list,
// and a test reading the first match would silently assert against a stale,
// off-screen control while believing it checked the live one.
export const renderedSettings: Setting[] = [];

export function resetRenderedSettings(): void {
	renderedSettings.length = 0;
}

function dropSettingsFor(containerEl: unknown): void {
	for (let i = renderedSettings.length - 1; i >= 0; i--) {
		if (renderedSettings[i].containerEl === containerEl) {
			renderedSettings.splice(i, 1);
		}
	}
}

export class Setting {
	settingEl = createMockEl();
	controlEl = createMockEl();
	containerEl: unknown;
	name = "";
	texts: TextComponent[] = [];
	toggles: ToggleComponent[] = [];
	buttons: ButtonComponent[] = [];
	dropdowns: DropdownComponent[] = [];
	constructor(containerEl: unknown) {
		this.containerEl = containerEl;
		renderedSettings.push(this);
	}
	setName(name: string) {
		this.name = name;
		return this;
	}
	setDesc(_desc: string) {
		return this;
	}
	setHeading() {
		return this;
	}
	addText(cb: (text: TextComponent) => void) {
		const text = new TextComponent();
		this.texts.push(text);
		cb(text);
		return this;
	}
	addToggle(cb: (toggle: ToggleComponent) => void) {
		const toggle = new ToggleComponent();
		this.toggles.push(toggle);
		cb(toggle);
		return this;
	}
	addButton(cb: (btn: ButtonComponent) => void) {
		const btn = new ButtonComponent();
		this.buttons.push(btn);
		cb(btn);
		return this;
	}
	addDropdown(cb: (dd: DropdownComponent) => void) {
		const dd = new DropdownComponent();
		this.dropdowns.push(dd);
		cb(dd);
		return this;
	}
	then(cb: (setting: Setting) => void) {
		cb(this);
		return this;
	}
}

class TextComponent {
	inputEl = { type: "text", addClass: vi.fn() };
	value = "";
	disabled = false;
	private changeCb: ((value: string) => void) | null = null;
	setPlaceholder(_p: string) {
		return this;
	}
	setValue(v: string) {
		this.value = v;
		return this;
	}
	onChange(cb: (value: string) => void) {
		this.changeCb = cb;
		return this;
	}
	setDisabled(d: boolean) {
		this.disabled = d;
		return this;
	}
	/** Test helper: simulate the user typing. */
	type(v: string) {
		this.value = v;
		this.changeCb?.(v);
	}
}

class ToggleComponent {
	value = false;
	disabled = false;
	private changeCb: ((value: boolean) => void) | null = null;
	setValue(v: boolean) {
		this.value = v;
		return this;
	}
	onChange(cb: (value: boolean) => void) {
		this.changeCb = cb;
		return this;
	}
	setDisabled(d: boolean) {
		this.disabled = d;
		return this;
	}
	/** Test helper: simulate the user flipping the toggle. */
	toggle(v: boolean) {
		this.value = v;
		this.changeCb?.(v);
	}
}

class DropdownComponent {
	value = "";
	disabled = false;
	options: string[] = [];
	private changeCb: ((value: string) => void) | null = null;
	addOption(value: string, _display: string) {
		this.options.push(value);
		return this;
	}
	addOptions(options: Record<string, string>) {
		this.options.push(...Object.keys(options));
		return this;
	}
	setValue(v: string) {
		this.value = v;
		return this;
	}
	onChange(cb: (value: string) => void) {
		this.changeCb = cb;
		return this;
	}
	setDisabled(d: boolean) {
		this.disabled = d;
		return this;
	}
	/** Test helper: simulate the user picking an option. */
	select(v: string) {
		this.value = v;
		this.changeCb?.(v);
	}
}

class ButtonComponent {
	text = "";
	disabled = false;
	private clickCb: (() => void) | null = null;
	setButtonText(t: string) {
		this.text = t;
		return this;
	}
	setCta() {
		return this;
	}
	setWarning() {
		return this;
	}
	onClick(cb: () => void) {
		this.clickCb = cb;
		return this;
	}
	setDisabled(d: boolean) {
		this.disabled = d;
		return this;
	}
	/** Test helper: simulate the user clicking. */
	click() {
		this.clickCb?.();
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
		// Clearing a container discards the Settings built into it, exactly as the
		// real containerEl.empty() does at the top of a render(). Keeps
		// `renderedSettings` reflecting what is actually on screen.
		empty: vi.fn(() => dropSettingsFor(el)),
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
