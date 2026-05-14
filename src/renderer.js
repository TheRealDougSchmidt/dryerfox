// DryerFox renderer (Tauri version)
class DryerFox {
    constructor() {
        this.webFrame = document.getElementById('web-frame');
        this.webContainer = document.getElementById('web-container');
        this.urlInput = document.getElementById('url-input');
        this.dryerSound = document.getElementById('dryer-sound');

        this.isLoading = false;
        this.currentRotation = 0;

        this.init();
    }

    init() {
        this.setupEventListeners();
        this.setupIframeEvents();
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
            this.navigateTo('https://example.com');
        });

        document.getElementById('refresh-button').addEventListener('click', () => {
            this.refreshPage();
        });

        document.getElementById('stop-button').addEventListener('click', () => {
            this.stopLoading();
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
        // URL bar after redirects or in-iframe navigation.
        window.addEventListener('message', (event) => {
            if (typeof event.data !== 'string' || !event.data.startsWith('DRYERFOX_URL:')) return;
            const url = event.data.slice('DRYERFOX_URL:'.length);
            if (!url.startsWith('dryerfox://')) return;
            this.urlInput.value = url.replace(/^dryerfox:\/\//, 'https://');
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

        // Route through the dryerfox:// scheme so the Rust handler can strip
        // X-Frame-Options / CSP before the webview tries to render the page.
        const proxyUrl = url.replace(/^https?:\/\//, 'dryerfox://');

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
