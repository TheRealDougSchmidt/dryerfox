// DryerFox renderer (Tauri version)

// WKWebView (macOS) routes the actual `dryerfox://` custom scheme to our Rust
// handler, so on macOS we use that directly. WebView2 (Windows) has no native
// custom-scheme routing for arbitrary schemes — Tauri exposes the protocol via
// `http://<scheme>.localhost/...` instead. We encode the upstream host as the
// first path segment so the Rust side can recover it.
const IS_WINDOWS = typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent);
function toProxyUrl(httpsUrl) {
    if (IS_WINDOWS) {
        return httpsUrl.replace(/^https?:\/\//i, 'http://dryerfox.localhost/');
    }
    return httpsUrl.replace(/^https?:\/\//i, 'dryerfox://');
}

// Native (at min-size) layout constants. The minimum window is 800x850.
// Everything below describes the dryer at its original 1:1 scale.
const LEFT_MARGIN = 50;       // transparent gap to the left of the lid/frame
const RIGHT_MARGIN = 33;      // transparent gap to the right of the lid/frame
const FRAME_TOP = 193;        // y-offset where the frame image starts (under the lid)
const BOTTOM_MARGIN = 7;      // transparent gap below the frame
const LID_HEIGHT = 210;       // lid is fixed-height (never stretches vertically)

const LID_NATIVE_WIDTH = 717;
const FRAME_NATIVE_WIDTH = 717;
const FRAME_NATIVE_HEIGHT = 650;
const DRUM_NATIVE_SIZE = 495;     // drum is square at native scale
const IFRAME_NATIVE_SIZE = 480;   // iframe is square inside the drum
const DRUM_LEFT_IN_FRAME = 98;    // drum's top-left offset within the frame
const DRUM_TOP_IN_FRAME = 75;
const IFRAME_LEFT_IN_DRUM = 10;
const IFRAME_TOP_IN_DRUM = 10;

// Lid image: two narrow vertical bands repeat to fill extra horizontal space.
const LID_LEFT_FIXED = 120;        // [0, 120] is the fixed left section
const LID_BAND_A_START = 120;
const LID_BAND_A_END = 146;
const LID_BAND_B_START = 613;
const LID_BAND_B_END = 630;
const LID_RIGHT_FIXED = 87;        // [630, 717] is the fixed right section (717-630)
const LID_MIDDLE_FIXED = LID_BAND_B_START - LID_BAND_A_END; // 467

// URL bar — left edge anchored to a fixed offset from the lid's left edge;
// right edge anchored 38px from the right of the lid. The input stretches as
// the lid grows wider.
const URL_BAR_LEFT_OFFSET = 200;            // distance from lid left
const URL_BAR_RIGHT_FROM_LID_RIGHT = 38;    // distance from lid right
const URL_BAR_TOP = 177;

// Right-anchored top buttons (minimize, level): their left edge is 127px from lid right.
const RIGHT_BUTTON_FROM_LID_RIGHT = 127;
const MINIMIZE_BUTTON_TOP = 22;
const LEVEL_BUTTON_TOP = 78;

// Left-anchored top button (close): fixed position relative to the container's left edge.
const CLOSE_BUTTON_LEFT = 170;
const CLOSE_BUTTON_TOP = 50;

// Grab handle, expressed in the dryer_frame_med.png image's native pixel coords.
const HANDLE_LEFT = 682, HANDLE_TOP = 618;
const HANDLE_RIGHT = 706, HANDLE_BOTTOM = 641;

class DryerFox {
    constructor() {
        this.webFrame = document.getElementById('web-frame');
        this.webContainer = document.getElementById('web-container');
        this.urlInput = document.getElementById('url-input');
        this.dryerSound = document.getElementById('dryer-sound');
        this.lidCanvas = document.getElementById('lid-canvas');

        this.isLoading = false;
        this.currentRotation = 0;

        // Preload the lid image so we can composite it onto the canvas.
        this.lidImage = new Image();
        this.lidImageReady = false;
        this.lidImage.addEventListener('load', () => {
            this.lidImageReady = true;
            this.updateLayout();
        });
        this.lidImage.src = 'assets/dryer_lid_med.png';

        this.init();
    }

    init() {
        this.setupEventListeners();
        this.setupIframeEvents();
        this.setupResizeHandle();
        window.addEventListener('resize', () => this.updateLayout());
        this.updateLayout();
        this.navigateTo(this.urlInput.value);
    }

    setupEventListeners() {
        document.getElementById('back-button').addEventListener('click', () => {
            try { this.webFrame.contentWindow.history.back(); } catch {}
        });

        document.getElementById('forward-button').addEventListener('click', () => {
            try { this.webFrame.contentWindow.history.forward(); } catch {}
        });

        document.getElementById('home-button').addEventListener('click', () => {
            this.navigateTo('https://google.com');
        });

        document.getElementById('refresh-button').addEventListener('click', () => {
            this.refreshPage();
        });

        document.getElementById('stop-button').addEventListener('click', () => {
            this.stopLoading();
        });

        document.getElementById('minimize-button').addEventListener('click', () => {
            this.minimizeWindow();
        });

        document.getElementById('level-button').addEventListener('click', () => {
            this.levelDrum();
        });

        document.getElementById('close-button').addEventListener('click', () => {
            try {
                window.__TAURI__.window.getCurrentWindow().close();
            } catch (err) {
                console.error('Failed to close window:', err);
            }
        });

        this.urlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.navigateTo(this.urlInput.value);
            }
        });

        document.querySelectorAll('button, input').forEach(element => {
            element.addEventListener('dragstart', (e) => e.preventDefault());
        });
    }

    setupIframeEvents() {
        this.webFrame.addEventListener('load', () => {
            this.onPageLoadComplete();
        });

        this.webFrame.addEventListener('error', () => {
            this.handleLoadError();
        });

        // The proxied page posts its post-redirect URL back so we can update the
        // URL bar after redirects or in-iframe navigation. The proxy sends the
        // canonical https:// URL so we don't need to reverse-map per platform.
        window.addEventListener('message', (event) => {
            if (typeof event.data !== 'string' || !event.data.startsWith('DRYERFOX_URL:')) return;
            const url = event.data.slice('DRYERFOX_URL:'.length);
            if (!/^https?:\/\//i.test(url)) return;
            this.urlInput.value = url;
        });

        this.setupRotatedIframeInteraction();
    }

    handleLoadError() {
        console.log('Failed to load page in iframe');
        this.showError('This website cannot be loaded in DryerFox due to security restrictions. Try a different URL.');
    }

    setupRotatedIframeInteraction() {
        this.webFrame.style.pointerEvents = 'auto';
        this.webContainer.style.pointerEvents = 'auto';

        this.webContainer.addEventListener('click', () => {
            this.webFrame.focus();
        });

        this.webContainer.addEventListener('mouseenter', () => {
            this.webContainer.style.cursor = 'pointer';
        });

        this.webContainer.addEventListener('mouseleave', () => {
            this.webContainer.style.cursor = 'default';
        });

        // Wheel events: the webview routes them to the iframe natively once the
        // cursor is over the iframe area. Manually dispatching them required
        // reaching into iframe.contentDocument, which is cross-origin to the
        // host (parent runs on http://127.0.0.1, iframe on dryerfox://) and
        // logged a SecurityError every wheel tick.
    }

    navigateTo(url) {
        if (!url) return;

        if (!url.match(/^https?:\/\//)) {
            url = 'https://' + url;
        }

        this.urlInput.value = url;
        this.startLoading();

        // Route through the proxy so the Rust handler can strip X-Frame-Options /
        // CSP before the webview tries to render the page.
        const proxyUrl = toProxyUrl(url);

        try {
            this.webFrame.src = proxyUrl;
        } catch (error) {
            console.error('Navigation error:', error);
            this.showError('Failed to load page');
        }
    }

    refreshPage() {
        this.startLoading();
        this.webFrame.src = this.webFrame.src;
    }

    stopLoading() {
        this.webFrame.src = 'about:blank';
        this.onPageLoadComplete();
    }

    startLoading() {
        if (this.isLoading) return;

        this.isLoading = true;
        this.webContainer.classList.add('spinning', 'loading');
        this.playDryerSound();
    }

    minimizeWindow() {
        try {
            window.__TAURI__.window.getCurrentWindow().minimize();
        } catch (err) {
            console.error('Failed to minimize window:', err);
        }
    }

    levelDrum() {
        this.currentRotation = 0;
        this.webContainer.style.transform = `rotate(0deg)`;
        this.updateInteractionOverlay();
    }

    setupResizeHandle() {
        // We resize manually rather than via Tauri's startResizeDragging because
        // macOS frameless + transparent windows (using macOSPrivateApi) ignore the
        // native resize gesture: it relies on a "currently held" mouse event that
        // is no longer current by the time the async IPC call reaches the runtime.
        // Tracking pointermove + calling setSize each frame works regardless.
        const handle = document.getElementById('resize-handle');
        let dragging = false;
        let startMouseX = 0, startMouseY = 0;
        let startInnerW = 0, startInnerH = 0;

        handle.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            handle.setPointerCapture(e.pointerId);
            startMouseX = e.screenX;
            startMouseY = e.screenY;
            startInnerW = window.innerWidth;
            startInnerH = window.innerHeight;
            dragging = true;
        });

        handle.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const dx = e.screenX - startMouseX;
            const dy = e.screenY - startMouseY;
            const newW = Math.max(800, startInnerW + dx);
            const newH = Math.max(850, startInnerH + dy);
            try {
                const tauri = window.__TAURI__.window;
                tauri.getCurrentWindow().setSize(new tauri.LogicalSize(newW, newH));
            } catch (err) {
                console.error('setSize failed:', err);
            }
        });

        const endDrag = (e) => {
            if (dragging && e.pointerId !== undefined) {
                try { handle.releasePointerCapture(e.pointerId); } catch {}
            }
            dragging = false;
        };
        handle.addEventListener('pointerup', endDrag);
        handle.addEventListener('pointercancel', endDrag);
    }

    // Compute the current frame size (aspect-ratio preserved) given the window,
    // then position every layout-dependent element. Called on init, on the lid
    // image loading, and on every window resize event.
    updateLayout() {
        const W = window.innerWidth;
        const H = window.innerHeight;

        // Frame size: maintain native aspect ratio inside the available area.
        const aspect = FRAME_NATIVE_WIDTH / FRAME_NATIVE_HEIGHT;
        const maxFrameW = Math.max(1, W - LEFT_MARGIN - RIGHT_MARGIN);
        const maxFrameH = Math.max(1, H - FRAME_TOP - BOTTOM_MARGIN);
        let frameW = maxFrameW;
        let frameH = frameW / aspect;
        if (frameH > maxFrameH) {
            frameH = maxFrameH;
            frameW = frameH * aspect;
        }
        const scale = frameW / FRAME_NATIVE_WIDTH;
        const lidW = frameW;
        const lidLeft = LEFT_MARGIN;

        // Lid (canvas-driven so the two narrow bands can repeat-tile horizontally).
        const dryerLid = document.getElementById('dryer-lid');
        dryerLid.style.left = lidLeft + 'px';
        dryerLid.style.width = lidW + 'px';
        dryerLid.style.height = LID_HEIGHT + 'px';

        // Frame.
        const dryerFrame = document.getElementById('dryer-frame');
        dryerFrame.style.left = LEFT_MARGIN + 'px';
        dryerFrame.style.top = FRAME_TOP + 'px';
        dryerFrame.style.width = frameW + 'px';
        dryerFrame.style.height = frameH + 'px';

        // Drum: scales with the frame, positioned at the same relative offset.
        const drumSize = DRUM_NATIVE_SIZE * scale;
        const drumLeft = LEFT_MARGIN + DRUM_LEFT_IN_FRAME * scale;
        const drumTop = FRAME_TOP + DRUM_TOP_IN_FRAME * scale;
        const dryerDrum = document.getElementById('dryer-drum');
        dryerDrum.style.left = drumLeft + 'px';
        dryerDrum.style.top = drumTop + 'px';
        dryerDrum.style.width = drumSize + 'px';
        dryerDrum.style.height = drumSize + 'px';

        // Iframe (web container): scales with the drum.
        const iframeSize = IFRAME_NATIVE_SIZE * scale;
        const iframeLeft = drumLeft + IFRAME_LEFT_IN_DRUM * scale;
        const iframeTop = drumTop + IFRAME_TOP_IN_DRUM * scale;
        this.webContainer.style.left = iframeLeft + 'px';
        this.webContainer.style.top = iframeTop + 'px';
        this.webContainer.style.width = iframeSize + 'px';
        this.webContainer.style.height = iframeSize + 'px';

        // URL bar — left edge anchored to a fixed offset within the lid,
        // right edge anchored 38px from the lid's right; width = remainder.
        const urlBar = document.getElementById('url-bar');
        const urlBarLeft = lidLeft + URL_BAR_LEFT_OFFSET;
        const urlBarRight = lidLeft + lidW - URL_BAR_RIGHT_FROM_LID_RIGHT;
        urlBar.style.left = urlBarLeft + 'px';
        urlBar.style.top = URL_BAR_TOP + 'px';
        urlBar.style.width = (urlBarRight - urlBarLeft) + 'px';

        // Left-anchored close button.
        const closeBtn = document.getElementById('close-button');
        closeBtn.style.left = CLOSE_BUTTON_LEFT + 'px';
        closeBtn.style.top = CLOSE_BUTTON_TOP + 'px';

        // Right-anchored minimize / level buttons.
        const rightBtnLeft = lidLeft + lidW - RIGHT_BUTTON_FROM_LID_RIGHT;
        const minBtn = document.getElementById('minimize-button');
        minBtn.style.left = rightBtnLeft + 'px';
        minBtn.style.top = MINIMIZE_BUTTON_TOP + 'px';
        const levelBtn = document.getElementById('level-button');
        levelBtn.style.left = rightBtnLeft + 'px';
        levelBtn.style.top = LEVEL_BUTTON_TOP + 'px';

        // Resize grab handle, positioned at the lower-right of the scaled frame.
        const handle = document.getElementById('resize-handle');
        handle.style.left = (LEFT_MARGIN + HANDLE_LEFT * scale) + 'px';
        handle.style.top = (FRAME_TOP + HANDLE_TOP * scale) + 'px';
        handle.style.width = ((HANDLE_RIGHT - HANDLE_LEFT) * scale) + 'px';
        handle.style.height = ((HANDLE_BOTTOM - HANDLE_TOP) * scale) + 'px';

        if (this.lidImageReady) {
            this.drawLid(lidW);
        }
    }

    // Composite the lid image into the canvas, with the two narrow bands (A and B)
    // repeated horizontally to fill the requested width. Extra width is split
    // evenly between the two band regions.
    drawLid(targetWidth) {
        const canvas = this.lidCanvas;
        canvas.width = targetWidth;
        canvas.height = LID_HEIGHT;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, targetWidth, LID_HEIGHT);

        const img = this.lidImage;
        const bandAWidth = LID_BAND_A_END - LID_BAND_A_START;
        const bandBWidth = LID_BAND_B_END - LID_BAND_B_START;
        const extra = Math.max(0, targetWidth - LID_NATIVE_WIDTH);
        const tiledA = bandAWidth + extra / 2;
        const tiledB = bandBWidth + extra / 2;

        let dstX = 0;

        // Left fixed section [0, 120]
        ctx.drawImage(img, 0, 0, LID_LEFT_FIXED, LID_HEIGHT, dstX, 0, LID_LEFT_FIXED, LID_HEIGHT);
        dstX += LID_LEFT_FIXED;

        // Tiled band A
        this.drawTileX(ctx, img, LID_BAND_A_START, bandAWidth, dstX, tiledA);
        dstX += tiledA;

        // Middle fixed section [146, 613]
        ctx.drawImage(img, LID_BAND_A_END, 0, LID_MIDDLE_FIXED, LID_HEIGHT,
                      dstX, 0, LID_MIDDLE_FIXED, LID_HEIGHT);
        dstX += LID_MIDDLE_FIXED;

        // Tiled band B
        this.drawTileX(ctx, img, LID_BAND_B_START, bandBWidth, dstX, tiledB);
        dstX += tiledB;

        // Right fixed section [630, 717]
        ctx.drawImage(img, LID_BAND_B_END, 0, LID_RIGHT_FIXED, LID_HEIGHT,
                      dstX, 0, LID_RIGHT_FIXED, LID_HEIGHT);
    }

    drawTileX(ctx, img, srcX, srcW, dstX, dstW) {
        let drawn = 0;
        while (drawn < dstW) {
            const slice = Math.min(srcW, dstW - drawn);
            ctx.drawImage(img, srcX, 0, slice, LID_HEIGHT,
                          dstX + drawn, 0, slice, LID_HEIGHT);
            drawn += slice;
        }
    }

    onPageLoadComplete() {
        this.isLoading = false;
        this.webContainer.classList.remove('spinning', 'loading');
        this.stopDryerSound();
        this.setRandomRotation();
    }

    setRandomRotation() {
        const randomAngle = Math.floor(Math.random() * 360);
        this.currentRotation = randomAngle;
        this.webContainer.style.transform = `rotate(${randomAngle}deg)`;
        this.updateInteractionOverlay();
    }

    updateInteractionOverlay() {
        const rotationIndicator = document.getElementById('rotation-indicator');
        if (rotationIndicator) {
            rotationIndicator.textContent = `Rotated ${this.currentRotation}°`;
        }
    }

    playDryerSound() {
        try {
            this.dryerSound.currentTime = 0;
            this.dryerSound.play().catch(error => {
                console.log('Audio play failed (user interaction required):', error);
            });
        } catch (error) {
            console.log('Audio not available:', error);
        }
    }

    stopDryerSound() {
        try {
            this.dryerSound.currentTime = 39;
            this.dryerSound.loop = false;

            if (this.dryerSound.paused) {
                this.dryerSound.play().catch(error => {
                    console.log('Audio play from 39s failed:', error);
                });
            }

            const handleEnded = () => {
                this.dryerSound.removeEventListener('ended', handleEnded);
                this.dryerSound.loop = true;
                this.dryerSound.currentTime = 0;
            };

            this.dryerSound.addEventListener('ended', handleEnded);
        } catch (error) {
            console.log('Audio stop/cue failed:', error);
        }
    }

    showError(message) {
        const errorHtml = `
            <html>
                <head>
                    <style>
                        body {
                            font-family: Arial, sans-serif;
                            background: #f5f5f5;
                            margin: 0;
                            padding: 20px;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            min-height: 100vh;
                        }
                        .error-container {
                            background: white;
                            padding: 30px;
                            border-radius: 10px;
                            box-shadow: 0 4px 20px rgba(0,0,0,0.1);
                            max-width: 400px;
                            text-align: center;
                        }
                        h2 { color: #d32f2f; margin-top: 0; }
                        a { color: #1976d2; text-decoration: none; }
                        a:hover { text-decoration: underline; }
                        ul { text-align: left; }
                        .retry-btn {
                            background: #1976d2;
                            color: white;
                            border: none;
                            padding: 10px 20px;
                            border-radius: 5px;
                            cursor: pointer;
                            margin-top: 15px;
                        }
                        .retry-btn:hover { background: #1565c0; }
                    </style>
                </head>
                <body>
                    <div class="error-container">
                        ${message}
                        <button class="retry-btn" onclick="window.parent.location.reload()">Try Again</button>
                    </div>
                </body>
            </html>
        `;
        this.webFrame.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(errorHtml);
        this.onPageLoadComplete();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new DryerFox();
});

// Keyboard shortcuts for quitting — the window is frameless so there's no close button.
document.addEventListener('keydown', (e) => {
    const cmdOrCtrl = e.metaKey || e.ctrlKey;
    const quit = (cmdOrCtrl && (e.key === 'q' || e.key === 'Q' || e.key === 'w' || e.key === 'W'))
        || e.key === 'Escape';
    if (!quit) return;
    e.preventDefault();
    try {
        window.__TAURI__.window.getCurrentWindow().close();
    } catch (err) {
        console.error('Failed to close window:', err);
    }
});
