//! Host metrics of this panel instance (W31): CPU, memory, load, disk of
//! the data directory, process RSS. Linux `/proc` + `statvfs`, no
//! subprocesses. A value that cannot be read is `None` ("unknown"), never 0.
//! The parsers are pure functions over the file contents (unit tested).

use serde::Serialize;

/// `/proc/stat` first line → (busy + idle jiffies, idle jiffies).
pub fn parse_cpu(stat: &str) -> Option<(u64, u64)> {
    let line = stat.lines().find(|l| l.starts_with("cpu "))?;
    let v: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .take(8)
        .map(|x| x.parse().ok())
        .collect::<Option<_>>()?;
    if v.len() < 4 {
        return None;
    }
    // user nice system idle iowait irq softirq steal
    let idle = v[3].saturating_add(v.get(4).copied().unwrap_or(0));
    let total = v.iter().fold(0u64, |a, x| a.saturating_add(*x));
    Some((total, idle))
}

/// CPU busy percentage between two `parse_cpu` readings.
pub fn cpu_percent(prev: (u64, u64), cur: (u64, u64)) -> Option<f64> {
    let total = cur.0.checked_sub(prev.0)?;
    let idle = cur.1.checked_sub(prev.1)?;
    if total == 0 || idle > total {
        return None;
    }
    Some(((total - idle) as f64 * 100.0 / total as f64 * 10.0).round() / 10.0)
}

/// `/proc/meminfo` → (total bytes, available bytes).
pub fn parse_meminfo(s: &str) -> Option<(u64, u64)> {
    let kb = |name: &str| -> Option<u64> {
        let l = s.lines().find(|l| l.starts_with(name))?;
        l[name.len()..]
            .trim()
            .trim_end_matches("kB")
            .trim()
            .parse::<u64>()
            .ok()?
            .checked_mul(1024)
    };
    let total = kb("MemTotal:")?;
    let avail = kb("MemAvailable:")?;
    (avail <= total).then_some((total, avail))
}

/// `/proc/loadavg` → 1/5/15 minute load (finite, non-negative).
pub fn parse_loadavg(s: &str) -> Option<[f64; 3]> {
    let mut it = s.split_whitespace().map(|x| x.parse::<f64>().ok());
    let v = [it.next()??, it.next()??, it.next()??];
    v.iter().all(|x| x.is_finite() && *x >= 0.0).then_some(v)
}

/// `/proc/self/status` → resident set size in bytes.
pub fn parse_rss(s: &str) -> Option<u64> {
    let l = s.lines().find(|l| l.starts_with("VmRSS:"))?;
    l["VmRSS:".len()..]
        .trim()
        .trim_end_matches("kB")
        .trim()
        .parse::<u64>()
        .ok()?
        .checked_mul(1024)
}

#[derive(Debug, Clone, Default, Serialize, serde::Deserialize, PartialEq)]
pub struct Host {
    pub hostname: Option<String>,
    pub cores: Option<u64>,
    pub cpu_percent: Option<f64>,
    pub load: Option<[f64; 3]>,
    pub mem_total_bytes: Option<u64>,
    pub mem_used_bytes: Option<u64>,
    /// The data directory's file system.
    pub disk_total_bytes: Option<u64>,
    pub disk_used_bytes: Option<u64>,
    /// This panel process.
    pub rss_bytes: Option<u64>,
    /// The machine-wide `/proc` files (stat, meminfo, loadavg) cannot be
    /// read while this process's own can: the service sandbox hides them
    /// (systemd `ProcSubset=pid`, in panel units before v0.4.1). The page
    /// says so instead of a bare "unknown".
    #[serde(default)]
    pub proc_hidden: bool,
}

fn read(path: &str) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// (total, used) bytes of the file system holding `dir`.
fn disk(dir: &std::path::Path) -> Option<(u64, u64)> {
    let st = rustix::fs::statvfs(dir).ok()?;
    let frsize = st.f_frsize;
    let total = st.f_blocks.checked_mul(frsize)?;
    let free = st.f_bfree.checked_mul(frsize)?;
    Some((total, total.saturating_sub(free)))
}

/// Remembers the previous CPU reading (the percentage is a delta).
#[derive(Default)]
pub struct Sampler {
    prev: std::sync::Mutex<Option<(u64, u64)>>,
}

impl Sampler {
    /// Read everything now (blocking file reads: small, in /proc).
    pub fn sample(&self, data_dir: &std::path::Path) -> Host {
        let stat = read("/proc/stat");
        let rss = read("/proc/self/status");
        let proc_hidden = stat.is_none() && rss.is_some();
        let cpu = stat.as_deref().and_then(parse_cpu);
        let cpu_percent = match (cpu, self.prev.lock()) {
            (Some(cur), Ok(mut prev)) => {
                let p = prev.and_then(|p| cpu_percent(p, cur));
                *prev = Some(cur);
                p
            }
            _ => None,
        };
        let mem = read("/proc/meminfo").as_deref().and_then(parse_meminfo);
        let disk = disk(data_dir);
        Host {
            // uname(2), not /proc/sys/kernel/hostname: readable under any
            // /proc sandbox, and the key that tells a restart on the same
            // host from another instance (`super::prune`).
            hostname: Some(
                rustix::system::uname()
                    .nodename()
                    .to_string_lossy()
                    .trim()
                    .to_string(),
            )
            .filter(|h| !h.is_empty())
            .or_else(|| std::env::var("HOSTNAME").ok()),
            cores: std::thread::available_parallelism()
                .ok()
                .map(|n| n.get() as u64),
            cpu_percent,
            load: read("/proc/loadavg").as_deref().and_then(parse_loadavg),
            mem_total_bytes: mem.map(|m| m.0),
            mem_used_bytes: mem.map(|m| m.0 - m.1),
            disk_total_bytes: disk.map(|d| d.0),
            disk_used_bytes: disk.map(|d| d.1),
            rss_bytes: rss.as_deref().and_then(parse_rss),
            proc_hidden,
        }
    }
}
