fn main() {
    println!("cargo:rerun-if-changed=../crates/medict-core/src/word_lookup.rs");
    println!("cargo:rerun-if-changed=../crates/medict-core/src/drug_lookup.rs");
    println!("cargo:rerun-if-changed=medict.rc");
    println!("cargo:rerun-if-changed=../build/medict.ico");

    let output =
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("medict-resources.o");
    match std::process::Command::new("windres")
        .args(["medict.rc", "-O", "coff", "-o"])
        .arg(&output)
        .status()
    {
        Ok(status) if status.success() => {
            println!("cargo:rustc-link-arg-bin=medict-native={}", output.display());
        }
        Ok(status) => println!(
            "cargo:warning=windres returned {status}; using the default Windows application icon"
        ),
        Err(error) => println!(
            "cargo:warning=windres is unavailable ({error}); using the default Windows application icon"
        ),
    }
}
