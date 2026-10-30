// Embeds the screens (app/), fonts and icons (assets/) and the browser companion's files (app/browser-extension/) into
// the executable, and attaches the icon, version info and manifest.
use std::{env, fs, path::{Path, PathBuf}};

// `skip`: names left out (the companion has its own table; the YouTube banner is for the channel, not the app).
fn walk(dir: &Path, prefix: &str, skip: &[&str], out: &mut Vec<(String, PathBuf)>) {
    for entry in fs::read_dir(dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display())) {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if skip.contains(&name.as_str()) {
            continue;
        }
        if path.is_dir() {
            walk(&path, &format!("{prefix}{name}/"), skip, out);
        } else {
            out.push((format!("{prefix}{name}"), path));
        }
    }
}

fn table(name: &str, files: &mut Vec<(String, PathBuf)>) -> String {
    files.sort();
    let mut code = format!("pub static {name}: &[(&str, &[u8])] = &[\n");
    for (url, path) in files.iter() {
        let path = path.to_string_lossy().replace(r"\\?\", "");
        code += &format!("    ({url:?}, include_bytes!({path:?})),\n");
    }
    code + "];\n"
}

fn main() {
    let root = Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap()).join("../..").canonicalize().unwrap();
    let (mut ui, mut companion) = (Vec::new(), Vec::new());
    walk(&root.join("app"), "/", &["browser-extension"], &mut ui);
    walk(&root.join("assets"), "/assets/", &["still-youtube-banner.png"], &mut ui);
    walk(&root.join("app/browser-extension"), "", &[], &mut companion);
    let code = table("FILES", &mut ui) + &table("COMPANION", &mut companion);
    fs::write(Path::new(&env::var("OUT_DIR").unwrap()).join("embedded.rs"), code).unwrap();
    for dir in ["../../app", "../../assets", "still.rc", "still.manifest"] {
        println!("cargo:rerun-if-changed={dir}");
    }
    embed_resource::compile("still.rc", embed_resource::NONE).manifest_required().unwrap();
}
