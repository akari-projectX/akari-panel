// The mail template source editor: CodeMirror 6 (loaded only by the mail
// template page, as its own chunk — the page imports this module lazily).
// Line numbers, HTML highlighting (source mode), `{placeholder}` marks
// (unknown ones with a red squiggle) and error-line backgrounds, themed
// with the app's colour tokens (CSS variables, so light and dark follow
// the <html> class). Controlled: `value` in, `onChange` out; the parent
// inserts placeholders at the cursor through `handle`.
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { html } from "@codemirror/lang-html";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { EditorSelection, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { placeholdersIn } from "./check";

export type EditorHandle = {
  /** Replace the selection with `text` and focus the editor. */
  insert: (text: string) => void;
  /** Put the cursor at the start of a 1-based line and scroll there. */
  gotoLine: (line: number, column?: number) => void;
};

type Marks = { allowed: ReadonlySet<string>; lines: readonly number[] };
const setMarks = StateEffect.define<Marks>();
const marksField = StateField.define<Marks>({
  create: () => ({ allowed: new Set(), lines: [] }),
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(setMarks) ? e.value : acc), v),
});

const known = Decoration.mark({ class: "cm-ph" });
const unknown = Decoration.mark({ class: "cm-ph-bad", attributes: { "aria-invalid": "true" } });
const errLine = Decoration.line({ class: "cm-err-line" });

function decorate(state: EditorState): DecorationSet {
  const { allowed, lines } = state.field(marksField);
  const doc = state.doc;
  const ranges = placeholdersIn(doc.toString()).map((p) => (allowed.has(p.name) ? known : unknown).range(p.from, p.to));
  for (const n of lines) if (n >= 1 && n <= doc.lines) ranges.push(errLine.range(doc.line(n).from));
  return Decoration.set(ranges, true);
}

const marksPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view.state);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.startState.field(marksField) !== u.state.field(marksField))
        this.decorations = decorate(u.state);
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
  ".cm-ph-bad": {
    backgroundColor: "var(--destructive-soft)",
    color: "var(--destructive)",
    borderRadius: "4px",
    textDecoration: "underline wavy var(--destructive)",
    textUnderlineOffset: "3px",
  },
  ".cm-err-line": { backgroundColor: "var(--destructive-soft)" },
});

const highlight = HighlightStyle.define([
  { tag: [t.tagName, t.angleBracket], color: "var(--chart-2)" },
  { tag: t.attributeName, color: "var(--chart-7)" },
  { tag: [t.attributeValue, t.string], color: "var(--chart-3)" },
  { tag: [t.propertyName, t.keyword], color: "var(--chart-1)" },
  { tag: [t.number, t.unit], color: "var(--chart-4)" },
  { tag: t.comment, color: "var(--faint)", fontStyle: "italic" },
  { tag: [t.documentMeta, t.processingInstruction], color: "var(--muted-foreground)" },
]);

export default function CodeEditor({
  value,
  onChange,
  language,
  label,
  allowed,
  errorLines,
  onFocus,
  onSave,
  handle,
}: {
  value: string;
  onChange: (v: string) => void;
  language: "html" | "text";
  /** Accessible name of the text box. */
  label: string;
  allowed: readonly string[];
  errorLines: readonly number[];
  onFocus?: () => void;
  onSave?: () => void;
  handle?: Ref<EditorHandle>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onFocus, onSave });
  // Documents this editor reported (newest last): a render that still
  // carries one of them is the parent catching up with typing, not an
  // outside change (on a slow device it can land after the next keystroke
  // and would otherwise put the older text back).
  const sent = useRef<string[]>([]);
  useEffect(() => {
    cb.current = { onChange, onFocus, onSave };
  });

  // Create once per mount (the parent remounts for another document).
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
      syntaxHighlighting(highlight),
      theme,
      marksField,
      marksPlugin,
      EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false" }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          const doc = u.state.doc.toString();
          sent.current = [...sent.current.slice(-19), doc];
          cb.current.onChange(doc);
        }
        if (u.focusChanged && u.view.hasFocus) cb.current.onFocus?.();
      }),
    ];
    if (language === "html") exts.push(html());
    else exts.push(EditorView.lineWrapping);
    const v = new EditorView({ parent: host.current!, state: EditorState.create({ doc: value, extensions: exts }) });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Outside changes (a reset, a loaded starting point) replace the document.
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === value || sent.current.includes(value)) return;
    sent.current = [];
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: setMarks.of({ allowed: new Set(allowed), lines: errorLines }) });
  }, [allowed, errorLines]);

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
