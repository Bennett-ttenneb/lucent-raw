fn main() {
    // The face-parsing model is not published with the source (see MODELS-NOT-INCLUDED.md), so a build made from the public
    // repository does not have it. Without the file the program still builds, and the portrait retouch finds the skin, eyes and
    // mouth from their colours instead.
    println!("cargo:rustc-check-cfg=cfg(has_face_parsing)");
    println!("cargo:rerun-if-changed=resources/face-parsing-resnet18.onnx");
    if std::path::Path::new("resources/face-parsing-resnet18.onnx").is_file() {
        println!("cargo:rustc-cfg=has_face_parsing");
    }
    tauri_build::build()
}
