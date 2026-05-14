use std::borrow::Cow;

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

// Rewrite the `dryerfox://` scheme back to `https://` in header values so upstreams
// see a plausible-looking origin/referer.
fn unrewrite_url(value: &str) -> String {
    value.replace("dryerfox://", "https://")
}

// Headers we strip from the upstream response.
// - X-Frame-Options / CSP — the whole point of the proxy
// - HSTS — irrelevant for a custom scheme and confusing for the webview
// - content-encoding/length/transfer-encoding — reqwest already decoded the body and we may rewrite it
const RESPONSE_HEADER_BLOCKLIST: &[&str] = &[
    "x-frame-options",
    "content-security-policy",
    "content-security-policy-report-only",
    "strict-transport-security",
    "content-encoding",
    "content-length",
    "transfer-encoding",
];

async fn proxy_request(
    request: http::Request<Vec<u8>>,
) -> http::Response<Cow<'static, [u8]>> {
    let uri = request.uri().clone();
    let host = match uri.host() {
        Some(h) if !h.is_empty() => h.to_string(),
        _ => return error_html(400, "dryerfox:// URL is missing a host"),
    };
    let port = uri
        .port_u16()
        .map(|p| format!(":{}", p))
        .unwrap_or_default();
    let path_and_query = uri
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());

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
                let rewritten = rewrite_html(&s);
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
        .status(http::StatusCode::from_u16(status).unwrap_or(http::StatusCode::OK));

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
    let base_href = format!("dryerfox://{}{}/", host, port);
    let base_tag = format!(r#"<base href="{}">"#, base_href);

    // Insert right after <head> (case-insensitive). If there's no <head>, prepend.
    let lower = html.to_ascii_lowercase();
    if let Some(idx) = lower.find("<head>") {
        let insertion_point = idx + "<head>".len();
        format!(
            "{}{}{}",
            &html[..insertion_point],
            base_tag,
            &html[insertion_point..]
        )
    } else if let Some(idx) = lower.find("<head") {
        if let Some(end) = lower[idx..].find('>') {
            let insertion_point = idx + end + 1;
            format!(
                "{}{}{}",
                &html[..insertion_point],
                base_tag,
                &html[insertion_point..]
            )
        } else {
            format!("{}{}", base_tag, html)
        }
    } else {
        format!("{}{}", base_tag, html)
    }
}

fn is_text_response(content_type: &str) -> bool {
    content_type.starts_with("text/")
        || content_type.contains("javascript")
        || content_type.contains("json")
        || content_type.contains("xml")
        || content_type.contains("svg")
}

fn rewrite_html(html: &str) -> String {
    // Crude but effective for a silly play app: replace every absolute
    // http(s):// URL anywhere in the HTML with dryerfox://. The browser
    // resolves relative URLs against the current page's URL (which is
    // already dryerfox://), so they take care of themselves.
    html.replace("https://", "dryerfox://")
        .replace("http://", "dryerfox://")
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
