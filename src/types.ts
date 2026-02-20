export interface JotBirdSettings {
	apiKey: string;
	stripTags: boolean;
	autoCopyLink: boolean;
	storeFrontmatter: boolean;
}

export const DEFAULT_SETTINGS: JotBirdSettings = {
	apiKey: "",
	stripTags: true,
	autoCopyLink: true,
	storeFrontmatter: true,
};

/** Mapping of file path -> published document info */
export interface PublishedNote {
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

export interface PublishResponse {
	slug: string;
	url: string;
	title: string;
	expiresAt: string | null;
	ttlDays: number | null;
	created: boolean;
	editToken?: string;
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

export interface ApiError {
	error: string;
}
