import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from "@codemirror/language";
import { type Diagnostic, linter, lintGutter, lintKeymap } from "@codemirror/lint";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { validate, type ValidationContext } from "@/lib/editor/validate";
import type { Lang } from "@/lib/protocol/payload";
import { languageFor } from "./languages";
import { lockedSecrets } from "./secrets";
import { sakuraTheme } from "./theme";

export interface FileSetup {
  /** LF line breaks; see text.ts. */
  text: string;
  lang: Lang;
  validation: ValidationContext;
  secretKeys: ReadonlyMap<string, string>;
  onChange?: (state: EditorState) => void;
  /** The page's CSP nonce, so CodeMirror's injected <style> elements are allowed. */
  nonce?: string;
}

/**
 * Everything a file's EditorState needs. One state per open file keeps undo history per tab.
 */
export function createFileState({ text, lang, validation, secretKeys, onChange, nonce }: FileSetup): EditorState {
  const extensions: Extension[] = [
    lineNumbers(),
    foldGutter({ markerDOM: foldMarker }),
    lintGutter(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    // YAML forbids tab indentation, so Tab inserts spaces everywhere for consistency.
    indentUnit.of(lang === "yaml" ? "  " : "    "),
    EditorState.tabSize.of(lang === "yaml" ? 2 : 4),
    // The text arrives with LF breaks (CRLF files are converted in text.ts and back on save).
    // Splitting on LF only keeps a stray CR in mixed files as a visible character.
    EditorState.lineSeparator.of("\n"),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...lintKeymap, indentWithTab]),
    languageFor(lang),
    linter(
      (view): Diagnostic[] =>
        validate(lang, view.state.doc.toString(), validation).map((p) => ({ from: p.from, to: p.to, severity: p.severity, message: p.message })),
      { delay: 300 },
    ),
    sakuraTheme,
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ "aria-label": "File contents", spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
  ];
  if (nonce) extensions.push(EditorView.cspNonce.of(nonce));
  if (validation.placeholderTag) extensions.push(lockedSecrets(validation.placeholderTag, secretKeys));
  if (onChange) extensions.push(EditorView.updateListener.of((u) => u.docChanged && onChange(u.state)));
  return EditorState.create({ doc: text, extensions });
}

/** Read-only setup for the side-by-side review. */
export function reviewExtensions(lang: Lang, nonce: string | undefined): Extension[] {
  return [
    lineNumbers(),
    highlightSpecialChars(),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorState.lineSeparator.of("\n"),
    languageFor(lang),
    sakuraTheme,
    EditorView.lineWrapping,
    ...(nonce ? [EditorView.cspNonce.of(nonce)] : []),
  ];
}

function foldMarker(open: boolean): HTMLElement {
  const el = document.createElement("span");
  el.textContent = open ? "▾" : "▸";
  el.className = "cm-kz-fold";
  el.setAttribute("aria-hidden", "true");
  return el;
}
