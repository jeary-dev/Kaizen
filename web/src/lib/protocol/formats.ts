/** Paths (protocol §7), apply codes (§9) and secret placeholders (§8). */

export const MAX_PATH_LENGTH = 512;
export const ALLOWED_EXTENSIONS = new Set(["yml", "yaml", "json", "properties", "toml", "conf", "txt"]);

export const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

const FORBIDDEN = /[\\:\u0000-\u001f\u007f-\u009f]/;

export function isValidPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  if (path.startsWith("/") || FORBIDDEN.test(path)) return false;
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return false;
  return ALLOWED_EXTENSIONS.has(extensionOf(segments[segments.length - 1]));
}

export const APPLY_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const APPLY_CODE_LENGTH = 8;
const APPLY_CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

export function normalizeApplyCode(input: string): string | null {
  let out = "";
  for (const c of input.toUpperCase()) {
    if (c === " " || c === "-") continue;
    out += c === "O" ? "0" : c === "I" || c === "L" ? "1" : c;
  }
  return APPLY_CODE.test(out) ? out : null;
}

export const displayApplyCode = (code: string): string => `${code.slice(0, 4)} ${code.slice(4)}`;

export const PLACEHOLDER_ID = /^KAIZEN_SECRET_[1-9][0-9]*_[a-z0-9]{4}$/;
export const PLACEHOLDER_ANY = /KAIZEN_SECRET_[1-9][0-9]*_[a-z0-9]{4}/g;

/** The placeholder tag (last 4 characters), or null if [id] is not a placeholder id. */
export const placeholderTag = (id: string): string | null => (PLACEHOLDER_ID.test(id) ? id.slice(-4) : null);

/**
 * Placeholders of one session, bounded so that `KAIZEN_SECRET_1_abcdX` or `xKAIZEN_SECRET_…` do not
 * count. Mirrors the plugin's `Redactor.placeholderPattern`, which is what decides on apply.
 */
export const placeholderPattern = (tag: string): RegExp =>
  new RegExp(`(?<![A-Za-z0-9_])KAIZEN_SECRET_[1-9][0-9]*_${tag.replace(/[^a-z0-9]/g, "")}(?![A-Za-z0-9_])`, "g");
