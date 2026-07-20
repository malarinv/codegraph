fn main() {
    napi_build::setup();

    // Kotlin grammar — vendored C, compiled here instead of a crate dep: the
    // crates.io tree-sitter-kotlin 0.3.8 pins `tree-sitter >= 0.21, < 0.23`
    // (the kernel links 0.25) and tree-sitter-kotlin-ng is a DIFFERENT
    // grammar (8 fields vs 0, renamed kinds — extractor-breaking). Sources
    // are the fwcd 0.3.8 tag's checked-in generated artifacts, sha-matched
    // against the crates.io tarball (kotlin checklist §Grammar prep):
    //   parser.c  54104a7ef1555c265b746c790e0f8bb953cc17806e9df0c3af82f7f62c06a70a
    //   scanner.c 27f73337ec357fc341fa57538f34c14277b0346980c3405dc30beab6202ec6d0
    // Flags crib the tarball's own bindings/rust/build.rs.
    let mut c = cc::Build::new();
    c.include("grammars/kotlin");
    c.file("grammars/kotlin/parser.c");
    c.file("grammars/kotlin/scanner.c");
    c.flag_if_supported("-Wno-unused-parameter");
    c.flag_if_supported("-Wno-unused-but-set-variable");
    c.flag_if_supported("-Wno-trigraphs");
    c.flag_if_supported("-utf-8"); // msvc
    c.compile("tree-sitter-kotlin");
    println!("cargo:rerun-if-changed=grammars/kotlin");
}
