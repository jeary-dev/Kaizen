import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { StreamLanguage } from "@codemirror/language";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import type { Extension } from "@codemirror/state";
import type { Lang } from "@/lib/protocol/payload";

const propertiesLanguage = StreamLanguage.define(properties);
const tomlLanguage = StreamLanguage.define(toml);

/** Syntax highlighting for each file type. HOCON and plain text get none. */
export function languageFor(lang: Lang): Extension {
  switch (lang) {
    case "yaml":
      return yaml();
    case "json":
      return json();
    case "properties":
      return propertiesLanguage;
    case "toml":
      return tomlLanguage;
    default:
      return [];
  }
}

export const LANG_LABEL: Record<Lang, string> = {
  yaml: "YAML",
  json: "JSON",
  properties: "Properties",
  toml: "TOML",
  conf: "HOCON",
  text: "Text",
};
