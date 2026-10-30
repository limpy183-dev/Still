// Attaches the setup icon, version info and the per-user execution manifest.
fn main() {
    println!("cargo:rerun-if-changed=setup.rc");
    println!("cargo:rerun-if-changed=../../installer/app.manifest");
    embed_resource::compile("setup.rc", embed_resource::NONE).manifest_required().unwrap();
}
