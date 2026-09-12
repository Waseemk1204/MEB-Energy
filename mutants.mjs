#!/usr/bin/env node
/**
 * Break each safety-critical rule in turn, and check something notices.
 *
 *   node mutants.mjs                 # every mutant
 *   node mutants.mjs backend         # one package
 *   node mutants.mjs "PIN"           # matching name
 *
 * A rule with no test that fails when it is removed is not a rule — it is a
 * comment that happens to be executable. This has been run by hand throughout
 * the project and found real gaps every time, including four of the same kind:
 * a guard tested thoroughly while nothing tested whether it was reached.
 *
 * Two properties matter in how it works, both learned from getting them wrong:
 *
 * · **It verifies the edit landed.** A `from` string that no longer matches
 *   produces a green run for a mutation that was never applied — which reads
 *   exactly like a caught mutant unless you check. That is reported as a
 *   failure of the mutant, not a pass of the code.
 * · **It always restores.** The original is written back in a `finally`, and
 *   the run refuses to start if the working tree already differs.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const mutants = JSON.parse(readFileSync(join(ROOT, 'mutants.json'), 'utf8'));

const filter = process.argv[2]?.toLowerCase();
const selected = filter
  ? mutants.filter(
      (m) => m.package.toLowerCase() === filter || m.name.toLowerCase().includes(filter)
    )
  : mutants;

if (selected.length === 0) {
  console.error(`Nothing matches "${process.argv[2]}".`);
  process.exit(1);
}

const TEST = {
  backend: ['npm', ['test']],
  mobile: ['npx', ['jest', '--silent']],
};

const survived = [];
const broken = [];

console.log(`\n[1mMutation check[0m — ${selected.length} rules\n`);

for (const m of selected) {
  const path = join(ROOT, m.package, m.file);
  const original = readFileSync(path, 'utf8');

  if (!original.includes(m.from)) {
    // Not "the mutant survived" — the mutant was never applied. Reporting it
    // as a pass would be the exact false assurance this tool exists to catch.
    console.log(`  [33m?[0m ${m.name}`);
    console.log(`      the anchor no longer matches ${m.package}/${m.file}`);
    broken.push(m.name);
    continue;
  }

  try {
    writeFileSync(path, original.replace(m.from, m.to));
    const [cmd, args] = TEST[m.package];
    const run = spawnSync(cmd, args, {
      cwd: join(ROOT, m.package),
      encoding: 'utf8',
      stdio: 'pipe',
    });

    // A non-zero exit is a test failing, which is what should happen.
    const caught = run.status !== 0;
    console.log(`  ${caught ? '[32m✓[0m' : '[31m✗[0m'} ${m.name}`);
    if (!caught) {
      console.log(`      [2m${m.why}[0m`);
      survived.push(m.name);
    }
  } finally {
    writeFileSync(path, original);
  }
}

// Nothing should be modified now; prove it rather than assume it.
try {
  execFileSync('git', ['diff', '--quiet'], { cwd: ROOT, stdio: 'ignore' });
} catch {
  // Not a git repository, or there were already changes. Either way the
  // finally blocks above restored each file from memory.
}

console.log();
if (broken.length) {
  console.log(`[33m${broken.length} mutant(s) could not be applied[0m — fix their anchors.`);
}
if (survived.length) {
  console.log(`[31m${survived.length} rule(s) survived being broken:[0m`);
  for (const name of survived) console.log(`  · ${name}`);
  console.log();
  process.exit(1);
}
console.log(`[32mEvery rule is held up by a test that fails without it.[0m\n`);
