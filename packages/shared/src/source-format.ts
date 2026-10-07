// Recognize pasted config containers before looking for embedded subscription URLs.
// Keep this inexpensive hint shared by the form and ingest dispatcher; validation
// and conversion belong to the server's single-node parser.
export function isNodeConfigText(value: string): boolean {
  const text = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return false;
  if (/^\s*\[(?:Interface|Peer)\]/m.test(text)) return false;
  // YAML can put comments, directives and a document marker before a flow map.
  const firstContent =
    text
      .split(/\r?\n/)
      .find((line) => {
        const trimmed = line.trim();
        return (
          trimmed !== "" &&
          !trimmed.startsWith("#") &&
          !/^---(?:\s+#.*)?$/.test(trimmed) &&
          !/^%(?:YAML|TAG)\b/.test(trimmed)
        );
      })
      ?.trim()
      .replace(/^---\s+/, "") ?? "";
  return (
    /^[{[]/.test(firstContent) ||
    /^[ \t]*(?:-[ \t]+)?["']?(?:proxies|outbounds|protocol|type|server|name)["']?\s*:/m.test(text)
  );
}
