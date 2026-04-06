import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { writeFileSync, copyFileSync, mkdirSync, existsSync, readFileSync } from 'fs';

function copyManifestPlugin() {
  return {
    name: 'copy-manifest',
    writeBundle() {
      const distDir = resolve(__dirname, 'dist');

      // Read and transform manifest.json
      const manifest = JSON.parse(
        readFileSync(resolve(__dirname, 'manifest.json'), 'utf-8'),
      );

      // Fix paths: .ts → .js for built output
      manifest.background.service_worker = 'src/background/index.js';
      manifest.content_scripts[0].js = ['src/content/index.js'];
      manifest.content_scripts[0].css = ['src/content/styles.css'];
      manifest.action.default_popup = 'src/popup/index.html';
      manifest.side_panel.default_path = 'src/sidepanel/index.html';

      writeFileSync(
        resolve(distDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
      );

      // Copy icons directory
      const iconsDir = resolve(distDir, 'icons');
      if (!existsSync(iconsDir)) {
        mkdirSync(iconsDir, { recursive: true });
      }
      const srcIcons = resolve(__dirname, 'public/icons');
      if (existsSync(srcIcons)) {
        for (const size of ['icon16.png', 'icon48.png', 'icon128.png']) {
          const srcPath = resolve(srcIcons, size);
          if (existsSync(srcPath)) {
            copyFileSync(srcPath, resolve(iconsDir, size));
          }
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), copyManifestPlugin()],
  base: '',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
        popup: resolve(__dirname, 'src/popup/index.html'),
        sidepanel: resolve(__dirname, 'src/sidepanel/index.html'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') return 'src/background/index.js';
          if (chunkInfo.name === 'content') return 'src/content/index.js';
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.css')) {
            return 'src/content/styles.css';
          }
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
