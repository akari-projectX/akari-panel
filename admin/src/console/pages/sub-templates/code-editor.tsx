// The subscription template editor: CodeMirror 6 (a chunk of its own, loaded
// by the template page when the editor first shows). Line numbers, syntax
// highlighting (JSON for sing-box, YAML for Clash, a small INI-like mode for
// Surge and Surfboard), `$placeholder` / `{all}` marks, the server's error
// position (line background + a wavy mark at the column), themed with the
// app's colour tokens (CSS variables: light and dark follow the <html>
// class). Everything is plain DOM and CSS classes: no eval, no inline script,
// so it runs under the console's CSP (`script-src 'self'`). Controlled:
// `value` in, `onChange` out; the page inserts placeholders at the cursor
// through `handle`. `readOnly` makes it the preview viewer.
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
  type StreamParser,
} from "@codemirror/language";
import { EditorSelection, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  MatchDecorator,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

export type EditorHandle = {
  /** Replace the selection with `text` and focus the editor. */
  insert: (text: string) => void;
  /** Put the cursor at a 1-based line (and column) and scroll there. */
  gotoLine: (line: number, column?: number) => void;
};

export type Lang = "json" | "yaml" | "ini";
/** Where the server found a problem (1-based; the column is optional). */
export type ErrorPos = { line: number; column?: number };

// Surge / Surfboard profiles: `[Section]` headers, `# ; //` comments,
// `key = value` lines, quoted strings, numbers.
const iniParser: StreamParser<unknown> = {
  name: "surge-profile",
  token(stream) {
    if (stream.sol()) {
      if (stream.match(/^\s*(#|;|\/\/)/)) {
        stream.skipToEnd();
        return "comment";
      }
      if (stream.match(/^\s*\[[^\]\n]*\]/)) return "heading";
      if (stream.match(/^[^=\n,]+?(?=\s*=)/)) return "propertyName";
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^-?\d+(?:\.\d+)?\b/)) return "number";
    if (stream.match(/^(?:true|false)\b/)) return "bool";
    if (stream.match(/^(?:DIRECT|REJECT(?:-NO-DROP)?|FINAL)\b/)) return "keyword";
    stream.next();
    return null;
  },
  tokenTable: { heading: t.heading, propertyName: t.propertyName, bool: t.bool, keyword: t.keyword },
};

function language(lang: Lang): Extension {
  if (lang === "json") return json();
  if (lang === "yaml") return yaml();
  return StreamLanguage.define(iniParser);
}

// `$subs_link`, `$proxies`… and sing-box's `{all}` / `{all:<regex>}`.
const placeholder = Decoration.mark({ class: "cm-ph" });
const phMatcher = new MatchDecorator({
  regexp: /\$(?:subs_link|subs_domain|site_name|proxies|proxy_group|subscribe_info)\b|\{all(?::[^}\n"]*)?\}/g,
  decoration: () => placeholder,
});
const phPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = phMatcher.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = phMatcher.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

const setErrors = StateEffect.define<readonly ErrorPos[]>();
const errorsField = StateField.define<readonly ErrorPos[]>({
  create: () => [],
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(setErrors) ? e.value : acc), v),
});
const errLine = Decoration.line({ class: "cm-err-line" });
const errMark = Decoration.mark({ class: "cm-err-mark", attributes: { "aria-invalid": "true" } });

function errorDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const ranges = [];
  for (const e of state.field(errorsField)) {
    if (e.line < 1 || e.line > doc.lines) continue;
    const line = doc.line(e.line);
    ranges.push(errLine.range(line.from));
    if (e.column && e.column >= 1) {
      const from = Math.min(line.from + e.column - 1, line.to);
      // The word at the column (at least one character).
      const rest = doc.sliceString(from, line.to);
      const len = Math.max(/^[^\s,:"'[\]{}()]+/.exec(rest)?.[0].length ?? 1, 1);
      if (from < line.to) ranges.push(errMark.range(from, Math.min(from + len, line.to)));
    }
  }
  return Decoration.set(ranges, true);
}
const errorsPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = errorDecorations(view.state);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.startState.field(errorsField) !== u.state.field(errorsField))
        this.decorations = errorDecorations(u.state);
    }
  },
  { decorations: (v) => v.decorations },
);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--foreground)", fontSize: "var(--text-footnote)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "20px" },
  ".cm-content": { padding: "10px 0", caretColor: "var(--primary)" },
  ".cm-line": { padding: "0 14px 0 6px" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--faint)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 4px 0 12px", minWidth: "32px" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--foreground) 4%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted-foreground)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)" },
  ".cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--primary) 18%, transparent)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--primary) 26%, transparent)",
  },
  ".cm-matchingBracket": { backgroundColor: "var(--primary-soft)", outline: "none" },
  ".cm-ph": { backgroundColor: "var(--primary-soft)", color: "var(--primary)", borderRadius: "4px" },
  ".cm-err-line": { backgroundColor: "var(--destructive-soft)" },
  ".cm-err-mark": {
    color: "var(--destructive)",
    textDecoration: "underline wavy var(--destructive)",
    textUnderlineOffset: "3px",
  },
});

const highlight = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--chart-1)" },
  { tag: [t.string, t.attributeValue], color: "var(--chart-3)" },
  { tag: [t.number, t.unit], color: "var(--chart-4)" },
  { tag: [t.bool, t.null, t.keyword, t.atom], color: "var(--chart-2)" },
  { tag: [t.heading, t.labelName], color: "var(--chart-7)", fontWeight: "600" },
  { tag: t.comment, color: "var(--faint)", fontStyle: "italic" },
  { tag: [t.meta, t.separator, t.punctuation], color: "var(--muted-foreground)" },
]);

export default function CodeEditor({
  value,
  onChange,
  lang,
  label,
  errors,
  readOnly,
  onSave,
  handle,
}: {
  value: string;
  onChange?: (v: string) => void;
  lang: Lang;
  /** Accessible name of the text box. */
  label: string;
  errors?: readonly ErrorPos[];
  readOnly?: boolean;
  onSave?: () => void;
  handle?: Ref<EditorHandle>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onSave });
  // Documents this editor reported (newest last): a render that still
  // carries one of them is the parent catching up with typing, not an
  // outside change (on a slow device it can land after the next keystroke
  // and would otherwise put the older text back).
  const sent = useRef<string[]>([]);
  useEffect(() => {
    cb.current = { onChange, onSave };
  });

  // Create once per mount (the page remounts for another format).
  useEffect(() => {
    const exts: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            cb.current.onSave?.();
            return true;
          },
        },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      language(lang),
      syntaxHighlighting(highlight),
      theme,
      phPlugin,
      errorsField,
      errorsPlugin,
      EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false" }),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        const doc = u.state.doc.toString();
        sent.current = [...sent.current.slice(-19), doc];
        cb.current.onChange?.(doc);
      }),
    ];
    if (readOnly) exts.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
    const v = new EditorView({ parent: host.current!, state: EditorState.create({ doc: value, extensions: exts }) });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Outside changes (a reset, a reload, a new preview) replace the document.
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === value || sent.current.includes(value)) return;
    sent.current = [];
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: setErrors.of(errors ?? []) });
  }, [errors]);

  useImperativeHandle(
    handle,
    () => ({
      insert: (text) => {
        const v = view.current;
        if (!v) return;
        v.dispatch(v.state.replaceSelection(text), { scrollIntoView: true });
        v.focus();
      },
      gotoLine: (line, column = 1) => {
        const v = view.current;
        if (!v) return;
        const l = v.state.doc.line(Math.min(Math.max(line, 1), v.state.doc.lines));
        const pos = Math.min(l.from + Math.max(column - 1, 0), l.to);
        v.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true });
        v.focus();
      },
    }),
    [],
  );

  return <div ref={host} className="h-full min-h-0" />;
}
