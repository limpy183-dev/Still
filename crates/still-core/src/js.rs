//! Small JavaScript-compatibility helpers. The original validators run on loosely typed JSON, so the Rust
//! port keeps JS semantics (UTF-16 lengths, `Number()` coercion, `trim()`) where they decide what is accepted.
use serde_json::{Number, Value};

/// User-facing validation errors carry the same message the Electron app showed.
pub type R<T> = Result<T, String>;

pub fn err<T>(message: &str) -> R<T> {
    Err(message.to_string())
}

pub fn is_js_ws(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// JS `String.prototype.trim`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_ws)
}

/// JS `string.length` (UTF-16 code units).
pub fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `string.slice(0, n)`, without splitting a surrogate pair.
pub fn slice16(s: &str, n: usize) -> String {
    let (mut count, mut out) = (0, String::new());
    for c in s.chars() {
        count += c.len_utf16();
        if count > n {
            break;
        }
        out.push(c);
    }
    out
}

/// JS truthiness of a JSON value.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn str_to_number(s: &str) -> f64 {
    let t = trim(s);
    match t {
        "" => return 0.0,
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(rest) = t.strip_prefix(prefix) {
            return u64::from_str_radix(rest, radix).map(|n| n as f64).unwrap_or(f64::NAN);
        }
    }
    if !t.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-')) {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// JS `Number(value)`.
pub fn to_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => str_to_number(s),
        Some(Value::Array(a)) if a.is_empty() => 0.0,
        Some(Value::Array(a)) if a.len() == 1 => match &a[0] {
            Value::String(s) => str_to_number(s),
            Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
            Value::Null => 0.0,
            _ => f64::NAN,
        },
        Some(_) => f64::NAN,
    }
}

/// `Number(x) || fallback`.
pub fn number_or(v: Option<&Value>, fallback: f64) -> f64 {
    let n = to_number(v);
    if n == 0.0 || n.is_nan() { fallback } else { n }
}

/// JS `Math.round` (halves round up).
pub fn round(f: f64) -> f64 {
    (f + 0.5).floor()
}

/// JS `Number.isInteger(value)` for a JSON value (strings are never integers).
pub fn integer(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Number(n)) => n.as_f64().filter(|f| f.is_finite() && f.fract() == 0.0 && f.abs() < 9.2e18).map(|f| f as i64),
        _ => None,
    }
}

/// JSON.stringify-style number: integral values print without a decimal point, NaN/Infinity become null.
pub fn num(f: f64) -> Value {
    if f.is_finite() && f.fract() == 0.0 && f.abs() < 9.0e15 {
        Value::from(f as i64)
    } else {
        Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
    }
}

/// serde helper: an `f64` field written the way JSON.stringify would (`65`, not `65.0`).
pub fn serialize_num<S: serde::Serializer>(f: &f64, s: S) -> Result<S::Ok, S::Error> {
    serde::Serialize::serialize(&num(*f), s)
}

/// JS `String(value)` for the shapes validators meet.
pub fn string_of(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e21 => format!("{}", f as i128),
            _ => n.to_string(),
        },
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a.iter().map(|x| if x.is_null() { String::new() } else { string_of(Some(x)) }).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `String(value || fallback)`.
pub fn string_or(v: Option<&Value>, fallback: &str) -> String {
    if truthy(v) { string_of(v) } else { fallback.to_string() }
}

pub fn str_of(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

pub fn prop<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_object().and_then(|o| o.get(key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn number_coercion_matches_javascript() {
        assert_eq!(to_number(Some(&json!("25"))), 25.0);
        assert_eq!(to_number(Some(&json!(" 12 "))), 12.0);
        assert_eq!(to_number(Some(&json!(""))), 0.0);
        assert!(to_number(Some(&json!("inf"))).is_nan());
        assert!(to_number(Some(&json!("abc"))).is_nan());
        assert_eq!(to_number(Some(&json!("0x10"))), 16.0);
        assert_eq!(to_number(Some(&json!(true))), 1.0);
        assert_eq!(number_or(Some(&json!("x")), 50.0), 50.0);
        assert_eq!(integer(Some(&json!(5.0))), Some(5));
        assert_eq!(integer(Some(&json!(1.5))), None);
        assert_eq!(integer(Some(&json!("25"))), None);
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
    }

    #[test]
    fn strings_use_utf16_lengths() {
        assert_eq!(len16("a😀"), 3);
        assert_eq!(slice16("a😀b", 2), "a");
        assert_eq!(slice16("abc", 10), "abc");
        assert_eq!(trim("\u{feff} x \u{a0}"), "x");
        assert_eq!(trim("\u{85}x"), "\u{85}x");
        assert_eq!(string_of(Some(&json!(7))), "7");
        assert_eq!(num(7.0), json!(7));
        assert_eq!(num(7.5), json!(7.5));
    }
}
