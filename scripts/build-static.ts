import { existsSync } from 'node:fs';
import { writeFile, rm, cp, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { $ } from 'bun';
import { canonicalQuestionnaire, FI_CANONICAL_URL, FI_VERSION } from '../src/questionnaire';

function normalizeBasePath(value?: string | null): string {
  if (!value) return '/';
  let path = value.trim();
  if (!path) return '/';
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/+$/g, '');
  return path === '' ? '/' : path;
}

const STATIC_BASE_PATH = normalizeBasePath(process.env.STATIC_BASE_PATH);
const STATIC_BASE_HREF = STATIC_BASE_PATH === '/' ? '/' : `${STATIC_BASE_PATH}/`;

console.log('[build-static] STATIC_BASE_PATH env:', process.env.STATIC_BASE_PATH ?? '<undefined>');
console.log('[build-static] Normalized STATIC_BASE_PATH:', STATIC_BASE_PATH);
console.log('[build-static] Derived STATIC_BASE_HREF:', STATIC_BASE_HREF);

async function runBuild() {
  const frontendDir = fileURLToPath(new URL('../frontend', import.meta.url));
  await $`bun install --silent`.cwd(frontendDir).env({ ...process.env });
  await $`bun run ./scripts/build.ts`.cwd(frontendDir).env({ ...process.env, NODE_ENV: 'production' });
}

async function updateBaseHref() {
  const distDir = fileURLToPath(new URL('../frontend/dist', import.meta.url));
  const indexPath = join(distDir, 'index.html');
  if (!existsSync(indexPath)) {
    throw new Error('Expected frontend/dist/index.html to exist after build.');
  }
  const html = await readFile(indexPath, 'utf8');
  const currentBaseMatch = html.match(/<base[^>]*href="([^"]*)"[^>]*>/i);
  console.log('[build-static] Found base href in frontend/dist/index.html:', currentBaseMatch?.[1] ?? '<missing>');
  const updated = html.replace('<base href="/" />', `<base href="${STATIC_BASE_HREF}" />`);
  if (updated === html) {
    console.warn('[build-static] No base href replacement occurred; check template.');
  } else {
    console.log('[build-static] Updated base href in frontend/dist/index.html to:', STATIC_BASE_HREF);
  }
  await writeFile(indexPath, updated);
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

  const finalIndex = await readFile(join(targetDir, 'index.html'), 'utf8');
  const finalBaseMatch = finalIndex.match(/<base[^>]*href="([^"]*)"[^>]*>/i);
  console.log('[build-static] dist-static/index.html base href:', finalBaseMatch?.[1] ?? '<missing>');
}

await runBuild();
await updateBaseHref();
await writeConfig();
await copyOutput();

console.log('Static build output available in dist-static/');
