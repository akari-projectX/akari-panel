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
    emit_git_sha();
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

/// `AKARI_GIT_SHA` (compile-time env, read by `akari --version` and the
/// `akari_build_info` metric): the CI/Docker build passes it explicitly
/// (`.git` is not in the Docker context); otherwise ask git; else "unknown".
fn emit_git_sha() {
    println!("cargo:rerun-if-env-changed=AKARI_GIT_SHA");
    // Re-run when the checked-out commit changes (worktrees keep their git
    // dir elsewhere, hence `--git-path`). Missing files are not listed:
    // cargo would treat them as always-changed.
    for name in ["HEAD", "logs/HEAD"] {
        if let Some(path) = git(&["rev-parse", "--git-path", name]) {
            if std::path::Path::new(&path).exists() {
                println!("cargo:rerun-if-changed={path}");
            }
        }
    }
    let sha = std::env::var("AKARI_GIT_SHA")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| git(&["rev-parse", "--short=12", "HEAD"]))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=AKARI_GIT_SHA={sha}");
}

fn git(args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    Some(String::from_utf8(out.stdout).ok()?.trim().to_string())
}
