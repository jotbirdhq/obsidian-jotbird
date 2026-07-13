import { describe, it, expect } from "vitest";
import {
	resolvePagePublishSettings,
	reconcileNoteProperty,
	nextPublishValue,
	FM_THEME,
	FM_HIDE_BRANDING,
} from "./pageSettings";

const noDefaults = { defaultTheme: "" as const, defaultHideBranding: "" as const };

describe("resolvePagePublishSettings", () => {
	it("returns undefined when neither frontmatter nor vault defaults specify anything", () => {
		expect(resolvePagePublishSettings(undefined, noDefaults)).toBeUndefined();
		expect(resolvePagePublishSettings({}, noDefaults)).toBeUndefined();
		expect(
			resolvePagePublishSettings({ jotbird_link: "https://share.jotbird.com/x" }, noDefaults)
		).toBeUndefined();
	});

	it("sends frontmatter values verbatim (server validates)", () => {
		expect(
			resolvePagePublishSettings(
				{ [FM_THEME]: "essay", [FM_HIDE_BRANDING]: true },
				noDefaults
			)
		).toEqual({ theme: "essay", hideBranding: true });
		// Invalid values are forwarded too — the server is the authority and
		// reports them in the publish response's warnings.
		expect(resolvePagePublishSettings({ [FM_THEME]: "esay" }, noDefaults)).toEqual({
			theme: "esay",
		});
	});

	it("uses the vault default when the note has no override", () => {
		expect(
			resolvePagePublishSettings({}, { defaultTheme: "minimal", defaultHideBranding: "" })
		).toEqual({ theme: "minimal" });
		expect(
			resolvePagePublishSettings({}, { defaultTheme: "", defaultHideBranding: "hide" })
		).toEqual({ hideBranding: true });
		expect(
			resolvePagePublishSettings({}, { defaultTheme: "", defaultHideBranding: "show" })
		).toEqual({ hideBranding: false });
	});

	it("per-note frontmatter beats the vault default", () => {
		expect(
			resolvePagePublishSettings(
				{ [FM_THEME]: "essay" },
				{ defaultTheme: "minimal", defaultHideBranding: "" }
			)
		).toEqual({ theme: "essay" });
	});

	it("an explicit false beats a vault default of hide (tri-state, not falsy-collapsed)", () => {
		expect(
			resolvePagePublishSettings(
				{ [FM_HIDE_BRANDING]: false },
				{ defaultTheme: "", defaultHideBranding: "hide" }
			)
		).toEqual({ hideBranding: false });
	});

	it("treats a blank/null property as absent, falling through to the default", () => {
		expect(
			resolvePagePublishSettings(
				{ [FM_THEME]: null, [FM_HIDE_BRANDING]: "" },
				{ defaultTheme: "terminal", defaultHideBranding: "hide" }
			)
		).toEqual({ theme: "terminal", hideBranding: true });
	});

	it('sends an explicit "default" theme from frontmatter (clearing, allowed for any account)', () => {
		expect(
			resolvePagePublishSettings(
				{ [FM_THEME]: "default" },
				{ defaultTheme: "minimal", defaultHideBranding: "" }
			)
		).toEqual({ theme: "default" });
	});
});

// ---- reconcileNoteProperty: the pull command's decision table ----
//
// The bug this table exists to prevent: REMOVING a property is not the same as
// having none, because a vault-wide default rushes in behind it.

describe("reconcileNoteProperty", () => {
	it("materializes a setting the page actually has", () => {
		expect(reconcileNoteProperty(FM_THEME, "essay", {}, noDefaults)).toEqual({
			action: "write",
			value: "essay",
		});
		expect(reconcileNoteProperty(FM_HIDE_BRANDING, true, {}, noDefaults)).toEqual({
			action: "write",
			value: true,
		});
	});

	it("removes a stale property when the page is back to its default", () => {
		expect(
			reconcileNoteProperty(FM_THEME, "default", { [FM_THEME]: "essay" }, noDefaults)
		).toEqual({ action: "remove" });
		expect(
			reconcileNoteProperty(FM_HIDE_BRANDING, false, { [FM_HIDE_BRANDING]: true }, noDefaults)
		).toEqual({ action: "remove" });
	});

	it("does nothing when the note has no property and the page is at its default", () => {
		expect(reconcileNoteProperty(FM_THEME, "default", {}, noDefaults)).toEqual({
			action: "none",
		});
	});

	it("⚠️ NEVER removes an explicit clearing value that a vault default would override", () => {
		// The regression: the note says `hide_branding: false` to override a vault
		// default of "hide", and the page correctly shows branding. REMOVING the
		// property would hand the next publish to the vault default and hide the
		// branding on a page the user never touched. The property is already doing
		// its job, so the action is "none" — but the point is that it is not
		// "remove", which is what the buggy version did.
		expect(
			reconcileNoteProperty(
				FM_HIDE_BRANDING,
				false,
				{ [FM_HIDE_BRANDING]: false },
				{ defaultTheme: "", defaultHideBranding: "hide" }
			)
		).toEqual({ action: "none" });

		expect(
			reconcileNoteProperty(
				FM_THEME,
				"default",
				{ [FM_THEME]: "default" },
				{ defaultTheme: "essay", defaultHideBranding: "" }
			)
		).toEqual({ action: "none" });

		// And when the note's stale value disagrees with the page, the clearing
		// value is WRITTEN rather than the property being dropped.
		expect(
			reconcileNoteProperty(
				FM_THEME,
				"default",
				{ [FM_THEME]: "minimal" },
				{ defaultTheme: "essay", defaultHideBranding: "" }
			)
		).toEqual({ action: "write", value: "default" });
	});

	it("WRITES a clearing value even when the note has no property, if a vault default would change the page", () => {
		// Page is at Default, vault default is essay, note has nothing: today's
		// publish would send essay and change the page. Pinning it is the whole
		// point of "make the note agree with the page".
		expect(
			reconcileNoteProperty(FM_THEME, "default", {}, { defaultTheme: "essay", defaultHideBranding: "" })
		).toEqual({ action: "write", value: "default" });
	});

	it("removes safely when the vault default AGREES with the page", () => {
		// Vault default is "default" and the page is at Default: whatever the note
		// says today, dropping the property leaves the publish sending "default"
		// anyway — so removal cannot change the page.
		expect(
			reconcileNoteProperty(
				FM_THEME,
				"default",
				{ [FM_THEME]: "minimal" },
				{ defaultTheme: "default", defaultHideBranding: "" }
			)
		).toEqual({ action: "remove" });
	});
});

// ---- nextPublishValue: the one precedence chain ----

describe("nextPublishValue", () => {
	it("per-note property (incl. explicit false) > vault default > nothing", () => {
		expect(
			nextPublishValue(FM_THEME, { [FM_THEME]: "essay" }, {
				defaultTheme: "minimal",
				defaultHideBranding: "",
			})
		).toBe("essay");

		expect(
			nextPublishValue(FM_HIDE_BRANDING, { [FM_HIDE_BRANDING]: false }, {
				defaultTheme: "",
				defaultHideBranding: "hide",
			})
		).toBe(false); // explicit false must NOT fall through to the default

		expect(
			nextPublishValue(FM_THEME, {}, { defaultTheme: "minimal", defaultHideBranding: "" })
		).toBe("minimal");

		expect(
			nextPublishValue(FM_THEME, {}, { defaultTheme: "", defaultHideBranding: "" })
		).toBeUndefined();
	});
});

describe("reconcileNoteProperty — no redundant writes", () => {
	it("does nothing when the note already holds the page's value", () => {
		// The steady state for a settings-as-code user. Rewriting identical
		// frontmatter would dirty Obsidian Sync and git for no change.
		expect(
			reconcileNoteProperty(FM_THEME, "essay", { [FM_THEME]: "essay" }, {
				defaultTheme: "",
				defaultHideBranding: "",
			})
		).toEqual({ action: "none" });

		expect(
			reconcileNoteProperty(FM_HIDE_BRANDING, true, { [FM_HIDE_BRANDING]: true }, {
				defaultTheme: "",
				defaultHideBranding: "",
			})
		).toEqual({ action: "none" });
	});

	it("does nothing when the note already pins the clearing value a vault default would override", () => {
		expect(
			reconcileNoteProperty(
				FM_HIDE_BRANDING,
				false,
				{ [FM_HIDE_BRANDING]: false },
				{ defaultTheme: "", defaultHideBranding: "hide" }
			)
		).toEqual({ action: "none" });
	});

	it("still writes when the note's value differs from the page's", () => {
		expect(
			reconcileNoteProperty(FM_THEME, "essay", { [FM_THEME]: "minimal" }, {
				defaultTheme: "",
				defaultHideBranding: "",
			})
		).toEqual({ action: "write", value: "essay" });
	});
});
