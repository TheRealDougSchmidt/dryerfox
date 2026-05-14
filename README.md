# DryerFox 3

A silly desktop browser that acts like a web browser inside a clothes dryer. This is a [Tauri](https://tauri.app/) port of the Electron-based `dryerfox2`, which itself was a recreation of the original Adobe AIR `dryerfox`.

The name is a pun on Firefox and a clothes dryer. The app is a chromeless transparent window with a stack of PNG overlays that look like a clothes dryer. The webpage is displayed as if it were inside the dryer drum. While a page is loading, the drum slowly rotates and plays a tumble sound. When the page finishes loading, the rotation stops at a random angle, and the page remains interactive on that weird angle.

## Prerequisites

Tauri needs both a Node toolchain (for the CLI) and a Rust toolchain (for the backend).

1. Install **Node.js** (>= 18).
2. Install **Rust** via [rustup](https://rustup.rs/):
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```
3. On macOS, install Xcode Command Line Tools if you don't already have them:
   ```bash
   xcode-select --install
   ```

See the [Tauri prerequisites docs](https://tauri.app/start/prerequisites/) for Linux and Windows system dependencies.

## Install

```bash
npm install
```

## Run

### Development

```bash
npm run dev
```

The first run compiles the Rust backend and is slow; subsequent runs are fast.

### Production build

```bash
npm run build
```

The bundled app is written under `src-tauri/target/release/bundle/`.

## Project Structure

```
dryerfox3/
├── package.json              # Tauri CLI scripts
├── src/                      # Frontend (served as Tauri's frontendDist)
│   ├── index.html
│   ├── styles.css
│   ├── renderer.js
│   ├── assets/               # Dryer PNGs + tumble sound
│   └── icons/                # Source app icon
└── src-tauri/                # Rust backend + Tauri config
    ├── Cargo.toml
    ├── tauri.conf.json       # Window + bundle config
    ├── build.rs
    ├── capabilities/         # Permission grants for the webview
    ├── icons/                # Bundle icons (generated from the source icon)
    └── src/
        ├── main.rs           # Binary entry point
        └── lib.rs            # Tauri builder
```

## How it works

1. `src-tauri/tauri.conf.json` configures a 800×850 frameless, transparent, non-resizable window. On macOS the transparent window relies on `macOSPrivateApi`.
2. The frontend (`src/`) is loaded as static content by Tauri's webview.
3. `renderer.js` adds the URL bar / control button handlers, drives the spinning animation, and plays the tumble sound during loading.
4. Window dragging uses Tauri's built-in `data-tauri-drag-region` attribute, which is applied to the dryer-lid, dryer-frame, and container — so the lid and frame act as drag handles, while the iframe, URL input, and buttons remain interactive.
5. The Rust backend registers a custom `dryerfox://` URI scheme (see `src-tauri/src/lib.rs`). The frontend rewrites every navigation to that scheme; the handler fetches the real `https://` URL via `reqwest`, strips `X-Frame-Options` / CSP / HSTS headers, and rewrites textual response bodies so absolute `https://` URLs route back through the proxy. For HTML responses the handler also injects a `<base href="dryerfox://final-host/">` tag so relative paths resolve against the *post-redirect* host.

## Controls

- **URL Input** — enter a web address.
- **GO** — press Enter to navigate.
- **Back / Forward** — works only for same-origin pages (cross-origin iframes block history access).
- **Refresh** — reload current page.
- **Stop** — clear the page.
- **Home** — go to `https://google.com`.

## Known limitations

- **Cookies / `localStorage` / login flows.** WKWebView treats custom-scheme origins as opaque, so cookie-backed features (sign-in, personalisation) don't work through the proxy. The page renders, you just can't be "logged in."
- **HTTP-only sites.** The proxy upgrades every request to `https://`. Plain-HTTP hosts will return a fetch error.
- **HTML rewriting is a naive string replace.** `https://` → `dryerfox://` everywhere in textual responses; usually harmless because the same rewrite is applied to header values that need it, but a page that displays a literal `https://...` URL as plain text will show `dryerfox://...` instead.
- **Cross-origin iframes** block JavaScript access to `contentWindow`/`contentDocument`, so Back/Forward and wheel-event forwarding only work for same-origin pages. The native webview still delivers wheel events to the iframe itself.
- **Audio autoplay** may require an initial user interaction before the tumble sound starts.

## Differences vs. dryerfox2 (Electron)

| Concern               | Electron (dryerfox2)                           | Tauri (dryerfox3)                                 |
|-----------------------|------------------------------------------------|---------------------------------------------------|
| Backend runtime       | Node.js (`main.js`)                            | Rust (`src-tauri/src/lib.rs`)                     |
| Window config         | `BrowserWindow({ transparent, frame: false })` | `tauri.conf.json` `windows[]`                     |
| Window drag           | `-webkit-app-region: drag` CSS                 | `data-tauri-drag-region` attribute                |
| Bundle size           | ~150 MB (bundles Chromium)                     | ~5–10 MB (uses OS webview)                        |
| Header stripping      | `session.webRequest.onHeadersReceived`         | Custom `dryerfox://` URI scheme handler in Rust   |

## License

MIT

## Credits

Inspired by the original DryerFox by Doug Schmidt, originally built with Adobe AIR.
