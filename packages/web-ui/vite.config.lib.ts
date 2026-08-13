import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/public.ts'),
      formats: ['es'],
      fileName: () => 'answer-engine-web.js',
    },
    outDir: 'dist/lib',
    rollupOptions: {
      external: [
        '@tanstack/react-query',
        'react',
        'react/jsx-runtime',
        'react-dom',
        'react-dom/client',
        'react-markdown',
        'react-router-dom',
        'remark-gfm',
      ],
    },
  },
});
