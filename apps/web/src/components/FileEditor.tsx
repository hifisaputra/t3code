import { LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import CodeMirror, { EditorView, type Extension } from "@uiw/react-codemirror";
import { useEffect, useMemo, useState } from "react";

// Match the read-only viewer's compact monospace presentation and let the
// editor fill its flex slot (it manages its own internal scrolling).
const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "12px" },
});

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

// Extensions that @codemirror/language-data doesn't map but which we want
// highlighted as a known language (key: lowercase extension, value: the
// LanguageDescription name to fall back to). JSONC has no dedicated grammar,
// so it reuses the JSON mode.
const EXTENSION_OVERRIDES: Record<string, string> = {
  jsonc: "JSON",
};

function resolveLanguage(path: string): LanguageDescription | null {
  const filename = basenameOf(path);
  const matched = LanguageDescription.matchFilename(languages, filename);
  if (matched) {
    return matched;
  }
  const name = EXTENSION_OVERRIDES[extensionOf(filename)];
  return name ? LanguageDescription.matchLanguageName(languages, name) : null;
}

export default function FileEditor(props: {
  value: string;
  filePath: string;
  theme: "light" | "dark";
  onChange: (value: string) => void;
}) {
  const { value, filePath, theme, onChange } = props;
  const [language, setLanguage] = useState<LanguageSupport | null>(null);

  // Resolve the language for this file and load it on demand. Each language
  // mode in @codemirror/language-data is a separately code-split dynamic
  // import, so only the modes the user actually opens are downloaded.
  useEffect(() => {
    let cancelled = false;
    setLanguage(null);
    const description = resolveLanguage(filePath);
    if (!description) {
      return;
    }
    description
      .load()
      .then((support) => {
        if (!cancelled) {
          setLanguage(support);
        }
      })
      .catch(() => {
        // Highlighting is best-effort; the file still edits fine as plain text.
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const extensions = useMemo<Extension[]>(
    () => (language ? [editorTheme, language] : [editorTheme]),
    [language],
  );

  return (
    <CodeMirror
      value={value}
      theme={theme}
      extensions={extensions}
      onChange={onChange}
      height="100%"
      className="h-full"
    />
  );
}
