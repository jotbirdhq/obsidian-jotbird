export const SITE_URL = "https://jotbird.com";

/** Valid page themes — mirrors the server enum (VALID_THEMES in the Worker). */
export const THEME_OPTIONS: Record<string, string> = {
	default: "Default",
	minimal: "Minimal",
	essay: "Essay",
	terminal: "Terminal",
};

export type PageVisibility = "unlisted" | "password" | "public";

export const VISIBILITY_OPTIONS: Record<PageVisibility, string> = {
	unlisted: "Unlisted",
	public: "Public",
	password: "Password-protected",
};

export interface JotBirdSettings {
	apiKey: string;
	stripTags: boolean;
	autoCopyLink: boolean;
	storeFrontmatter: boolean;
	/** Where the published page title comes from. "auto" preserves the original behavior. */
	titleMode: "auto" | "filename" | "h1";
	/**
	 * Vault-wide default page theme, sent with every publish once set. "" means
	 * "Leave as-is (don't manage)": nothing is sent and the server preserves
	 * whatever each page already has — the shipping default, so installing or
	 * upgrading the plugin can never clobber a theme set in the web app.
	 * A jotbird_theme note property overrides this per note.
	 */
	defaultTheme: "" | "default" | "minimal" | "essay" | "terminal";
	/**
	 * Vault-wide default branding, same "leave as-is" contract as defaultTheme.
	 * A jotbird_hide_branding note property overrides this per note.
	 */
	defaultHideBranding: "" | "show" | "hide";
}

export const DEFAULT_SETTINGS: JotBirdSettings = {
	apiKey: "",
	stripTags: true,
	autoCopyLink: true,
	storeFrontmatter: true,
	titleMode: "auto",
	defaultTheme: "",
	defaultHideBranding: "",
};

/** Mapping of file path -> published document info */
export interface PublishedNote {
	/**
	 * Stable document UUID. Identifies the document on update regardless of
	 * later slug/namespace changes made in the web app. Absent for notes
	 * published before this field existed; backfilled on their next publish.
	 */
	documentId?: string;
	slug: string;
	url: string;
	editToken?: string;
	publishedAt: string;
}

export interface PluginData {
	settings: JotBirdSettings;
	publishedNotes: Record<string, PublishedNote>;
	deviceFingerprint: string;
	proRefreshDone?: boolean;
}

/**
 * A page setting the publish couldn't honor (Pro-gated, invalid, or a
 * Pro-preserved setting dropped on a lapsed account's republish). The publish
 * itself succeeded; `message` is display-ready.
 */
export interface PublishWarning {
	setting: string;
	/** "pro_required" | "invalid_value" | "pro_lapsed" — open-ended so a newer
	 * server can add reasons without breaking older plugin versions. */
	reason: string;
	message: string;
}

/** Page settings riding along with a publish. Values are forwarded verbatim
 * from frontmatter — the server validates and reports problems in warnings. */
export interface PagePublishSettings {
	theme?: unknown;
	hideBranding?: unknown;
}

export interface PublishResponse {
	documentId?: string;
	slug: string;
	username?: string;
	url: string;
	title: string;
	expiresAt: string | null;
	ttlDays: number | null;
	created: boolean;
	editToken?: string;
	warnings?: PublishWarning[];
}

export interface DocumentListItem {
	slug: string;
	title: string;
	url: string;
	source: string;
	updatedAt: string;
	expiresAt: string;
}

export interface DocumentListResponse {
	documents: DocumentListItem[];
	isPro?: boolean;
}

export interface DeleteResponse {
	ok: boolean;
}

export interface ClaimResponse {
	ok: boolean;
	slug: string;
	url: string;
	expiresAt: string | null;
	ttlDays: number | null;
}

export interface ImageUploadResponse {
	url: string;
}

/** GET/PATCH /cli/settings response (the public settings representation).
 * The page password is write-only — only the visibility state name appears. */
export interface PageSettingsView {
	slug: string;
	username: string | null;
	url: string;
	title: string | null;
	theme: string;
	hideBranding: boolean;
	visibility: PageVisibility;
	tags: string[];
	expiresAt: string | null;
}

export interface PageSettingsPatch {
	theme?: string;
	hideBranding?: boolean;
	visibility?: PageVisibility;
	password?: string;
}

export interface ApiError {
	error: string;
}
