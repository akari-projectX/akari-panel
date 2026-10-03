//! akari panel library: every module of the `akari` binary. The binary
//! (`main.rs`) is the CLI and startup wiring; the library exists so the
//! benchmark and load tooling (`bench/`) can drive the real code paths.

pub mod account;
pub mod alerts;
pub mod announcements;
pub mod api;
pub mod audit;
pub mod auth;
pub mod batch;
pub mod billing;
pub mod branding;
pub mod client_ip;
pub mod cloudflare;
pub mod config;
pub mod config_check;
pub mod csvx;
pub mod dashboard;
pub mod db;
pub mod enforce;
pub mod enroll;
pub mod entitle;
pub mod export;
#[cfg(fuzzing)]
#[doc(hidden)]
pub mod fuzzing;
pub mod grpc;
pub mod install;
pub mod kb;
pub mod login_limit;
pub mod mail;
pub mod mailhook;
pub mod markdown;
pub mod metrics;
pub mod nodeinstall;
pub mod nodemeta;
pub mod nodeops;
pub mod nodestat;
pub mod nodetpl;
pub mod notify;
pub mod pb;
pub mod plans;
pub mod protocols;
pub mod rate;
pub mod reaper;
pub mod reject;
pub mod request_id;
pub mod rollout;
pub mod settings;
pub mod shutdown;
pub mod signup;
pub mod spa;
pub mod state;
pub mod sub;
#[cfg(test)]
pub mod testdb;
pub mod tickets;
pub mod tlsserver;
pub mod totp;
pub mod traffic;
pub mod trafficlog;
pub mod updatecheck;
pub mod updates;
pub mod valkey_util;
#[cfg(test)]
mod w20_tests;
#[cfg(test)]
mod w21_tests;
pub mod web;
