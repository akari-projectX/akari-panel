use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // rust-embed requires spa/dist to exist at compile time, but it is
    // gitignored (build artifact). Drop in a placeholder on fresh clones;
    // `make spa` replaces it with the real bundle.
    let dist = Path::new("spa/dist");
    std::fs::create_dir_all(dist)?;
    let index = dist.join("index.html");
    if !index.exists() {
        std::fs::write(
            &index,
            "<!doctype html><html><body>akari panel: frontend not built yet — run `make spa`.</body></html>",
        )?;
    }
    println!("cargo:rerun-if-changed=spa/dist");
    println!("cargo:rerun-if-changed=proto/agent.proto");

    // Canonical contract lives in this repo (proto/agent.proto); akari-agent
    // vendors a copy (`make sync-proto` there).
    let fds = protox::compile(["proto/agent.proto"], ["proto"])?;
    tonic_prost_build::configure()
        .build_server(true)
        .build_client(true)
        .compile_fds(fds)?;
    Ok(())
}
