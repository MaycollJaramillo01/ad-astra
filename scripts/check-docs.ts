// Comprueba enlaces relativos y anclas entre los documentos de docs/ (TD-05).
// Las anclas siguen el algoritmo de GitHub (github-slugger).
import { readdirSync, readFileSync } from 'node:fs';

const DIR = 'docs';

export function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replaceAll(' ', '-');
}

/** Devuelve las líneas fuera de bloques de código, con su número. */
function proseLines(text: string): Array<[number, string]> {
  let inCode = false;
  const out: Array<[number, string]> = [];
  text.split('\n').forEach((line, i) => {
    if (line.startsWith('```')) inCode = !inCode;
    else if (!inCode) out.push([i + 1, line]);
  });
  return out;
}

function anchors(text: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const [, line] of proseLines(text)) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (!m?.[1]) continue;
    const s = slug(m[1]);
    const n = seen.get(s) ?? 0;
    out.add(n === 0 ? s : `${s}-${n}`);
    seen.set(s, n + 1);
  }
  return out;
}

if (import.meta.main) {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.md'));
  const texts = new Map(files.map((f) => [f, readFileSync(`${DIR}/${f}`, 'utf8')]));
  const index = new Map([...texts].map(([f, t]) => [f, anchors(t)]));
  const errors: string[] = [];
  let links = 0;
  for (const [file, text] of texts) {
    for (const [no, line] of proseLines(text)) {
      for (const [, target] of line.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (!target || /^(https?:|mailto:)/.test(target)) continue;
        links++;
        const [name = '', anchor] = target.split('#');
        const doc = name || file;
        if (!index.has(doc)) errors.push(`${file}:${no}: no existe ${doc}`);
        else if (anchor && !index.get(doc)?.has(anchor))
          errors.push(`${file}:${no}: no existe #${anchor} en ${doc}`);
      }
    }
  }
  for (const e of errors) console.error(e);
  console.log(`${links} enlaces relativos en ${files.length} documentos, ${errors.length} errores`);
  process.exitCode = errors.length ? 1 : 0;
}
