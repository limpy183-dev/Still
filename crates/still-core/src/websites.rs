//! Port of `app/websites.js` (the parts the app and guard use): website identities, block screens and daily limits.
use crate::js::*;
use regex::Regex;
use serde_json::{Map, Value, json};
use std::sync::LazyLock;
use url::Url;

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("valid pattern")
}
static SCHEME: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^[a-z][a-z0-9+.-]*://"));
static HOST: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$"));
static LOCAL_TLD: LazyLock<Regex> = LazyLock::new(|| re(r"\.(localhost|local|internal|test|invalid)$"));
static IMAGE: LazyLock<Regex> = LazyLock::new(|| re(r"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$"));
static CLOCK: LazyLock<Regex> = LazyLock::new(|| re(r"^([01][0-9]|2[0-3]):[0-5][0-9]$"));

pub const PRESETS: [&str; 3] = ["garden", "dusk", "paper"];

/// A block-screen image: a base64 PNG, JPEG or WebP data URL (never SVG or a remote address).
pub fn is_data_image(image: &str) -> bool {
    IMAGE.is_match(image)
}

/// Normalises a website address or URL to its public host name.
pub fn domain(value: &str) -> R<String> {
    if len16(value) > 2048 || value.chars().any(|c| is_js_ws(c) || c == '\\' || c == '*') {
        return err("Enter a website such as youtube.com or paste its URL.");
    }
    let text = if SCHEME.is_match(value) { value.to_string() } else { format!("https://{value}") };
    let Ok(url) = Url::parse(&text) else { return err("Enter a valid website address.") };
    let host = url.host_str().unwrap_or("").to_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host);
    let host = host.strip_prefix("www.").unwrap_or(host).to_string();
    let public = (1..=253).contains(&host.len()) && HOST.is_match(&host) && !LOCAL_TLD.is_match(&host);
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() || !public {
        return err("Use a public website domain, without credentials, wildcards, or an IP address.");
    }
    Ok(host)
}

/// The guard's own strict check of a stored `website:<host>` identity (already normalised, public).
pub fn domain_of(app: &crate::session::TargetApp) -> R<String> {
    static STRICT: LazyLock<Regex> = LazyLock::new(|| re(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$"));
    let host = app.path().strip_prefix("website:").unwrap_or("");
    if host.len() > 253 || host != host.to_lowercase() || host.starts_with("www.") || !STRICT.is_match(host) || LOCAL_TLD.is_match(host) {
        return err("Choose a public website domain.");
    }
    Ok(host.to_string())
}

pub fn is_website(target: &Value) -> bool {
    str_of(prop(target, "path")).is_some_and(|p| p.starts_with("website:"))
}

pub fn allowed_website(target: &Value) -> bool {
    is_website(target) && prop(target, "name").is_some_and(Value::is_string) && {
        let host = &str_of(prop(target, "path")).unwrap_or_default()[8..];
        domain(host).is_ok_and(|d| d == host)
    }
}

/// `{ name, path }` for a typed address.
pub fn target(value: &str) -> R<Value> {
    let host = domain(trim(value))?;
    Ok(json!({ "name": host, "path": format!("website:{host}") }))
}

pub fn matches(host: &str, blocked: &str) -> bool {
    let host = host.to_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host);
    host == blocked || host.ends_with(&format!(".{blocked}"))
}

/// Validates a block-screen configuration. `value` is `None` for JS `undefined`.
pub fn screen(value: Option<&Value>, targets: &[Value]) -> R<Value> {
    let empty = json!({});
    let value = value.unwrap_or(&empty);
    if !value.is_object() {
        return err("Choose a website block screen.");
    }
    let mode = if truthy(prop(value, "mode")) { prop(value, "mode") } else { None };
    let mode = match mode {
        None => "garden",
        Some(Value::String(m)) if PRESETS.contains(&m.as_str()) || m == "custom" || m == "redirect" => m,
        Some(_) => return err("Choose a website block screen."),
    };
    let mut result = Map::new();
    result.insert("mode".into(), json!(mode));
    result.insert("title".into(), json!(slice16(&string_or(prop(value, "title"), ""), 120)));
    result.insert("text".into(), json!(slice16(&string_or(prop(value, "text"), ""), 1000)));
    result.insert("image".into(), json!(""));
    result.insert("redirect".into(), json!(""));
    if truthy(prop(value, "image")) {
        match prop(value, "image").and_then(Value::as_str) {
            Some(image) if len16(image) <= 180000 && IMAGE.is_match(image) => result.insert("image".into(), json!(image)),
            _ => return err("Choose a block-screen image using the image picker."),
        };
    }
    if mode == "redirect" {
        let redirect_error = || "Enter a full redirect URL, beginning with https://.".to_string();
        let url = str_of(prop(value, "redirect")).and_then(|r| Url::parse(r).ok()).ok_or_else(redirect_error)?;
        let host = domain(url.as_str())?;
        let blocked = targets.iter().filter(|t| is_website(t)).any(|t| matches(&host, &str_of(prop(t, "path")).unwrap_or_default()[8..]));
        if url.scheme() != "https" || len16(url.as_str()) > 2048 || blocked {
            return err("Choose an HTTPS destination outside your blocked websites.");
        }
        result.insert("redirect".into(), json!(url.as_str()));
    }
    Ok(Value::Object(result))
}

fn clock(v: Option<&Value>) -> Option<&str> {
    str_of(v).filter(|s| CLOCK.is_match(s))
}

/// Daily limits and bedtime, enforced by the browser companion. `minutes` 0 means no daily limit.
pub fn limits(value: Option<&Value>) -> Value {
    let empty = json!({});
    let value = value.filter(|v| v.is_object()).unwrap_or(&empty);
    let bedtime = prop(value, "bedtime");
    let bedtime_prop = |key| bedtime.and_then(|b| prop(b, key));
    let bedtime = json!({
        "on": bedtime_prop("on") != Some(&Value::Bool(false)),
        "from": clock(bedtime_prop("from")).unwrap_or("22:30"),
        "to": clock(bedtime_prop("to")).unwrap_or("07:00"),
    });
    let mut seen = std::collections::HashSet::new();
    let mut sites = Vec::new();
    if let Some(Value::Array(list)) = prop(value, "sites") {
        for site in list {
            let Ok(host) = domain(&string_of(prop(site, "domain"))) else { continue };
            if !seen.insert(host.clone()) {
                continue;
            }
            let minutes = round(number_or(prop(site, "minutes"), 0.0)).clamp(0.0, 1440.0);
            sites.push(json!({ "domain": host, "minutes": num(minutes), "bedtime": prop(site, "bedtime") == Some(&Value::Bool(true)) }));
            if sites.len() == 100 {
                break;
            }
        }
    }
    json!({ "bedtime": bedtime, "sites": sites })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn website_addresses_normalize_and_reject_unsafe_identities() {
        assert_eq!(domain("https://WWW.YouTube.com/watch?v=123").unwrap(), "youtube.com");
        assert_eq!(domain("example.com:8080/path").unwrap(), "example.com");
        assert_eq!(domain("https://bücher.de").unwrap(), "xn--bcher-kva.de");
        assert_eq!(domain("reddit.com.").unwrap(), "reddit.com");
        for value in ["file:///etc/passwd", "javascript:alert(1)", "127.0.0.1", "[::1]", "localhost", "foo.local", "https://name:password@example.com", "*.example.com", "example.com\\evil", "https://-bad.com", "https://a..com", "example.com\n"] {
            assert!(domain(value).is_err(), "{value}");
        }
        assert!(matches("a.b.example.com", "example.com"));
        assert!(matches("EXAMPLE.COM.", "example.com"));
        assert!(!matches("notexample.com", "example.com"));
        assert!(!matches("example.com.attacker.com", "example.com"));
    }

    #[test]
    fn redirect_loops_and_executable_image_urls_are_rejected() {
        let targets = [target("youtube.com").unwrap()];
        for redirect in ["https://youtube.com/", "https://m.youtube.com/", "https://youtube.com./", "javascript:alert(1)", "http://example.com/", "https://127.0.0.1/", "https://user:pass@example.com"] {
            assert!(screen(Some(&json!({ "mode": "redirect", "redirect": redirect })), &targets).is_err(), "{redirect}");
        }
        assert_eq!(screen(Some(&json!({ "mode": "redirect", "redirect": "https://example.com/notes" })), &targets).unwrap()["redirect"], "https://example.com/notes");
        assert!(screen(Some(&json!({ "image": "data:image/svg+xml;base64,AAAA" })), &[]).is_err());
        assert!(screen(Some(&json!({ "image": "https://example.com/image.png" })), &[]).is_err());
        assert!(screen(Some(&json!({ "image": format!("data:image/png;base64,{}", "A".repeat(180000)) })), &[]).is_err());
        assert_eq!(screen(None, &[]).unwrap()["mode"], "garden");
        assert!(screen(Some(&Value::Null), &[]).is_err());
    }

    #[test]
    fn daily_limits_and_bedtime_normalize() {
        let config = limits(Some(&json!({ "bedtime": { "from": "22:00", "to": "07:00" }, "sites": [
            { "domain": "https://www.youtube.com/watch", "minutes": 30, "bedtime": true }, { "domain": "youtube.com", "minutes": 5 },
            { "domain": "localhost", "minutes": 5 }, { "domain": "reddit.com", "minutes": 99999 }] })));
        assert_eq!(config["sites"], json!([{ "domain": "youtube.com", "minutes": 30, "bedtime": true }, { "domain": "reddit.com", "minutes": 1440, "bedtime": false }]));
        assert_eq!(limits(Some(&json!({ "bedtime": { "from": "25:00" } })))["bedtime"], json!({ "on": true, "from": "22:30", "to": "07:00" }));
    }
}
