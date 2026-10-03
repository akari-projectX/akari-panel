//! Ops: a small CSV writer for the admin exports (`export.rs`).
//!
//! RFC 4180 quoting (comma, quote, CR/LF → quoted, quotes doubled), CRLF
//! rows, a UTF-8 BOM first (Excel then reads UTF-8), and spreadsheet
//! formula-injection protection: a TEXT cell whose first character is one
//! of `= + - @` or a tab/CR gets a leading apostrophe and is quoted, so a
//! login like `=HYPERLINK(...)` opens as text, never as a formula. Values
//! the panel formats itself (numbers, dates, ids, booleans) are written as
//! `Cell::Raw` and are never prefixed (a negative amount stays a number).

/// One cell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cell {
    /// Untrusted / free text (logins, names, reasons): formula-safe.
    Text(String),
    /// Panel-formatted scalar (number, date, uuid, bool): quoted only when
    /// the characters require it.
    Raw(String),
    Empty,
}

impl Cell {
    pub fn text(s: impl Into<String>) -> Cell {
        Cell::Text(s.into())
    }
    pub fn raw(s: impl ToString) -> Cell {
        Cell::Raw(s.to_string())
    }
    pub fn opt_text(s: Option<impl Into<String>>) -> Cell {
        s.map_or(Cell::Empty, Cell::text)
    }
    pub fn opt_raw(s: Option<impl ToString>) -> Cell {
        s.map_or(Cell::Empty, Cell::raw)
    }
    pub fn bool(b: bool) -> Cell {
        Cell::Raw(if b { "true" } else { "false" }.into())
    }
}

/// Characters that make a spreadsheet treat a cell as a formula.
fn formula_lead(c: char) -> bool {
    matches!(c, '=' | '+' | '-' | '@' | '\t' | '\r')
}

fn needs_quotes(s: &str) -> bool {
    s.is_empty()
        || s.chars()
            .any(|c| matches!(c, ',' | '"' | '\n' | '\r' | ';'))
        || s.starts_with(' ')
        || s.ends_with(' ')
}

fn quoted(out: &mut Vec<u8>, s: &str) {
    out.push(b'"');
    for c in s.chars() {
        if c == '"' {
            out.push(b'"');
        }
        let mut b = [0u8; 4];
        out.extend_from_slice(c.encode_utf8(&mut b).as_bytes());
    }
    out.push(b'"');
}

/// Append one encoded cell (no separator).
pub fn write_cell(out: &mut Vec<u8>, cell: &Cell) {
    match cell {
        Cell::Empty => {}
        Cell::Raw(s) => {
            if needs_quotes(s) {
                quoted(out, s);
            } else {
                out.extend_from_slice(s.as_bytes());
            }
        }
        Cell::Text(s) => {
            // Control characters other than tab/newline never reach a sheet.
            let clean: String = s
                .chars()
                .filter(|c| !c.is_control() || matches!(c, '\t' | '\n' | '\r'))
                .collect();
            if clean.chars().next().is_some_and(formula_lead) {
                let mut guarded = String::with_capacity(clean.len() + 1);
                guarded.push('\'');
                guarded.push_str(&clean);
                quoted(out, &guarded);
            } else if needs_quotes(&clean) {
                quoted(out, &clean);
            } else {
                out.extend_from_slice(clean.as_bytes());
            }
        }
    }
}

/// Append one row (CRLF-terminated).
pub fn write_row(out: &mut Vec<u8>, cells: &[Cell]) {
    for (i, c) in cells.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        write_cell(out, c);
    }
    out.extend_from_slice(b"\r\n");
}

/// The UTF-8 byte order mark Excel needs to read UTF-8.
pub const BOM: &[u8] = b"\xEF\xBB\xBF";

/// A header row from column names (`Raw`: our own ASCII names).
pub fn header(out: &mut Vec<u8>, names: &[&str]) {
    let cells: Vec<Cell> = names.iter().map(Cell::raw).collect();
    write_row(out, &cells);
}

/// Minimal RFC 4180 reader for tests and fuzzing: rows of fields, or None
/// when the bytes are not well-formed CSV.
#[cfg(any(test, fuzzing))]
pub fn parse(bytes: &[u8]) -> Option<Vec<Vec<String>>> {
    let s = std::str::from_utf8(bytes.strip_prefix(BOM).unwrap_or(bytes)).ok()?;
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut chars = s.chars().peekable();
    let mut in_quotes = false;
    let mut quoted_field = false;
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' if field.is_empty() && !quoted_field => {
                in_quotes = true;
                quoted_field = true;
            }
            '"' => return None,
            ',' => {
                row.push(std::mem::take(&mut field));
                quoted_field = false;
            }
            '\r' => {
                if chars.next() != Some('\n') {
                    return None;
                }
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
                quoted_field = false;
            }
            '\n' => return None,
            _ if quoted_field => return None,
            _ => field.push(c),
        }
    }
    if in_quotes {
        return None;
    }
    if !field.is_empty() || !row.is_empty() {
        return None; // every row ends with CRLF
    }
    Some(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(c: Cell) -> String {
        let mut out = Vec::new();
        write_cell(&mut out, &c);
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn quoting_and_doubling() {
        assert_eq!(one(Cell::text("plain")), "plain");
        assert_eq!(one(Cell::text("a,b")), "\"a,b\"");
        assert_eq!(one(Cell::text("say \"hi\"")), "\"say \"\"hi\"\"\"");
        assert_eq!(one(Cell::text("two\nlines")), "\"two\nlines\"");
        assert_eq!(one(Cell::text("")), "\"\"");
        assert_eq!(one(Cell::Empty), "");
        assert_eq!(one(Cell::text(" pad")), "\" pad\"");
        assert_eq!(one(Cell::text("中文；全角分号")), "中文；全角分号");
        assert_eq!(one(Cell::text("a;b")), "\"a;b\"");
    }

    #[test]
    fn formula_lead_is_neutralised_for_text_only() {
        for s in ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"] {
            let got = one(Cell::text(s));
            assert!(got.starts_with("\"'"), "{s:?} -> {got:?}");
            let back = parse(format!("{got}\r\n").as_bytes()).unwrap();
            assert_eq!(back[0][0], format!("'{s}"));
        }
        assert_eq!(one(Cell::raw(-5)), "-5");
        assert_eq!(one(Cell::raw("2026-10-03")), "2026-10-03");
        assert_eq!(one(Cell::bool(true)), "true");
    }

    #[test]
    fn control_characters_are_dropped() {
        assert_eq!(one(Cell::text("a\u{0}b\u{7}c")), "abc");
    }

    #[test]
    fn rows_round_trip() {
        let mut out = Vec::new();
        out.extend_from_slice(BOM);
        header(&mut out, &["id", "login", "amount"]);
        write_row(
            &mut out,
            &[
                Cell::raw(1),
                Cell::text("=cmd|' /C calc'!A0"),
                Cell::raw(-100),
            ],
        );
        write_row(
            &mut out,
            &[Cell::raw(2), Cell::text("ok, fine"), Cell::Empty],
        );
        let rows = parse(&out).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0], vec!["id", "login", "amount"]);
        assert_eq!(rows[1][1], "'=cmd|' /C calc'!A0");
        assert_eq!(rows[1][2], "-100");
        assert_eq!(rows[2], vec!["2", "ok, fine", ""]);
        assert!(out.starts_with(BOM));
    }

    #[test]
    fn parser_rejects_malformed() {
        assert!(parse(b"a,b\n").is_none());
        assert!(parse(b"a,\"b\r\n").is_none());
        assert!(parse(b"a,b\"c\r\n").is_none());
        assert!(parse(b"a,b").is_none());
        assert_eq!(parse(b"").unwrap().len(), 0);
    }
}
