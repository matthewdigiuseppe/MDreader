# MDreader

Personalized reader of .md documents for academics working with AI.

MDreader is a Typora-style markdown reader and editor. Documents look typeset. When you click a block (a paragraph, heading, list, table, equation or code block), it shows its raw markdown so you can edit it in place. Click away and it renders again. There is no split preview pane and no build step, and it has no dependencies.

## Mac app

MDreader also builds as a native macOS app (Apple Silicon and Intel) using [Tauri](https://tauri.app). It adds:

- a real menu bar (File, Edit, View, Window) with the usual ⌘ shortcuts;
- native Open / Save dialogs, saving straight to disk with no permission prompts;
- double-clicking `.md` files in Finder, or *Open With → MDreader*;
- dropping files on the window or the Dock icon;
- math and code highlighting bundled in, so it works fully offline.

**Getting the app.** Every pull request and push to `main` builds a disk image on GitHub Actions: open the run under the repository's *Actions* tab and download **MDreader-macOS** from *Artifacts*. Pushing a tag like `v0.1.0` attaches the `.dmg` to a GitHub release.

**First launch.** The app isn't signed with an Apple Developer ID, so macOS will refuse to open it the first time. Drag it to Applications, then either right-click it and choose **Open**, or run:

```sh
xattr -dr com.apple.quarantine /Applications/MDreader.app
```

**Building it yourself** (needs Node 18+, Rust and Xcode Command Line Tools):

```sh
npm install
npm run mac:dev      # run in development
npm run mac:build    # universal .dmg in src-tauri/target/universal-apple-darwin/release/bundle/dmg/
```

## Running it in a browser

- **Quickest:** open `index.html` in a browser. Everything works from `file://`.
- **Recommended:** serve the folder, for example with `python3 -m http.server`, and visit `http://localhost:8000`. In Chrome or Edge you can then use *Install app* to get a standalone window that opens `.md` files from your file manager. It also works offline after the first visit.
- **Hosted:** enable GitHub Pages for this repository and it runs at `https://<user>.github.io/MDreader/`.

## Features

- **Inline live preview:** each block switches between its rendered form and its markdown source.
- **Live reload:** when another program changes the open file (an AI agent, an R script, `git pull`), MDreader reloads it in place and keeps your scroll position. Changed blocks get a margin bar; click *N changed* in the status bar to step through them. If you have unsaved edits, a banner asks whether to load the new version or keep yours (undo brings yours back). Toggle with the *Live* badge.
- **Bibliographies:** citations like `[@fearon1995, p. 4]` and `@fearon1995` render author–date, "(Fearon 1995, p. 4)" and "Fearon (1995)", with the full reference on hover and a *References* list at the end. Keys missing from your `.bib` are underlined in red and counted in the status bar, which is the fastest way to catch citations an AI made up. MDreader uses the `bibliography:` field in the front matter, else a file chosen with *File → Load bibliography* (⌘⇧B), else any `.bib` next to the document. The `.bib` reloads when Zotero or Better BibTeX re-exports it.
- **Academic markdown:** `$inline$` and `$$display$$` math (KaTeX), pandoc citations `[@key, p. 4]`, footnotes with hover text, booktabs-style tables, YAML front matter, `> [!NOTE]` callouts, task lists, highlights `==x==`, sub/superscript `H~2~O`, `x^2^`.
- **Code blocks** with syntax highlighting (highlight.js) and auto-closed fences.
- **Outline** sidebar that tracks your scroll position, plus a **file browser** for a whole project folder (Chromium browsers). Relative image paths resolve against the opened folder.
- **Reading lock** for reading AI output without editing it by accident; **focus mode** (F8) and **typewriter mode** (F9).
- **Source mode** (Ctrl+/) shows the whole file as plain text.
- **Themes:** Auto, Paper, Sepia and Night; serif, sans or mono type; adjustable size and line width.
- **Files:** open and save in place (File System Access API), with a download fallback in other browsers. You can drag and drop files, and an unsaved draft survives a reload.
- **Export** to standalone HTML, or print to PDF with a clean print stylesheet.

KaTeX and highlight.js load from cdnjs the first time a document needs them. Offline, math shows as TeX source and code is shown without highlighting.

## Keyboard

| Action | Shortcut |
|:--|:--|
| Bold / italic / code / link | Ctrl+B / Ctrl+I / Ctrl+E / Ctrl+K |
| Heading 1–6 / paragraph | Ctrl+1…6 / Ctrl+0 |
| New block / soft line break | Enter / Shift+Enter |
| Leave code or math block | Ctrl+Enter |
| Move between blocks | ↑ ↓ (at the first/last line) |
| Stop editing | Esc |
| Source mode | Ctrl+/ |
| Sidebar | Ctrl+\ |
| Undo / redo across blocks | Ctrl+Z / Ctrl+Shift+Z |
| Open link | Ctrl+click |

## Code layout

```
index.html          app shell
css/styles.css      themes, typography, editor and print styles
js/markdown.js      markdown → HTML engine and block splitter (also runs in Node)
js/editor.js        block editor: click-to-edit, keyboard handling, undo
js/app.js           files, folders, outline, modes, appearance, export
js/welcome.js       first-run document
sw.js, manifest     offline cache and installable-app metadata
src-tauri/          macOS app shell (Rust): menus, file access, Finder integration
scripts/build-web.js  copies the web app + bundled KaTeX/highlight.js into dist/ for the app
tests/              unit tests for the markdown engine: `node --test tests/*.test.js`
```
