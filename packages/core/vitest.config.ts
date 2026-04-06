import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    // Allow importing TypeScript source files with .js extensions
    // (ESM convention used throughout this package)
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
});
