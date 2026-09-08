import fs from 'fs';
import path from 'path';

/**
 * expo-router turns every file under app/ into a route and imports it into the
 * app bundle. A test file colocated there is imported at runtime, where
 * `describe` and `expect` do not exist, and the whole app dies on a blank
 * screen with `ReferenceError: expect is not defined`.
 *
 * Jest is perfectly happy either way, so a green suite proves nothing here.
 * That is exactly why this check exists: it is the one thing the rest of the
 * suite structurally cannot catch.
 */

const APP_DIR = path.join(__dirname, '..', 'app');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const routeFiles = walk(APP_DIR);
const rel = (f: string) => path.relative(APP_DIR, f);

describe('the routes directory', () => {
  it('contains no test files', () => {
    const tests = routeFiles.filter((f) => /\.(test|spec)\.[jt]sx?$/.test(f));
    expect(tests.map(rel)).toEqual([]);
  });

  it('contains no snapshot or fixture directories', () => {
    const strays = routeFiles.filter((f) => /__(tests__|snapshots__|mocks__|fixtures__)__?/.test(f));
    expect(strays.map(rel)).toEqual([]);
  });

  it('holds only routable source files', () => {
    const allowed = /\.(tsx|ts|jsx|js)$/;
    const strays = routeFiles.filter((f) => !allowed.test(f));
    expect(strays.map(rel)).toEqual([]);
  });

  /** A route without a default export renders nothing and fails silently. */
  it('gives every screen a default export', () => {
    const screens = routeFiles.filter((f) => /\.tsx$/.test(f));
    const missing = screens.filter(
      (f) => !/export\s+default\s/.test(fs.readFileSync(f, 'utf8'))
    );
    expect(missing.map(rel)).toEqual([]);
  });

  it('still has the screens the entry flow depends on', () => {
    const names = routeFiles.map(rel);
    for (const required of [
      '_layout.tsx',
      'login.tsx',
      'batteries.tsx',
      path.join('(tabs)', '_layout.tsx'),
      path.join('(tabs)', 'index.tsx'),
      path.join('write', '[parameterKey].tsx'),
    ]) {
      expect(names).toContain(required);
    }
  });
});
