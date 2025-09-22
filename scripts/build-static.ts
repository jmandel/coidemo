import { existsSync } from 'node:fs';
import { writeFile, rm, cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { $ } from 'bun';
import { canonicalQuestionnaire, FI_CANONICAL_URL, FI_VERSION } from '../src/questionnaire';

async function runBuild() {
  const frontendDir = fileURLToPath(new URL('../frontend', import.meta.url));
  await $`bun install --silent`.cwd(frontendDir).env({ ...process.env });
  await $`bun run ./scripts/build.ts`.cwd(frontendDir).env({ ...process.env, NODE_ENV: 'production' });
}

async function writeConfig() {
  const distDir = fileURLToPath(new URL('../frontend/dist', import.meta.url));
  if (!existsSync(distDir)) {
    throw new Error('Expected frontend/dist to exist after build.');
  }
  const config = {
    fhirBaseUrl: '',
    oidcIssuer: null,
    oidcClientId: null,
    oidcRedirectUri: null,
    mockAuth: process.env.MOCK_AUTH === 'true',
    staticMode: true,
    questionnaire: {
      url: FI_CANONICAL_URL,
      version: FI_VERSION
    },
    questionnaireResource: canonicalQuestionnaire
  } as const;

  const configPath = join(distDir, 'config.json');
  await writeFile(configPath, JSON.stringify(config, null, 2));
}

async function copyOutput() {
  const targetDir = fileURLToPath(new URL('../dist-static', import.meta.url));
  if (existsSync(targetDir)) {
    await rm(targetDir, { recursive: true, force: true });
  }

  const frontendDist = fileURLToPath(new URL('../frontend/dist', import.meta.url));
  await cp(frontendDist, targetDir, { recursive: true });

  const extraRoutes = ['form', 'history', 'submitted'];
  for (const route of extraRoutes) {
    const routeDir = join(targetDir, route);
    if (!existsSync(routeDir)) {
      await mkdir(routeDir, { recursive: true });
    }
    await cp(join(targetDir, 'index.html'), join(routeDir, 'index.html'), {
      recursive: true,
      force: true
    });
  }

  // Provide SPA fallbacks for GitHub Pages
  await cp(join(targetDir, 'index.html'), join(targetDir, '404.html'));
}

await runBuild();
await writeConfig();
await copyOutput();

console.log('Static build output available in dist-static/');
