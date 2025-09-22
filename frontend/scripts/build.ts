import tailwind from 'bun-plugin-tailwind';

const baseHref = process.env.BASE_PATH && process.env.BASE_PATH !== '/' ? `${process.env.BASE_PATH}/` : '/';

const result = await Bun.build({
  entrypoints: ['./index.html'],
  outdir: './dist',
  minify: process.env.NODE_ENV === 'production',
  target: 'browser',
  plugins: [tailwind],
  sourcemap: process.env.NODE_ENV === 'production' ? false : 'inline',
  define: {
    __BASE_HREF__: JSON.stringify(baseHref)
  }
});

if (!result.success) {
  console.error('❌ Bun.build failed');
  for (const message of result.logs ?? []) {
    console.error(message);
  }
  process.exit(1);
}

console.log(`✅ Bundled ${result.outputs.length} file(s) to dist/`);
