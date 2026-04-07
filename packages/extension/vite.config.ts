import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { writeFileSync, copyFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'fs';

/**
 * Post-build plugin: copies manifest, icons, and inlines shared chunks
 * into the content script so it works without ES module support.
 */
function copyManifestPlugin() {
  return {
    name: 'copy-manifest',
    writeBundle() {
      const distDir = resolve(__dirname, 'dist');

      // ---- Inline shared chunks into content script ----
      // Chrome content scripts don't reliably support "type": "module",
      // so we inline the small shared chunks and wrap as IIFE.
      const contentPath = resolve(distDir, 'src/content/index.js');
      let contentCode = readFileSync(contentPath, 'utf-8');

      // Find all static import statements: import{X as Y}from"../../assets/file.js";
      const importRegex = /import\{([^}]+)\}from"([^"]+)";/g;
      const imports: Array<{ full: string; bindings: string; path: string }> = [];
      let m: RegExpExecArray | null;
      while ((m = importRegex.exec(contentCode)) !== null) {
        imports.push({ full: m[0], bindings: m[1], path: m[2] });
      }

      for (const imp of imports) {
        const chunkPath = resolve(distDir, 'src/content', imp.path);
        if (!existsSync(chunkPath)) continue;

        let chunkCode = readFileSync(chunkPath, 'utf-8');
        // Strip export statement: export{X as Y}; or export{X};
        chunkCode = chunkCode.replace(/export\{[^}]+\};?\s*$/, '');

        // Parse import bindings: "S as E" or "A as f" or just "S"
        const bindingParts = imp.bindings.split(',').map(b => b.trim());
        for (const binding of bindingParts) {
          const parts = binding.split(/\s+as\s+/);
          const exported = parts[0].trim();
          const local = (parts[1] || exported).trim();
          if (exported !== local) {
            // Rename the exported var to match the local alias
            // e.g. chunk has "var R=..." and import says "S as E", but export says "R as S"
            // We need to find what var name in the chunk maps to exported name
            // The export line was: export{R as S} → so R is the actual var, S is the export name
            // Import says: import{S as E} → S is the export name, E is the local name
            // So we need R → E
            // But we already stripped the export. We need to find the mapping.
            // Since these are simple enum chunks, the pattern is:
            //   var R=(...)(R||{}); export{R as S};
            // After stripping export: var R=(...)(R||{});
            // We need to add: var E = R; (or just alias)
            chunkCode += `\nvar ${local} = ${exported};`;
          }
        }

        // Remove the import statement from content script
        contentCode = contentCode.replace(imp.full, '');
      }

      // Re-read chunks, wrap each in its own IIFE to prevent var collisions,
      // and expose only the needed exports via a unique global namespace.
      let finalPreamble = '';
      let chunkIdx = 0;
      for (const imp of imports) {
        const chunkPath = resolve(distDir, 'src/content', imp.path);
        if (!existsSync(chunkPath)) continue;

        let chunkCode = readFileSync(chunkPath, 'utf-8');
        const nsName = `__ab_chunk${chunkIdx++}`;

        // Parse the export: export{R as S}
        const exportMatch = chunkCode.match(/export\{([^}]+)\}/);
        const exportMap: Record<string, string> = {}; // exportName → localVar
        if (exportMatch) {
          for (const part of exportMatch[1].split(',')) {
            const pieces = part.trim().split(/\s+as\s+/);
            const localVar = pieces[0].trim();
            const exportName = (pieces[1] || localVar).trim();
            exportMap[exportName] = localVar;
          }
        }

        // Strip export
        chunkCode = chunkCode.replace(/export\{[^}]+\};?\s*$/, '');

        // Build return object with exported values
        const exportEntries = Object.entries(exportMap);
        const returnObj = exportEntries.map(([expName, localVar]) => `${expName}:${localVar}`).join(',');

        // Wrap chunk in IIFE that returns exports via a namespace object
        finalPreamble += `var ${nsName}=(function(){${chunkCode};return{${returnObj}}})();\n`;

        // Create aliases: map import bindings to namespace properties
        const bindingParts = imp.bindings.split(',').map(b => b.trim());
        for (const binding of bindingParts) {
          const parts = binding.split(/\s+as\s+/);
          const importedName = parts[0].trim();
          const localName = (parts[1] || importedName).trim();
          finalPreamble += `var ${localName}=${nsName}.${importedName};\n`;
        }
      }

      // Remove import lines and prepend inlined code
      for (const imp of imports) {
        contentCode = contentCode.replace(imp.full, '');
      }
      contentCode = finalPreamble + contentCode;

      // Wrap in IIFE to avoid polluting global scope
      contentCode = `(function(){\n${contentCode}\n})();`;

      writeFileSync(contentPath, contentCode);

      // ---- Write manifest (NO type:module for content scripts) ----
      const manifest = JSON.parse(
        readFileSync(resolve(__dirname, 'manifest.json'), 'utf-8'),
      );

      manifest.background.service_worker = 'src/background/index.js';
      manifest.content_scripts[0].js = ['src/content/index.js'];
      manifest.content_scripts[0].css = ['src/content/styles.css'];
      // Do NOT set type:module — content script is now self-contained IIFE
      delete manifest.content_scripts[0].type;
      manifest.action.default_popup = 'src/popup/index.html';
      manifest.side_panel.default_path = 'src/sidepanel/index.html';

      writeFileSync(
        resolve(distDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
      );

      // ---- Copy icons ----
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
