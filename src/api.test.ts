import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { requestUrl } from "obsidian";
import { publishNote, listDocuments, deleteDocument, uploadImage, trialPublish, trialDeleteDocument, getPortalUrl, setClientVersion } from "./api";

const mockRequestUrl = vi.mocked(requestUrl);

beforeEach(() => {
	mockRequestUrl.mockReset();
});

// ---- publishNote ----

describe("publishNote", () => {
	it("sends correct request for a new publish", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 201,
			json: {
				slug: "bright-calm-meadow",
				url: "https://share.jotbird.com/bright-calm-meadow",
				title: "Hello World",
				expiresAt: "2026-05-10T12:00:00.000Z",
				ttlDays: 90,
				created: true,
			},
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		const result = await publishNote("jb_test_key", "# Hello", "Hello World");

		expect(mockRequestUrl).toHaveBeenCalledOnce();
		const call = mockRequestUrl.mock.calls[0][0];
		expect(call).toMatchObject({
			url: "https://api.jotbird.com/cli/publish",
			method: "POST",
			contentType: "application/json",
			throw: false,
		});
		expect(call.headers).toMatchObject({
			Authorization: "Bearer jb_test_key",
			"User-Agent": expect.stringMatching(/^jotbird-obsidian\/\d+\.\d+\.\d+$/),
		});
		const body = JSON.parse(call.body as string);
		expect(body).toEqual({ markdown: "# Hello", title: "Hello World" });
		expect(body.slug).toBeUndefined();

		expect(result.slug).toBe("bright-calm-meadow");
		expect(result.url).toBe("https://share.jotbird.com/bright-calm-meadow");
		expect(result.created).toBe(true);
	});

	it("includes slug when updating an existing document", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				slug: "my-doc",
				url: "https://share.jotbird.com/my-doc",
				title: "Updated",
				expiresAt: "2026-05-10T12:00:00.000Z",
				ttlDays: 90,
				created: false,
			},
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		await publishNote("jb_test_key", "# Updated", "Updated", "my-doc");

		const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body as string);
		expect(body.slug).toBe("my-doc");
	});

	it("includes documentId when provided, and still sends slug as a fallback", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				documentId: "doc-uuid-123",
				slug: "renamed-in-web-app",
				url: "https://share.jotbird.com/@matt/renamed-in-web-app",
				username: "matt",
				title: "Updated",
				expiresAt: null,
				ttlDays: null,
				created: false,
			},
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		const result = await publishNote("jb_test_key", "# Updated", "Updated", "stale-slug", "doc-uuid-123");

		const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body as string);
		expect(body.documentId).toBe("doc-uuid-123");
		expect(body.slug).toBe("stale-slug"); // sent, but the server treats documentId as authoritative

		// Response surfaces the document's current (server-resolved) slug + namespace
		expect(result.documentId).toBe("doc-uuid-123");
		expect(result.slug).toBe("renamed-in-web-app");
		expect(result.username).toBe("matt");
	});

	it("sends renderTitle when requested, and omits it otherwise", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 201,
			json: { slug: "s", url: "https://share.jotbird.com/s", title: "T", expiresAt: null, ttlDays: null, created: true },
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		await publishNote("jb_test_key", "# T", "T", undefined, undefined, true);
		expect(JSON.parse(mockRequestUrl.mock.calls[0][0].body as string).renderTitle).toBe(true);

		mockRequestUrl.mockClear();
		await publishNote("jb_test_key", "# T", "T");
		expect(JSON.parse(mockRequestUrl.mock.calls[0][0].body as string).renderTitle).toBeUndefined();
	});

	it("throws on 401 unauthorized", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 401,
			json: { error: "Invalid or expired API key" },
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		await expect(publishNote("bad_key", "# Test", "Test")).rejects.toThrow(
			"Publish: Invalid or expired API key"
		);
	});

	it("throws on 429 rate limit", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 429,
			json: { error: "Publishing quota exceeded" },
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		await expect(publishNote("jb_key", "# Test", "Test")).rejects.toThrow(
			"Publish: Publishing quota exceeded"
		);
	});

	it("throws on 413 payload too large", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 413,
			json: { error: "Rendered HTML exceeds 512 KB" },
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		await expect(publishNote("jb_key", "huge content", "Big Doc")).rejects.toThrow(
			"Publish: Rendered HTML exceeds 512 KB"
		);
	});

	it("handles error response without error field", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 500,
			json: {},
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		await expect(publishNote("jb_key", "# Test", "Test")).rejects.toThrow(
			"Publish: Request failed with status 500"
		);
	});
});

// ---- listDocuments ----

describe("listDocuments", () => {
	it("sends correct GET request and returns documents", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				documents: [
					{
						slug: "my-doc",
						title: "My Document",
						url: "https://share.jotbird.com/my-doc",
						source: "api",
						updatedAt: "2026-02-09T14:30:00.000Z",
						expiresAt: "2026-05-10T14:30:00.000Z",
					},
				],
			},
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		const result = await listDocuments("jb_test_key");

		expect(mockRequestUrl).toHaveBeenCalledOnce();
		const call = mockRequestUrl.mock.calls[0][0];
		expect(call).toMatchObject({
			url: "https://api.jotbird.com/cli/documents",
			method: "POST",
			throw: false,
		});
		expect(call.headers).toMatchObject({
			Authorization: "Bearer jb_test_key",
		});

		expect(result.documents).toHaveLength(1);
		expect(result.documents[0].slug).toBe("my-doc");
	});

	it("returns isPro when present in response", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				documents: [],
				isPro: true,
			},
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		const result = await listDocuments("jb_test_key");

		expect(result.isPro).toBe(true);
	});

	it("returns isPro as undefined when not in response", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				documents: [],
			},
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		const result = await listDocuments("jb_test_key");

		expect(result.isPro).toBeUndefined();
	});

	it("throws on authentication error", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 401,
			json: { error: "Invalid or expired API key" },
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		await expect(listDocuments("bad_key")).rejects.toThrow(
			"List documents: Invalid or expired API key"
		);
	});
});

// ---- deleteDocument ----

describe("deleteDocument", () => {
	it("sends correct delete request", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { ok: true },
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		const result = await deleteDocument("jb_test_key", "my-doc");

		expect(mockRequestUrl).toHaveBeenCalledOnce();
		const call = mockRequestUrl.mock.calls[0][0];
		expect(call).toMatchObject({
			url: "https://api.jotbird.com/cli/documents/remove",
			method: "POST",
			contentType: "application/json",
			throw: false,
		});
		const body = JSON.parse(call.body as string);
		expect(body).toEqual({ slug: "my-doc" });

		expect(result.ok).toBe(true);
	});

	it("includes documentId when provided (deletes namespaced docs the slug-only path can't find)", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { ok: true },
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		await deleteDocument("jb_test_key", "old-slug", "doc-uuid-xyz");

		const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body as string);
		expect(body.documentId).toBe("doc-uuid-xyz");
		expect(body.slug).toBe("old-slug");
	});

	it("uses /remove endpoint (hard delete) not /delete (soft unpublish)", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { ok: true },
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		await deleteDocument("jb_test_key", "my-doc");

		const url = mockRequestUrl.mock.calls[0][0].url;
		expect(url).toBe("https://api.jotbird.com/cli/documents/remove");
		expect(url).not.toContain("/documents/delete");
	});

	it("throws on 404 not found", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 404,
			json: { error: "Document not found" },
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		await expect(deleteDocument("jb_key", "nonexistent")).rejects.toThrow(
			"Delete: Document not found"
		);
	});
});

// ---- getPortalUrl ----

describe("getPortalUrl", () => {
	it("POSTs to the www host (apex 301-downgrades POST→GET) and returns the portal url", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { url: "https://billing.stripe.com/session/abc" },
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		const url = await getPortalUrl("jb_test_key");

		const call = mockRequestUrl.mock.calls[0][0];
		expect(call.url).toBe("https://www.jotbird.com/api/stripe/portal-key");
		expect(call.method).toBe("POST");
		const body = JSON.parse(call.body as string);
		expect(body.apiKey).toBe("jb_test_key");
		expect(url).toBe("https://billing.stripe.com/session/abc");
	});

	it("throws when the response has no url", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {},
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		await expect(getPortalUrl("jb_test_key")).rejects.toThrow("No portal URL returned");
	});
});

// ---- trialPublish ----

describe("trialPublish", () => {
	it("sends correct request for a new trial publish", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 201,
			json: {
				slug: "trial-doc",
				url: "https://share.jotbird.com/trial-doc",
				title: "Trial Note",
				expiresAt: "2026-03-17T12:00:00.000Z",
				ttlDays: 30,
				created: true,
				editToken: "tok_abc123",
			},
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		const result = await trialPublish("fp_device123", "# Trial", "Trial Note");

		expect(mockRequestUrl).toHaveBeenCalledOnce();
		const call = mockRequestUrl.mock.calls[0][0];
		expect(call).toMatchObject({
			url: "https://api.jotbird.com/trial/publish",
			method: "POST",
			contentType: "application/json",
			throw: false,
		});
		expect(call.headers).toMatchObject({
			"User-Agent": expect.stringMatching(/^jotbird-obsidian\/\d+\.\d+\.\d+$/),
			"X-Device-Fingerprint": "fp_device123",
		});
		expect(call.headers?.Authorization).toBeUndefined();
		const body = JSON.parse(call.body as string);
		expect(body).toEqual({ markdown: "# Trial", title: "Trial Note" });
		expect(body.slug).toBeUndefined();
		expect(body.editToken).toBeUndefined();

		expect(result.slug).toBe("trial-doc");
		expect(result.editToken).toBe("tok_abc123");
	});

	it("includes slug and editToken when updating a trial document", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				slug: "trial-doc",
				url: "https://share.jotbird.com/trial-doc",
				title: "Updated Trial",
				expiresAt: "2026-03-17T12:00:00.000Z",
				ttlDays: 30,
				created: false,
				editToken: "tok_abc123",
			},
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		await trialPublish("fp_device123", "# Updated", "Updated Trial", "trial-doc", "tok_abc123");

		const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body as string);
		expect(body.slug).toBe("trial-doc");
		expect(body.editToken).toBe("tok_abc123");
	});

	it("throws on 429 rate limit", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 429,
			json: { error: "Trial publish limit exceeded" },
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		await expect(trialPublish("fp_device123", "# Test", "Test")).rejects.toThrow(
			"Publish: Trial publish limit exceeded"
		);
	});
});

// ---- trialDeleteDocument ----

describe("trialDeleteDocument", () => {
	it("sends correct delete request with edit token", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { ok: true },
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		const result = await trialDeleteDocument("trial-doc", "tok_abc123", "fp_device123");

		expect(mockRequestUrl).toHaveBeenCalledOnce();
		const call = mockRequestUrl.mock.calls[0][0];
		expect(call).toMatchObject({
			url: "https://api.jotbird.com/trial/documents/delete",
			method: "POST",
			contentType: "application/json",
			throw: false,
		});
		expect(call.headers).toMatchObject({
			"User-Agent": expect.stringMatching(/^jotbird-obsidian\/\d+\.\d+\.\d+$/),
			"X-Device-Fingerprint": "fp_device123",
		});
		expect(call.headers?.Authorization).toBeUndefined();
		const body = JSON.parse(call.body as string);
		expect(body).toEqual({ slug: "trial-doc", editToken: "tok_abc123" });

		expect(result.ok).toBe(true);
	});

	it("throws on 403 forbidden", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 403,
			json: { error: "Invalid edit token" },
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		await expect(trialDeleteDocument("trial-doc", "bad_token", "fp_device123")).rejects.toThrow(
			"Delete: Invalid edit token"
		);
	});
});

// ---- uploadImage ----

describe("uploadImage", () => {
	it("sends multipart form data with correct boundary and headers", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { url: "https://share.jotbird.com/images/abc123.png" },
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		const imageData = new ArrayBuffer(16);
		const result = await uploadImage("jb_test_key", imageData, "photo.png", "image/png");

		expect(mockRequestUrl).toHaveBeenCalledOnce();
		const call = mockRequestUrl.mock.calls[0][0];
		expect(call.url).toBe("https://api.jotbird.com/preview/upload-image");
		expect(call.method).toBe("POST");
		expect(call.headers?.Authorization).toBe("Bearer jb_test_key");
		expect(call.headers?.["Content-Type"]).toMatch(/^multipart\/form-data; boundary=/);
		expect(call.headers?.["User-Agent"]).toMatch(/^jotbird-obsidian\/\d+\.\d+\.\d+$/);

		// Verify the body is an ArrayBuffer containing the multipart data
		expect(call.body).toBeInstanceOf(ArrayBuffer);
		const bodyStr = new TextDecoder().decode(new Uint8Array(call.body as ArrayBuffer));
		expect(bodyStr).toContain('Content-Disposition: form-data; name="file"; filename="photo.png"');
		expect(bodyStr).toContain("Content-Type: image/png");

		expect(result.url).toBe("https://share.jotbird.com/images/abc123.png");
	});

	it("throws on 413 file too large", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 413,
			json: { error: "File exceeds 10MB limit" },
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		await expect(
			uploadImage("jb_key", new ArrayBuffer(0), "huge.png", "image/png")
		).rejects.toThrow("Image upload: File exceeds 10MB limit");
	});

	it("throws on authentication error", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 401,
			json: { error: "Invalid or expired API key" },
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		await expect(
			uploadImage("bad_key", new ArrayBuffer(0), "img.png", "image/png")
		).rejects.toThrow("Image upload: Invalid or expired API key");
	});

	it("skips Authorization header when apiKey is empty", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { url: "https://share.jotbird.com/images/anon.png" },
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		await uploadImage("", new ArrayBuffer(4), "anon.png", "image/png");

		const call = mockRequestUrl.mock.calls[0][0];
		expect(call.headers?.Authorization).toBeUndefined();
		expect(call.headers?.["User-Agent"]).toMatch(/^jotbird-obsidian\/\d+\.\d+\.\d+$/);
	});
});

// ---- setClientVersion ----

describe("setClientVersion", () => {
	// Restore the module default so this block doesn't leak version state into
	// other suites (which only assert the User-Agent's shape, not its value).
	afterEach(() => setClientVersion("0.0.0"));

	it("stamps the supplied manifest version onto the request User-Agent", async () => {
		setClientVersion("9.8.7");
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { documents: [] },
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		} as never);

		await listDocuments("jb_test_key");

		const call = mockRequestUrl.mock.calls[0][0];
		expect(call.headers?.["User-Agent"]).toBe("jotbird-obsidian/9.8.7");
	});
});
