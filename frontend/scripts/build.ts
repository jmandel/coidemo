import tailwind from 'bun-plugin-tailwind';

const watch = process.argv.includes('--watch');

const result = await Bun.build({
  entrypoints: ['./index.html'],
  outdir: './dist',
  minify: !watch,
  target: 'browser',
  plugins: [tailwind],
  sourcemap: watch ? 'inline' : false,
  watch: watch
    ? {
        async onRebuild(err, buildResult) {
          if (err) {
            console.error('❌ Rebuild failed');
            for (const log of err.logs ?? []) {
              console.error(log);
            }
          } else {
            console.log(`🔁 Rebuilt ${buildResult.outputs.length} file(s)`);
          }
        }
      }
    : undefined
});

if (!result.success) {
  console.error('❌ Bun.build failed');
  for (const message of result.logs ?? []) {
    console.error(message);
  }
  process.exit(1);
}

console.log(`✅ Bundled ${result.outputs.length} file(s) to dist/`);

if (watch) {
  console.log('👀 Watching for changes...');
  await new Promise(() => {});
}
