import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  srcDir: './frontend',
  publicDir: './public',
  output: 'server',
  adapter: node({ mode: 'middleware' }),
  server: { host: true }
});
