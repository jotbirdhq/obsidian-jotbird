// Test environment shim.
//
// Obsidian plugins must use `window.*` timers rather than the bare globals —
// the community lint enforces it (obsidianmd/prefer-window-timers) because
// plugins also run inside popout windows. Vitest, however, runs these tests in
// a plain Node environment where `window` does not exist, so any code path that
// touches window.setTimeout / window.setInterval would throw a ReferenceError.
//
// That matters more than it looks: those throws land inside try/catch blocks
// (publishFile wraps its whole body), so they are SWALLOWED — a test would go
// green while the timer code never ran at all. Shim the handful of window APIs
// the plugin uses onto globalThis so the real code paths actually execute.

const g = globalThis as unknown as Record<string, unknown>;

if (typeof g.window === "undefined") {
	g.window = globalThis;
}

// addPropertyIcons() queries the active document for the properties panel.
// There is no DOM here; an empty result is the honest answer.
if (typeof g.activeDocument === "undefined") {
	g.activeDocument = {
		querySelectorAll: () => [] as unknown[],
		createElement: () => ({
			classList: { add: () => undefined },
			createEl: () => ({ title: "", onclick: null }),
			prepend: () => undefined,
		}),
	};
}
