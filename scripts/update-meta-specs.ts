// Regenera el snapshot de nombres de campo desde las specs oficiales de Meta
// (facebook/facebook-business-sdk-codegen, api_specs). Ejecutar al cambiar META_API_VERSION.
import { writeFileSync } from 'node:fs';
import { META_API_VERSION } from '../src/modules/meta/client.ts';
import { FIELDS } from '../src/modules/meta/fields.ts';

const REPO = 'facebook/facebook-business-sdk-codegen';
const commit = (await (
  await fetch(`https://api.github.com/repos/${REPO}/commits/main`)
).json()) as {
  sha?: string;
};
if (!commit.sha) throw new Error('No se pudo leer el último commit de las specs');

const objects: Record<string, string[]> = {};
for (const name of Object.keys(FIELDS)) {
  const res = await fetch(
    `https://raw.githubusercontent.com/${REPO}/${commit.sha}/api_specs/specs/${name}.json`,
  );
  if (!res.ok) throw new Error(`Spec ${name}: HTTP ${res.status}`);
  const spec = (await res.json()) as { fields?: { name: string }[] };
  objects[name] = (spec.fields ?? []).map((f) => f.name).sort();
}

const out = new URL(`../src/modules/meta/spec-fields.${META_API_VERSION}.json`, import.meta.url);
writeFileSync(out, `${JSON.stringify({ source: `${REPO}@${commit.sha}`, objects }, null, 2)}\n`);
console.log(`Snapshot escrito: ${out.pathname} (${commit.sha})`);
