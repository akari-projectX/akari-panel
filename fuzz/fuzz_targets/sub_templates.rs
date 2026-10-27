//! Subscription templates (2026-10-27): the parser/renderers of the four
//! client templates and the injection of a line's data.
//!
//! Input: the first byte selects — 0 sing-box, 1 Clash, 2 Surge, 3
//! Surfboard: the rest is a template body; 0xff: the rest (split at the
//! first NUL into name and secret) is a line rendered through the built-in
//! templates.
//!
//! Invariants: no panic (nested documents, anchors, huge regexes); an
//! accepted template (strict, for the sample user) is also accepted
//! leniently, and its output is again a document of the same kind (YAML /
//! JSON) or has its Surge sections; the lenient render of any body never
//! fails where the strict one passed; a line's name and secret never add a
//! structure to any format's profile.
#![no_main]

use akari_panel::fuzzing;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Some((&sel, rest)) = data.split_first() else {
        return;
    };
    let text = String::from_utf8_lossy(rest);
    let result = if sel == 0xff {
        let (name, secret) = text.split_once('\0').unwrap_or((&text, ""));
        fuzzing::sub_template_values(name, secret)
    } else {
        fuzzing::sub_template_body(sel, &text)
    };
    if let Err(violation) = result {
        panic!("{violation}");
    }
});
