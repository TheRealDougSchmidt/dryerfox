use std::borrow::Cow;
use std::sync::OnceLock;

use regex::Regex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol(
            "dryerfox",
            |_ctx, request, responder| {
                tauri::async_runtime::spawn(async move {
                    let response = proxy_request(request).await;
                    responder.respond(response);
                });
            },
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// On Windows (WebView2), Tauri exposes custom URI scheme handlers via
// `http://<scheme>.localhost/...` rather than the actual `<scheme>://` URL —
// custom schemes aren't natively routable by WebView2 the way they are by
// WKWebView. So on Windows the iframe navigates to
//   http://dryerfox.localhost/<upstream-host>/<upstream-path>
// and we peel the upstream host off the first path segment.
#[cfg(windows)]
const PROXY_HOST: &str = "dryerfox.localhost";

// Headers we never forward to the upstream server.
// `host` is set by reqwest from the target URL.
// `connection` is hop-by-hop and shouldn't be forwarded.
// `referer` and `origin` are handled separately — we rewrite them rather than drop them,
// because many upstreams (Google, CDNs) refuse requests whose referer doesn't match the host.
const REQUEST_HEADER_BLOCKLIST: &[&str] = &[
    "host",
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
    "sec-fetch-user",
    "connection",
];

// Rewrite the proxy-scheme URL in header values back to `https://` so upstreams
// see a plausible-looking origin/referer.
//
// On macOS the scheme is literally `dryerfox://<host>`; on Windows it's
// `http://dryerfox.localhost/<host>`. Either way we want to recover
// `https://<host>` for forwarding upstream.
fn unrewrite_url(value: &str) -> String {
    #[cfg(windows)]
    {
        let needle = "http://dryerfox.localhost/";
        if let Some(pos) = value.find(needle) {
            let mut out = String::with_capacity(value.len());
            out.push_str(&value[..pos]);
            out.push_str("https://");
            out.push_str(&value[pos + needle.len()..]);
            return out;
        }
    }
    value.replace("dryerfox://", "https://")
}

// Headers we strip from the upstream response.
// - X-Frame-Options / CSP — the whole point of the proxy
// - HSTS — irrelevant for a custom scheme and confusing for the webview
// - content-encoding/length/transfer-encoding — reqwest already decoded the body and we may rewrite it
// - access-control-* — upstream values name the upstream origin (https://…); we re-add permissive
//   values below so the webview accepts cross-host subresource loads inside the proxy world
const RESPONSE_HEADER_BLOCKLIST: &[&str] = &[
    "x-frame-options",
    "content-security-policy",
    "content-security-policy-report-only",
    "strict-transport-security",
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-expose-headers",
];

async fn proxy_request(
    request: http::Request<Vec<u8>>,
) -> http::Response<Cow<'static, [u8]>> {
    let uri = request.uri().clone();
    let (host, port, path_and_query) = match parse_proxy_uri(&uri) {
        Some(parts) => parts,
        None => return error_html(400, "dryerfox URL is missing a host"),
    };

    // We default to https for the upstream; modern web is https-first and a
    // server that only speaks plain http will surface as an error page.
    let target_url = format!("https://{}{}{}", host, port, path_and_query);

    // Follow redirects inside reqwest. WKWebView won't follow a 3xx whose Location
    // points at a custom scheme for iframe loads, so we resolve them server-side
    // and use a `<base>` tag in the response to tell the iframe what URL it's "at".
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => return error_html(500, &format!("HTTP client init failed: {}", e)),
    };

    let method = match reqwest::Method::from_bytes(request.method().as_str().as_bytes()) {
        Ok(m) => m,
        Err(_) => return error_html(400, "Invalid HTTP method"),
    };

    // Capture the request origin (e.g. `dryerfox://twitter.com`) so we can echo it
    // back as `Access-Control-Allow-Origin`. Wildcard `*` doesn't work with credentialed
    // XHRs; an exact-origin echo paired with `Access-Control-Allow-Credentials: true` does.
    let request_origin = request
        .headers()
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let mut req_builder = client.request(method, &target_url);

    for (name, value) in request.headers() {
        let lname = name.as_str().to_ascii_lowercase();
        if REQUEST_HEADER_BLOCKLIST.contains(&lname.as_str()) {
            continue;
        }
        if let Ok(v) = value.to_str() {
            let forwarded = if matches!(lname.as_str(), "referer" | "origin") {
                unrewrite_url(v)
            } else {
                v.to_string()
            };
            req_builder = req_builder.header(name.as_str(), forwarded);
        }
    }

    let method_str = request.method().as_str().to_string();
    let (_, body) = request.into_parts();
    if !body.is_empty() {
        req_builder = req_builder.body(body);
    }

    let resp = match req_builder.send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[proxy] FETCH-ERR {} {} -> {}", method_str, target_url, e);
            return error_html(
                502,
                &format!("Failed to fetch {}: {}", target_url, e),
            );
        }
    };

    let status = resp.status().as_u16();
    let resp_headers = resp.headers().clone();
    let final_url = resp.url().clone();
    eprintln!(
        "[proxy] {} {} -> {} {} (final {})",
        method_str,
        target_url,
        status,
        resp_headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("?"),
        final_url
    );
    let content_type = resp_headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let is_html = content_type.contains("text/html");

    let body_bytes = resp.bytes().await.unwrap_or_default().to_vec();

    // Rewrite absolute http(s) URLs anywhere they appear in textual responses
    // (HTML, JS, CSS, JSON, SVG…) so dynamically-constructed sub-requests also
    // route through this proxy. Without rewriting JS, dynamic `img.src = 'https://…'`
    // calls escape the proxy and WKWebView blocks them cross-scheme.
    let final_body = if is_text_response(&content_type) {
        match String::from_utf8(body_bytes) {
            Ok(s) => {
                let final_host = final_url.host_str().unwrap_or(&host);
                let rewritten = rewrite_html(&s, final_host);
                // For HTML, the iframe's URL is whatever the user asked for, but
                // reqwest may have followed redirects to a different host. Inject
                // a <base> so relative URLs resolve against the post-redirect host.
                if is_html {
                    inject_base_tag(&rewritten, &final_url).into_bytes()
                } else {
                    rewritten.into_bytes()
                }
            }
            Err(e) => e.into_bytes(),
        }
    } else {
        body_bytes
    };

    let mut response_builder = http::Response::builder()
        .status(http::StatusCode::from_u16(status).unwrap_or(http::StatusCode::OK))
        // WKWebView treats every dryerfox://<host> as its own origin, so cross-host
        // subresources (twitter.com → abs.twimg.com, etc.) get CORS-checked. Echo the
        // request origin (which is needed for credentialed XHRs) and fall back to `*`
        // only when the request didn't have an Origin header (no credentials in play).
        .header(
            "access-control-allow-origin",
            request_origin.as_deref().unwrap_or("*"),
        )
        .header("access-control-allow-credentials", "true")
        .header("access-control-allow-methods", "*")
        .header("access-control-allow-headers", "*")
        .header("access-control-expose-headers", "*");

    for (name, value) in resp_headers.iter() {
        let lname = name.as_str().to_ascii_lowercase();
        if RESPONSE_HEADER_BLOCKLIST.contains(&lname.as_str()) {
            continue;
        }
        if let Ok(v) = value.to_str() {
            response_builder = response_builder.header(name.as_str(), v);
        }
    }

    response_builder
        .body(Cow::Owned(final_body))
        .unwrap_or_else(|_| empty_response())
}

fn inject_base_tag(html: &str, final_url: &reqwest::Url) -> String {
    let port = final_url
        .port()
        .map(|p| format!(":{}", p))
        .unwrap_or_default();
    let host = final_url.host_str().unwrap_or("");

    // The base href has to match the platform's proxy URL form. On macOS the
    // iframe lives at `dryerfox://<host>/`; on Windows it lives at
    // `http://dryerfox.localhost/<host>/`. Relative URLs in the page resolve
    // against this base, so getting it wrong breaks every relative resource.
    #[cfg(windows)]
    let base_href = format!("http://{}/{}{}/", PROXY_HOST, host, port);
    #[cfg(not(windows))]
    let base_href = format!("dryerfox://{}{}/", host, port);

    // Inject:
    //   1. <base> so relative URLs resolve against the post-redirect host.
    //   2. A tiny script that posts the *final* URL (after any reqwest-followed
    //      redirects) back to the parent. We send the canonical https:// URL
    //      rather than the proxy form so the renderer doesn't need to
    //      reverse-map per platform.
    let js_url = final_url
        .as_str()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let injection = format!(
        r#"<base href="{base_href}"><script>(function(){{var u="{js_url}";try{{window.parent.postMessage("DRYERFOX_URL:"+u,"*");}}catch(e){{}}}})();</script>"#,
        base_href = base_href,
        js_url = js_url
    );

    // Insert right after <head> (case-insensitive). If there's no <head>, prepend.
    let lower = html.to_ascii_lowercase();
    if let Some(idx) = lower.find("<head>") {
        let insertion_point = idx + "<head>".len();
        format!(
            "{}{}{}",
            &html[..insertion_point],
            injection,
            &html[insertion_point..]
        )
    } else if let Some(idx) = lower.find("<head") {
        if let Some(end) = lower[idx..].find('>') {
            let insertion_point = idx + end + 1;
            format!(
                "{}{}{}",
                &html[..insertion_point],
                injection,
                &html[insertion_point..]
            )
        } else {
            format!("{}{}", injection, html)
        }
    } else {
        format!("{}{}", injection, html)
    }
}

fn is_text_response(content_type: &str) -> bool {
    content_type.starts_with("text/")
        || content_type.contains("javascript")
        || content_type.contains("json")
        || content_type.contains("xml")
        || content_type.contains("svg")
}

// Parse the incoming proxy request URI into (upstream_host, port, path_and_query).
// On macOS the URI is `dryerfox://<host>[:port]/<path>` and we can use the URI
// host/path directly. On Windows the URI is `http://dryerfox.localhost/<host>/<path>`
// (Tauri's WebView2 workaround), so the upstream host is the first path segment.
fn parse_proxy_uri(uri: &http::Uri) -> Option<(String, String, String)> {
    #[cfg(windows)]
    {
        let path = uri.path();
        let trimmed = path.trim_start_matches('/');
        if trimmed.is_empty() {
            return None;
        }
        let (host, rest) = match trimmed.find('/') {
            Some(idx) => (&trimmed[..idx], &trimmed[idx..]),
            None => (trimmed, "/"),
        };
        if host.is_empty() {
            return None;
        }
        let query = uri.query().map(|q| format!("?{}", q)).unwrap_or_default();
        // We always speak to upstreams on the default https port; if the user
        // wants a non-default port they can encode it in the host segment
        // itself (e.g. `localhost:8080`) since `:` is valid in a URL path.
        Some((host.to_string(), String::new(), format!("{}{}", rest, query)))
    }
    #[cfg(not(windows))]
    {
        let host = uri.host().filter(|h| !h.is_empty())?.to_string();
        let port = uri
            .port_u16()
            .map(|p| format!(":{}", p))
            .unwrap_or_default();
        let path_and_query = uri
            .path_and_query()
            .map(|p| p.as_str().to_string())
            .unwrap_or_else(|| "/".to_string());
        Some((host, port, path_and_query))
    }
}

// Crude but effective for a silly play app: rewrite every absolute
// http(s):// URL we find in textual responses to its proxied equivalent so
// dynamically-constructed sub-requests also route through us. On Windows we
// additionally rewrite protocol-relative (`//cdn.example.com/…`) and
// root-relative (`/foo`) URLs in common attributes — those are naturally
// host-scoped on macOS where every upstream gets its own custom-scheme
// "origin", but on Windows every request shares `dryerfox.localhost` so we
// have to splice the host back into the path ourselves.
#[allow(unused_variables)]
fn rewrite_html(html: &str, upstream_host: &str) -> String {
    static ABS_URL: OnceLock<Regex> = OnceLock::new();
    let abs = ABS_URL.get_or_init(|| Regex::new(r"https?://").unwrap());

    #[cfg(windows)]
    {
        let replacement = format!("http://{}/", PROXY_HOST);
        let s = abs.replace_all(html, replacement.as_str()).into_owned();
        rewrite_relative_urls_for_windows(&s, upstream_host)
    }
    #[cfg(not(windows))]
    {
        abs.replace_all(html, "dryerfox://").into_owned()
    }
}

#[cfg(windows)]
fn rewrite_relative_urls_for_windows(html: &str, upstream_host: &str) -> String {
    static ROOT_REL_ATTR: OnceLock<Regex> = OnceLock::new();
    static PROTO_REL: OnceLock<Regex> = OnceLock::new();

    // Match `attr="/X...` or `attr='/X...` where X is any non-slash byte (so
    // we don't mangle protocol-relative `//cdn.example.com/...`, which is
    // handled in the next pass). The Rust regex engine doesn't support
    // look-around, so we capture the byte after the slash and put it back in
    // the replacement.
    let root_rel = ROOT_REL_ATTR.get_or_init(|| {
        Regex::new(
            r#"(?i)\b(href|src|action|formaction|poster|cite|data|background|manifest|usemap|srcset)(\s*=\s*)(["'])/([^/])"#,
        )
        .unwrap()
    });
    let with_root = root_rel
        .replace_all(
            html,
            format!("$1$2$3/{}/$4", upstream_host).as_str(),
        )
        .into_owned();

    // Protocol-relative: `//example.com/foo` → `http://dryerfox.localhost/example.com/foo`.
    // We look for `//` preceded by a quote, paren, whitespace, `=`, or `,` so
    // we don't mangle things like comment terminators (`*/`) or doubled
    // slashes inside strings.
    let proto_rel = PROTO_REL.get_or_init(|| {
        Regex::new(r#"(?i)([=\s"'(,])//([a-z0-9][a-z0-9.\-]*\.[a-z]{2,})"#).unwrap()
    });
    proto_rel
        .replace_all(
            &with_root,
            format!("$1http://{}/$2", PROXY_HOST).as_str(),
        )
        .into_owned()
}

fn error_html(status: u16, msg: &str) -> http::Response<Cow<'static, [u8]>> {
    let escaped = msg.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let body = format!(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>{status}</title>\
         <style>body{{font-family:sans-serif;padding:24px;background:#f5f5f5}}\
         h1{{color:#d32f2f}}</style></head><body>\
         <h1>Proxy error {status}</h1><p>{escaped}</p></body></html>",
        status = status,
        escaped = escaped
    );
    http::Response::builder()
        .status(status)
        .header("content-type", "text/html; charset=utf-8")
        .body(Cow::Owned(body.into_bytes()))
        .unwrap()
}

fn empty_response() -> http::Response<Cow<'static, [u8]>> {
    http::Response::builder()
        .status(500)
        .body(Cow::Owned(Vec::new()))
        .unwrap()
}
