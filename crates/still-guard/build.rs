// Attaches the icon, version info and manifest to Still.Guard.exe (code signing requires them).
fn main() {
    println!("cargo:rerun-if-changed=guard.rc");
    println!("cargo:rerun-if-changed=guard.manifest");
    embed_resource::compile("guard.rc", embed_resource::NONE).manifest_required().unwrap();
}
