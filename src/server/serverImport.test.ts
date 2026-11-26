import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('server.ts import graph has no missing or extensionless runtime imports under Node 22', () => {
  const root = process.cwd();
  const visited = new Set<string>();
  const issues: Array<{ file: string; detail: string }> = [];
  const queue = [path.join(root, 'server.ts')];

  function resolveRel(fromFile: string, spec: string): string | null {
    const base = path.resolve(path.dirname(fromFile), spec);
    if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
    for (const ext of ['.ts', '.tsx', '.mts', '.mjs', '.js']) {
      if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) return base + ext;
    }
    return null;
  }

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const src = fs.readFileSync(file, 'utf8');
    const relFile = path.relative(root, file);

    const re = /^(?!\s*import\s+type\b)(?:import|export)\s+[^;]*?from\s+['\"](\.[^'\"]+)['\"]/gm;
    for (const m of src.matchAll(re)) {
      const spec = m[1];
      const resolved = resolveRel(file, spec);
      if (!/\.(ts|mts|mjs|js|cjs|json)$/.test(spec)) {
        issues.push({ file: relFile, detail: m[0] });
      }
      if (resolved) queue.push(resolved);
    }
  }

  assert.deepEqual(issues, [], `Found extensionless runtime imports in server import graph: ${JSON.stringify(issues)}`);
});
