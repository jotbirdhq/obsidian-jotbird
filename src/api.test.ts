import { describe, it, expect, vi, beforeEach } from "vitest";
import { requestUrl } from "obsidian";
import { publishNote, listDocuments, deleteDocument, uploadImage, trialPublish, trialDeleteDocument } from "./api";

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
			"User-Agent": "jotbird-obsidian/0.1.0",
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
			url: "https://api.jotbird.com/cli/documents/delete",
			method: "POST",
			contentType: "application/json",
			throw: false,
		});
		const body = JSON.parse(call.body as string);
		expect(body).toEqual({ slug: "my-doc" });

		expect(result.ok).toBe(true);
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
			"User-Agent": "jotbird-obsidian/0.1.0",
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
			"User-Agent": "jotbird-obsidian/0.1.0",
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
		expect(call.headers?.["User-Agent"]).toBe("jotbird-obsidian/0.1.0");

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
		expect(call.headers?.["User-Agent"]).toBe("jotbird-obsidian/0.1.0");
	});
});
