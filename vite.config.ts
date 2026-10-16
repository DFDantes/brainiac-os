import { defineConfig } from 'vitest/config';
export default defineConfig({ base: './', build: { target: 'safari14' }, test: { environment: 'node' } });
