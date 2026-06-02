import { requestUrl, RequestUrlParam } from "obsidian";
import {
	PublishResponse,
	DocumentListResponse,
	DeleteResponse,
	ClaimResponse,
	ImageUploadResponse,
} from "./types";

const BASE_URL = "https://api.jotbird.com";
const IMAGE_UPLOAD_URL = `${BASE_URL}/preview/upload-image`;
const USER_AGENT = "jotbird-obsidian/0.4.8";

function headers(apiKey: string): Record<string, string> {
	const h: Record<string, string> = { "User-Agent": USER_AGENT };
	if (apiKey) {
		h.Authorization = `Bearer ${apiKey}`;
	}
	return h;
}

async function apiRequest(params: RequestUrlParam): Promise<{ status: number; json: unknown }> {
	const response = await requestUrl({ ...params, throw: false });
	let json: unknown;
	try {
		json = response.json;
	} catch {
		// Response body is not valid JSON (e.g. plain-text "Not found")
		json = { error: response.text || `Request failed with status ${response.status}` };
	}
	return { status: response.status, json };
}

function assertOk(status: number, json: unknown, context: string): void {
	if (status >= 400) {
		const errMsg =
			json && typeof json === "object" && "error" in json
				? (json as { error: string }).error
				: `Request failed with status ${status}`;
		throw new Error(`${context}: ${errMsg}`);
	}
}

export async function publishNote(
	apiKey: string,
	markdown: string,
	title: string,
	slug?: string,
	documentId?: string,
	renderTitle?: boolean
): Promise<PublishResponse> {
	const body: Record<string, string | boolean> = { markdown, title };
	// documentId is the authoritative identifier for updates; the server resolves
	// the document's current slug/namespace from it. slug is still sent for the
	// first publish and as a fallback for notes published before documentId existed.
	if (documentId) {
		body.documentId = documentId;
	}
	if (slug) {
		body.slug = slug;
	}
	// Opt-in dedicated page-title header (non-Automatic title modes).
	if (renderTitle) {
		body.renderTitle = true;
	}

	const { status, json } = await apiRequest({
		url: `${BASE_URL}/cli/publish`,
		method: "POST",
		contentType: "application/json",
		body: JSON.stringify(body),
		headers: headers(apiKey),
	});

	assertOk(status, json, "Publish");
	return json as PublishResponse;
}

export async function listDocuments(apiKey: string): Promise<DocumentListResponse> {
	const { status, json } = await apiRequest({
		url: `${BASE_URL}/cli/documents`,
		method: "POST",
		headers: headers(apiKey),
	});

	assertOk(status, json, "List documents");
	return json as DocumentListResponse;
}

export async function deleteDocument(apiKey: string, slug: string, documentId?: string): Promise<DeleteResponse> {
	// documentId is authoritative and works for namespaced docs too; the slug-only path on the
	// server can't find namespaced pages and would 404. slug is still sent as a fallback.
	const body: Record<string, string> = { slug };
	if (documentId) {
		body.documentId = documentId;
	}
	const { status, json } = await apiRequest({
		url: `${BASE_URL}/cli/documents/remove`,
		method: "POST",
		contentType: "application/json",
		body: JSON.stringify(body),
		headers: headers(apiKey),
	});

	assertOk(status, json, "Delete");
	return json as DeleteResponse;
}

export async function claimDocument(
	apiKey: string,
	slug: string,
	editToken: string
): Promise<ClaimResponse> {
	const { status, json } = await apiRequest({
		url: `${BASE_URL}/cli/claim`,
		method: "POST",
		contentType: "application/json",
		body: JSON.stringify({ slug, editToken }),
		headers: headers(apiKey),
	});

	assertOk(status, json, "Claim");
	return json as ClaimResponse;
}

export async function trialPublish(
	deviceFingerprint: string,
	markdown: string,
	title: string,
	slug?: string,
	editToken?: string,
	renderTitle?: boolean
): Promise<PublishResponse> {
	const body: Record<string, string | boolean> = { markdown, title };
	if (slug) body.slug = slug;
	if (editToken) body.editToken = editToken;
	if (renderTitle) body.renderTitle = true;

	const { status, json } = await apiRequest({
		url: `${BASE_URL}/trial/publish`,
		method: "POST",
		contentType: "application/json",
		body: JSON.stringify(body),
		headers: {
			"User-Agent": USER_AGENT,
			"X-Device-Fingerprint": deviceFingerprint,
		},
	});

	assertOk(status, json, "Publish");
	return json as PublishResponse;
}

export async function trialDeleteDocument(
	slug: string,
	editToken: string,
	deviceFingerprint: string
): Promise<DeleteResponse> {
	const { status, json } = await apiRequest({
		url: `${BASE_URL}/trial/documents/delete`,
		method: "POST",
		contentType: "application/json",
		body: JSON.stringify({ slug, editToken }),
		headers: {
			"User-Agent": USER_AGENT,
			"X-Device-Fingerprint": deviceFingerprint,
		},
	});

	assertOk(status, json, "Delete");
	return json as DeleteResponse;
}

export async function getPortalUrl(apiKey: string): Promise<string> {
	// Must hit www directly: the apex domain (jotbird.com) 301-redirects to www, and a 301
	// downgrades this POST to a GET (only 307/308 preserve the method), which the route
	// rejects with 405. Browser-opened GET links elsewhere tolerate the redirect; this
	// programmatic POST does not.
	const baseUrl = "https://www.jotbird.com";
	const { status, json } = await apiRequest({
		url: `${baseUrl}/api/stripe/portal-key`,
		method: "POST",
		contentType: "application/json",
		body: JSON.stringify({ apiKey }),
		headers: headers(apiKey),
	});

	assertOk(status, json, "Manage subscription");
	const resp = json as { url: string };
	if (!resp.url) {
		throw new Error("No portal URL returned");
	}
	return resp.url;
}

export async function uploadImage(
	apiKey: string,
	imageData: ArrayBuffer,
	filename: string,
	mimeType: string
): Promise<ImageUploadResponse> {
	// Build multipart form data manually since Obsidian's requestUrl
	// doesn't support FormData directly
	const boundary = "----JotBirdUpload" + Date.now().toString(36);
	const encoder = new TextEncoder();

	const preamble = encoder.encode(
		`--${boundary}\r\n` +
			`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
			`Content-Type: ${mimeType}\r\n\r\n`
	);
	const epilogue = encoder.encode(`\r\n--${boundary}--\r\n`);

	const body = new Uint8Array(preamble.length + imageData.byteLength + epilogue.length);
	body.set(preamble, 0);
	body.set(new Uint8Array(imageData), preamble.length);
	body.set(epilogue, preamble.length + imageData.byteLength);

	const { status, json } = await apiRequest({
		url: IMAGE_UPLOAD_URL,
		method: "POST",
		headers: {
			...headers(apiKey),
			"Content-Type": `multipart/form-data; boundary=${boundary}`,
		},
		body: body.buffer,
	});

	assertOk(status, json, "Image upload");
	return json as ImageUploadResponse;
}
