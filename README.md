# JotBird for Obsidian

Publish notes from your Obsidian vault to clean, shareable web pages on [JotBird](https://www.jotbird.com). No account required.

## Features

- **One-click publishing** from the ribbon icon, command palette, or file menu
- **Automatic image uploads** — local images in your vault are uploaded and embedded
- **Callouts and Mermaid diagrams** render on the published page
- **Frontmatter tracking** — published URLs and expiration dates are stored in your note's properties
- **Page settings** — control a page's theme, branding, and visibility (including password protection) without leaving Obsidian
- **Works without an account** — links last 30 days. Connect a free account for 90-day links, or upgrade to [Pro](https://www.jotbird.com/pro) for permanent links.

## Installation

1. Open **Settings** > **Community plugins**
2. Click **Browse** and search for **"JotBird"**
3. Click **Install**, then **Enable**

## Usage

Open any note and publish it using one of these methods:

- Click the **JotBird icon** in the left ribbon
- Open the **command palette** and run **"JotBird: Publish current note"**
- **Right-click** a file in the sidebar and select **"Publish to JotBird"**

Republishing the same note updates the existing page — same URL, fresh content.

### Managing documents

Use the command palette to manage your published notes:

- **"JotBird: List published documents"** — view all published notes with links
- **"JotBird: Unpublish current note"** — remove a note from the web
- **"JotBird: Copy JotBird link"** — copy the published URL to clipboard

### Page settings

With a connected account, open the command palette on a published note and run
**"JotBird: Page settings"** (also in the file menu) to change the page's
**theme**, **branding**, and **visibility** — including password protection.
Theme and branding changes apply to the live page immediately, with no
republish. The password is sent once when you save and is never stored in your
vault. Themes, hidden branding, and password protection require
[Pro](https://www.jotbird.com/pro).

For a settings-as-code workflow, two note properties override everything else
on every publish of that note:

```yaml
---
jotbird_theme: essay          # default | minimal | essay | terminal
jotbird_hide_branding: true
---
```

You can also set vault-wide defaults under **Settings** > **JotBird** >
**Published pages** — they ship as "Leave as-is (don't manage)", which sends
nothing and preserves whatever each page already has (so a theme set in the
web app survives republishing from Obsidian). The
**"JotBird: Pull page settings into properties"** command syncs a page's current
settings into the note's properties — adding the settings the page has, and
removing a property the page no longer uses, so the note and the page can't
disagree. The plugin never writes these properties on its own.

### Authentication (optional)

Connect a JotBird account for longer-lasting links:

1. Open **Settings** > **JotBird**
2. Click **Connect to JotBird**
3. Sign in (or create an account) and your API key is sent back to Obsidian automatically

You can also paste an API key manually from your [account page](https://jotbird.com/account/api-key).

## Network usage

This plugin connects to the following services:

- **api.jotbird.com** — to publish, update, list, and delete documents, and to upload images
- **jotbird.com** — to authenticate your account and manage your subscription

No telemetry or analytics data is collected.

## Support

- [JotBird Help](https://www.jotbird.com/help)
- [Report an issue](https://github.com/jotbirdhq/obsidian-jotbird/issues)

## License

[MIT](LICENSE)
