// Page-settings resolution for the publish payload — and the single source of
// truth for "what will publishing this note actually do to the page?"
//
// Settings travel two ways (docs/OBSIDIAN_PAGE_SETTINGS.md in the main repo):
//  - theme / hideBranding ride the publish payload; an OMITTED setting is
//    PRESERVED server-side, an explicit value wins. This module decides what
//    (if anything) to send.
//  - visibility / password go through the settings API only (PageSettingsModal)
//    — never the publish path, which shares nothing with its rate limits.
//
// Client resolution order, stated rather than implied:
//   per-note frontmatter (including an explicit `false`) > vault default > omitted.
// An explicit `false`/"default" MUST be sent (it clears the setting, allowed for
// any account), while an absent key sends nothing and preserves — so never
// collapse `false` and `undefined` into one falsy check here.
//
// ⚠️ Every caller that needs to reason about the publish payload MUST go through
// `nextPublishValue` / `reconcileNoteProperty` below rather than re-deriving the
// precedence chain. Two places used to do that independently (the modal's
// per-note exception and the pull command) and they disagreed — the pull command
// forgot vault defaults, so "syncing" a note could silently change its page.

import type { JotBirdSettings, PagePublishSettings } from "./types";

/** Frontmatter property carrying a per-note theme override. User-authored,
 * read-only: the plugin never writes it implicitly (only the explicit
 * "pull settings" command and the modal's per-note exception do). */
export const FM_THEME = "jotbird_theme";
/** Frontmatter property carrying a per-note branding override. Same contract. */
export const FM_HIDE_BRANDING = "jotbird_hide_branding";

export type SettingProperty = typeof FM_THEME | typeof FM_HIDE_BRANDING;

type VaultDefaults = Pick<JotBirdSettings, "defaultTheme" | "defaultHideBranding">;

/**
 * The value a page has when the setting is NOT in effect. Sending this clears
 * the setting (allowed for any account); omitting it preserves whatever the
 * page has.
 */
const PAGE_DEFAULT: Record<SettingProperty, unknown> = {
	[FM_THEME]: "default",
	[FM_HIDE_BRANDING]: false,
};

/**
 * A note's explicit override for `key`, or undefined when there isn't one.
 *
 * A null/empty property (one the user created but left blank) counts as ABSENT,
 * so it falls through to the vault default instead of producing an
 * invalid_value warning on every publish while they are still typing. An
 * explicit `false` is NOT absent — it clears the setting.
 */
export function notePropertyValue(
	frontmatter: Record<string, unknown> | undefined,
	key: SettingProperty
): unknown {
	const value = frontmatter?.[key];
	if (value === undefined || value === null || value === "") return undefined;
	return value;
}

/** The vault-wide default for `key`, or undefined when it's "Leave as-is". */
export function vaultDefaultValue(
	key: SettingProperty,
	settings: VaultDefaults
): unknown {
	if (key === FM_THEME) {
		return settings.defaultTheme === "" ? undefined : settings.defaultTheme;
	}
	return settings.defaultHideBranding === ""
		? undefined
		: settings.defaultHideBranding === "hide";
}

/**
 * What the next publish of this note will SEND for `key` — undefined meaning
 * "nothing", which the server treats as "preserve whatever the page has".
 *
 * This is the one place the precedence chain lives. `??` (not `||`) so an
 * explicit `false` wins over a vault default instead of falling through it.
 */
export function nextPublishValue(
	key: SettingProperty,
	frontmatter: Record<string, unknown> | undefined,
	settings: VaultDefaults
): unknown {
	return notePropertyValue(frontmatter, key) ?? vaultDefaultValue(key, settings);
}

export type PropertyAction =
	| { action: "write"; value: unknown }
	| { action: "remove" }
	| { action: "none" };

/**
 * Decide how a note's settings property must change so the note agrees with the
 * page — i.e. so that republishing this note LEAVES `pageValue` in place. Used
 * by the "pull page settings into properties" command.
 *
 * The subtlety that makes this worth centralizing: **removing a property is not
 * the same as having none**, because a vault-wide default rushes in behind it.
 * If the page is at its default and the user has a vault default of "hide",
 * deleting `jotbird_hide_branding: false` would hand the next publish to the
 * default and hide the branding on a page the user never touched. In that case
 * the note must carry the explicit clearing value instead.
 */
export function reconcileNoteProperty(
	key: SettingProperty,
	pageValue: unknown,
	frontmatter: Record<string, unknown> | undefined,
	settings: VaultDefaults
): PropertyAction {
	const noteValue = notePropertyValue(frontmatter, key);

	// A setting the page actually HAS is materialized — that is what the pull
	// command is for, and it also pins the value against any vault default. But
	// only when it would actually CHANGE something: rewriting a property that
	// already holds this value would touch the file for nothing, dirtying
	// Obsidian Sync and producing a spurious git diff on every pull.
	if (pageValue !== PAGE_DEFAULT[key]) {
		return noteValue === pageValue
			? { action: "none" }
			: { action: "write", value: pageValue };
	}

	// The page is at its default. An explicit clearing value is needed only when
	// a vault default would otherwise override it on the next publish.
	const vaultDefault = vaultDefaultValue(key, settings);
	if (vaultDefault !== undefined && vaultDefault !== pageValue) {
		return noteValue === pageValue
			? { action: "none" }
			: { action: "write", value: pageValue };
	}

	// No default would take over, so the property is simply stale. Drop it if the
	// note has one; otherwise there is nothing to do.
	return noteValue !== undefined ? { action: "remove" } : { action: "none" };
}

/**
 * Resolve the page settings (if any) to send with a publish.
 *
 * Frontmatter values are forwarded VERBATIM — no local validation or Pro
 * pre-check. The server is the only authority on whether a setting applies
 * (the cached isPro can be stale), and it reports anything it dropped in the
 * publish response's `warnings`, which the caller surfaces as Notices.
 *
 * Reading deliberately does NOT depend on the storeFrontmatter setting — that
 * toggle governs the plugin WRITING receipts into notes; a user who turned it
 * off still expects a jotbird_theme they typed to be honored.
 */
export function resolvePagePublishSettings(
	frontmatter: Record<string, unknown> | undefined,
	settings: VaultDefaults
): PagePublishSettings | undefined {
	const out: PagePublishSettings = {};

	const theme = nextPublishValue(FM_THEME, frontmatter, settings);
	if (theme !== undefined) out.theme = theme;

	const hideBranding = nextPublishValue(FM_HIDE_BRANDING, frontmatter, settings);
	if (hideBranding !== undefined) out.hideBranding = hideBranding;

	return Object.keys(out).length > 0 ? out : undefined;
}
