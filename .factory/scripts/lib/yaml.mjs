// Reads the YAML subset factory.yml uses: nested maps, "- item" lists, scalars,
// and "|"/"|-" block scalars (multi-line stage commands). No flow style.

const scalar = (s) => {
  const t = s.trim();
  if (/^(".*"|'.*')$/.test(t)) return t.slice(1, -1);
  if (/^-?\d+$/.test(t)) return Number(t);
  if (t === "true") return true;
  if (t === "false") return false;
  return t;
};

export function parseYaml(text) {
  const lines = text.split("\n").map((l) => ({ indent: l.length - l.trimStart().length, raw: l, text: l.trim() }));
  let i = 0;
  const block = (indent) => {
    if (lines[i].text.startsWith("- ")) {
      const list = [];
      while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ")) {
        list.push(scalar(lines[i].text.slice(2)));
        i++;
      }
      return list;
    }
    const map = {};
    while (i < lines.length) {
      const line = lines[i];
      if (line.raw.trim() === "" || line.text.startsWith("#")) { i++; continue; }
      if (line.indent < indent) break;
      if (line.indent > indent) throw new Error(`yaml: unexpected indent at "${line.text}"`);
      const colon = line.text.indexOf(":");
      const key = line.text.slice(0, colon).trim();
      const rest = line.text.slice(colon + 1).trim();
      i++;
      if (rest === "|" || rest === "|-") {
        // Block scalar: following lines indented deeper than the key, blank lines kept.
        const parts = [];
        let base = -1;
        while (i < lines.length) {
          const l = lines[i];
          if (l.raw.trim() === "") { parts.push(""); i++; continue; }
          if (l.indent <= indent) break;
          if (base < 0) base = l.indent;
          parts.push(l.raw.slice(Math.min(base, l.indent)).trimEnd());
          i++;
        }
        while (parts.length && parts[parts.length - 1] === "") parts.pop();
        map[key] = parts.join("\n") + (rest === "|" ? "\n" : "");
      } else if (rest === "" && i < lines.length && lines[i].raw.trim() !== "" && lines[i].indent > indent) {
        map[key] = block(lines[i].indent);
      } else {
        map[key] = rest === "" ? "" : scalar(rest);
      }
    }
    return map;
  };
  while (i < lines.length && (lines[i].raw.trim() === "" || lines[i].text.startsWith("#"))) i++;
  return lines.length > i ? block(lines[i].indent) : {};
}
