//! akari panel library: every module of the `akari` binary. The binary
//! (`main.rs`) is the CLI and startup wiring; the library exists so the
//! benchmark and load tooling (`bench/`) can drive the real code paths.

pub mod account;
pub mod api;
pub mod audit;
pub mod auth;
pub mod client_ip;
pub mod config;
pub mod config_check;
pub mod db;
pub mod enforce;
pub mod enroll;
pub mod entitle;
pub mod gen;
pub mod grpc;
pub mod install;
pub mod login_limit;
pub mod metrics;
pub mod nodeops;
pub mod notify;
pub mod plans;
pub mod rate;
pub mod reaper;
pub mod reject;
pub mod request_id;
pub mod rollout;
pub mod shutdown;
pub mod spa;
pub mod state;
pub mod sub;
#[cfg(test)]
pub mod testdb;
pub mod totp;
pub mod traffic;
pub mod updates;
pub mod valkey_util;
pub mod web;
