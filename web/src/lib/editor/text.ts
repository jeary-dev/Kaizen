/**
 * Line endings. Kaizen writes back exactly the text the editor produces, so the editor must not
 * normalise CRLF files to LF (that would turn every line into a change).
 *
 * CodeMirror counts every line break as one character, whatever the separator. So validation runs
 * on the LF form (`doc.toString()`), where offsets line up with editor positions, and saving uses
 * the original separator.
 */

export type LineBreak = "\n" | "\r\n";

/**
 * The separator to give CodeMirror for [text]: CRLF only if every line break is CRLF. Mixed files
 * use LF, which keeps any stray `\r` as a visible character, so the bytes still round-trip.
 */
export function detectLineBreak(text: string): LineBreak {
  const crlf = text.split("\r\n").length - 1;
  if (crlf === 0) return "\n";
  const lf = text.split("\n").length - 1;
  return lf === crlf ? "\r\n" : "\n";
}

/** The text as CodeMirror will hold it, with LF line breaks. */
export const toEditorText = (text: string, lineBreak: LineBreak): string =>
  lineBreak === "\r\n" ? text.replaceAll("\r\n", "\n") : text;

/** Back to the file's own separator. */
export const fromEditorText = (text: string, lineBreak: LineBreak): string =>
  lineBreak === "\r\n" ? text.replaceAll("\n", "\r\n") : text;

/** 1-based line and column of an offset, for messages. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let start = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      start = i + 1;
    }
  }
  return { line, column: offset - start + 1 };
}
