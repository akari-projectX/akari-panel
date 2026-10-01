//! `akari-bench lb`: a TCP round-robin balancer (per connection) for the
//! multi-instance test: put it in front of the instances' web ports and,
//! separately, their gRPC ports (TLS passes through untouched, so mTLS
//! identity reaches the panel exactly as without it). A reference for the
//! topology only — production uses a real L4 balancer (docs/DEPLOY.md).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use anyhow::{bail, Result};
use tokio::net::{TcpListener, TcpStream};

#[derive(clap::Args, Debug)]
pub struct LbArgs {
    /// listen=backend1,backend2,... (repeatable), e.g.
    /// 127.0.0.1:18090=127.0.0.1:18080,127.0.0.1:18081
    #[arg(long, required = true)]
    pub map: Vec<String>,
}

pub async fn run(args: LbArgs) -> Result<()> {
    let mut tasks = Vec::new();
    for m in &args.map {
        let Some((listen, backends)) = m.split_once('=') else {
            bail!("--map wants listen=backend,backend: {m:?}");
        };
        let backends: Vec<String> = backends.split(',').map(str::to_owned).collect();
        if backends.is_empty() {
            bail!("no backends in {m:?}");
        }
        let l = TcpListener::bind(listen).await?;
        println!("lb {listen} -> {backends:?}");
        let next = Arc::new(AtomicUsize::new(0));
        tasks.push(tokio::spawn(async move {
            loop {
                let Ok((mut inbound, _)) = l.accept().await else {
                    continue;
                };
                let b = backends[next.fetch_add(1, Ordering::Relaxed) % backends.len()].clone();
                tokio::spawn(async move {
                    if let Ok(mut out) = TcpStream::connect(&b).await {
                        let _ = inbound.set_nodelay(true);
                        let _ = out.set_nodelay(true);
                        let _ = tokio::io::copy_bidirectional(&mut inbound, &mut out).await;
                    }
                });
            }
        }));
    }
    for t in tasks {
        t.await?;
    }
    Ok(())
}
