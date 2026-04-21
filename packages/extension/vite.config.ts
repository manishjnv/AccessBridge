import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { writeFileSync, copyFileSync, mkdirSync, existsSync, readFileSync, readdirSync, unlinkSync } from 'fs';

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
      // so we recursively inline every chunk reachable from the content script
      // (including chunk→chunk imports) and wrap each in its own IIFE-namespace
      // to prevent var-collisions (RCA BUG-008) and nested-import syntax errors
      // (Session 10 regression when @accessbridge/core split across chunks).
      const contentPath = resolve(distDir, 'src/content/index.js');
      let contentCode = readFileSync(contentPath, 'utf-8');

      const importRegex = /import\{([^}]+)\}from"([^"]+)";/g;

      interface ChunkInfo {
        absPath: string;
        nsName: string;
        body: string;                  // with imports + exports stripped
        exports: Record<string, string>;  // exportedName → localVarName
        deps: Array<{ bindings: string; path: string; absPath: string }>;
      }

      const chunks = new Map<string, ChunkInfo>();

      function loadChunk(absPath: string): ChunkInfo | null {
        if (chunks.has(absPath)) return chunks.get(absPath) as ChunkInfo;
        if (!existsSync(absPath)) return null;
        let code = readFileSync(absPath, 'utf-8');
        const chunkDir = resolve(absPath, '..');

        // Collect nested imports inside this chunk.
        const deps: ChunkInfo['deps'] = [];
        let dm: RegExpExecArray | null;
        const depRe = /import\{([^}]+)\}from"([^"]+)";/g;
        while ((dm = depRe.exec(code)) !== null) {
          deps.push({
            bindings: dm[1],
            path: dm[2],
            absPath: resolve(chunkDir, dm[2]),
          });
        }

        // Strip all nested import statements — they'll be replaced by alias lines
        // injected into the IIFE body.
        code = code.replace(/import\{[^}]+\}from"[^"]+";/g, '');

        // Parse the chunk's export clause.
        const exportMap: Record<string, string> = {};
        const exportMatch = code.match(/export\{([^}]+)\};?\s*$/);
        if (exportMatch) {
          for (const part of exportMatch[1].split(',')) {
            const pieces = part.trim().split(/\s+as\s+/);
            const localVar = pieces[0].trim();
            const exportName = (pieces[1] || localVar).trim();
            exportMap[exportName] = localVar;
          }
        }
        code = code.replace(/export\{[^}]+\};?\s*$/, '');

        const info: ChunkInfo = {
          absPath,
          nsName: `__ab_chunk${chunks.size}`,
          body: code,
          exports: exportMap,
          deps,
        };
        chunks.set(absPath, info);

        // Recurse into dependencies so they're loaded too.
        for (const dep of deps) loadChunk(dep.absPath);
        return info;
      }

      // Discover top-level imports from the content script itself.
      const topImports: Array<{ full: string; bindings: string; path: string; absPath: string }> = [];
      const contentDir = resolve(distDir, 'src/content');
      let tm: RegExpExecArray | null;
      while ((tm = importRegex.exec(contentCode)) !== null) {
        const absPath = resolve(contentDir, tm[2]);
        topImports.push({ full: tm[0], bindings: tm[1], path: tm[2], absPath });
        loadChunk(absPath);
      }

      // Topologically order chunks: every chunk must appear after its dependencies,
      // so the `__ab_chunkN.export` aliases it depends on are already declared.
      const order: ChunkInfo[] = [];
      const seen = new Set<string>();
      function visit(info: ChunkInfo): void {
        if (seen.has(info.absPath)) return;
        seen.add(info.absPath);
        for (const dep of info.deps) {
          const depInfo = chunks.get(dep.absPath);
          if (depInfo) visit(depInfo);
        }
        order.push(info);
      }
      for (const info of chunks.values()) visit(info);

      // Emit each chunk as an IIFE that returns its exports as a namespace object.
      // Inside the IIFE, alias lines bind this chunk's dep imports to the already-
      // declared namespaces of dependency chunks.
      let finalPreamble = '';
      for (const info of order) {
        let aliasBlock = '';
        for (const dep of info.deps) {
          const depInfo = chunks.get(dep.absPath);
          if (!depInfo) continue;
          for (const binding of dep.bindings.split(',').map((b) => b.trim())) {
            const pieces = binding.split(/\s+as\s+/);
            const importedName = pieces[0].trim();
            const localName = (pieces[1] || importedName).trim();
            aliasBlock += `var ${localName}=${depInfo.nsName}.${importedName};`;
          }
        }
        const returnObj = Object.entries(info.exports)
          .map(([expName, localVar]) => `${expName}:${localVar}`)
          .join(',');
        finalPreamble += `var ${info.nsName}=(function(){${aliasBlock}${info.body};return{${returnObj}}})();\n`;
      }

      // Bind top-level import names to their corresponding chunk namespaces so the
      // content-script body compiles unchanged.
      for (const imp of topImports) {
        const info = chunks.get(imp.absPath);
        if (!info) continue;
        for (const binding of imp.bindings.split(',').map((b) => b.trim())) {
          const pieces = binding.split(/\s+as\s+/);
          const importedName = pieces[0].trim();
          const localName = (pieces[1] || importedName).trim();
          finalPreamble += `var ${localName}=${info.nsName}.${importedName};\n`;
        }
      }

      // Remove top-level imports from the content script body.
      for (const imp of topImports) {
        contentCode = contentCode.replace(imp.full, '');
      }
      contentCode = finalPreamble + contentCode;

      // Wrap the whole thing in an outer IIFE to avoid polluting the page's globals.
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

      // ---- Copy bundled ONNX models (Tier 0) ----
      // Session 14: the struggle-classifier ships with the extension so
      // Tier 0 inference needs zero network access. The file lives in
      // public/models/ and is mirrored to dist/models/ here.
      const srcModels = resolve(__dirname, 'public/models');
      if (existsSync(srcModels)) {
        const modelsDir = resolve(distDir, 'models');
        mkdirSync(modelsDir, { recursive: true });
        for (const entry of readdirSync(srcModels)) {
          copyFileSync(resolve(srcModels, entry), resolve(modelsDir, entry));
        }
      }

      // ---- Copy onnxruntime-web WASM + glue ----
      // Session 14: ort-wasm-simd-threaded.{wasm,mjs} are pulled straight from
      // the pnpm-resolved onnxruntime-web dist and placed at dist/ort/. The
      // runtime sets env.wasm.wasmPaths = chrome.runtime.getURL('ort/') so
      // InferenceSession.create() fetches the WASM from our own origin — no
      // jsdelivr CDN, no CSP violation.
      const ortSrc = resolve(
        __dirname,
        '..',
        'onnx-runtime',
        'node_modules',
        'onnxruntime-web',
        'dist',
      );
      if (existsSync(ortSrc)) {
        const ortDir = resolve(distDir, 'ort');
        mkdirSync(ortDir, { recursive: true });
        for (const entry of [
          'ort-wasm-simd-threaded.wasm',
          'ort-wasm-simd-threaded.mjs',
        ]) {
          const srcPath = resolve(ortSrc, entry);
          if (existsSync(srcPath)) {
            copyFileSync(srcPath, resolve(ortDir, entry));
          }
        }
      }

      // ---- Copy axe-core bundle ----
      // Session 18: axe-core is loaded into the active tab's MAIN world via a
      // <script src="chrome-extension://.../axe.min.js"> tag when the sidepanel
      // audit runs. The file is listed under manifest web_accessible_resources
      // so page origins can fetch it. The content-script bundle itself does NOT
      // import axe-core — keeping that bundle lean + BUG-008/012 safe.
      const axeSrc = resolve(
        __dirname,
        'node_modules',
        'axe-core',
        'axe.min.js',
      );
      if (existsSync(axeSrc)) {
        copyFileSync(axeSrc, resolve(distDir, 'axe.min.js'));
      }

      // ---- Strip rollup-auto-emitted ort-wasm copies ----
      // onnxruntime-web contains `new URL('./ort-wasm-simd-threaded.wasm',
      // import.meta.url)` patterns which vite rewrites into asset emissions
      // under dist/assets/. We don't want the 12 MB duplicate — our own
      // copy under dist/ort/ is the canonical one that env.wasm.wasmPaths
      // points at. Drop the extra.
      const assetsDir = resolve(distDir, 'assets');
      if (existsSync(assetsDir)) {
        for (const entry of readdirSync(assetsDir)) {
          if (/^ort-wasm-simd-threaded.*\.wasm$/.test(entry)) {
            unlinkSync(resolve(assetsDir, entry));
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
      // Session 14 — onnxruntime-web is now bundled into the service-worker
      // build. vite/rollup pulls in ort.min.mjs (~360 KB of JS glue). The
      // ~12 MB WASM binary lives in dist/ort/ (copied by copyManifestPlugin)
      // and is fetched at InferenceSession.create time via
      // env.wasm.wasmPaths — NOT embedded in the JS bundle.
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
