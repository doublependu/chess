// Warns before deploying a dirty tree: the version badge shows HEAD, not the uncommitted changes.
import { execSync } from 'node:child_process';

try {
  const status = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  const sha = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  if (status) {
    console.warn(`\n⚠  Working tree has uncommitted changes. The deployed version badge will read "v.${sha.slice(0, 4)}" (HEAD).\n`);
  } else {
    console.log(`Deploying v.${sha.slice(0, 4)}`);
  }
} catch {
  console.warn('⚠  Not a git checkout; version badge will read "v.dev0".');
}
