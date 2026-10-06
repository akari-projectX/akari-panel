//! Mail transports (W31): how a rendered message leaves the panel.
//!
//! Each provider is one module implementing [`Provider`] and one entry in
//! [`PROVIDERS`] (plus its id in the `mail_settings_provider` CHECK). A
//! provider builds a [`Transport`] from the saved settings (the outbox
//! sender and the admin's test mails use it) and runs the step-by-step
//! diagnostic behind 系统设置 → 邮件 → 测试发信 (`super::diagnose`).
//!
//! Secrets (SMTP password, API keys) are sealed with the panel's master key
//! (`state.master_key()`, AEAD with a fixed per-secret AAD) and only opened here,
//! right before use. Errors are admin-facing text and never carry a secret.

pub mod resend;
pub mod smtp;

use std::future::Future;
use std::pin::Pin;

use super::MailSettings;
use super::diagnose::Report;
use crate::masterkey::Keys;

/// One message, rendered.
#[derive(Debug, Clone)]
pub struct OutMsg {
    pub to: String,
    pub subject: String,
    pub text: String,
    pub html: String,
}

#[derive(Debug, Clone)]
pub struct SendError {
    /// Retrying cannot help (5xx reply, unusable address, bad API key).
    pub permanent: bool,
    pub message: String,
}

pub type SendFuture<'a> = Pin<Box<dyn Future<Output = Result<(), SendError>> + Send + 'a>>;
pub type DiagFuture<'a> = Pin<Box<dyn Future<Output = Report> + Send + 'a>>;

/// Something that delivers a message.
pub trait Transport: Send + Sync {
    fn send<'a>(&'a self, msg: &'a OutMsg) -> SendFuture<'a>;
}

/// A mail provider (the plugin interface).
pub trait Provider: Sync {
    /// The `mail_settings.provider` value.
    fn id(&self) -> &'static str;
    /// The saved settings hold everything this provider needs to send.
    fn complete(&self, s: &MailSettings) -> bool;
    /// A transport for the saved settings (errors: admin-facing text).
    fn build(&self, s: &MailSettings, keys: &Keys) -> Result<Box<dyn Transport>, String>;
    /// Check the path to the provider step by step, then send `msg`.
    fn diagnose<'a>(
        &'a self,
        s: &'a MailSettings,
        keys: &'a Keys,
        msg: &'a OutMsg,
    ) -> DiagFuture<'a>;
}

/// Every provider, by id.
pub static PROVIDERS: &[&dyn Provider] = &[&smtp::SMTP, &resend::RESEND];

/// The provider with this id.
pub fn provider(id: &str) -> Option<&'static dyn Provider> {
    PROVIDERS.iter().copied().find(|p| p.id() == id)
}

/// The transport for the saved settings.
pub fn build(s: &MailSettings, keys: &Keys) -> Result<Box<dyn Transport>, String> {
    provider(&s.provider)
        .ok_or_else(|| format!("unknown mail provider {:?}", s.provider))?
        .build(s, keys)
}

/// Open a sealed secret of the settings row (`what` names it in errors).
pub(crate) fn open_secret(
    keys: &Keys,
    aad: uuid::Uuid,
    blob: &[u8],
    what: &str,
) -> Result<String, String> {
    let pt = keys.open(aad, blob).ok_or_else(|| {
        format!("the stored {what} cannot be decrypted (the panel's master key changed?); enter it again")
    })?;
    String::from_utf8(pt).map_err(|_| format!("the stored {what} is not UTF-8"))
}

#[cfg(test)]
mod tests;
