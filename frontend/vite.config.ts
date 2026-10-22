import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// В разработке запросы к API проксируются на backend (uvicorn на :8000), как nginx в Docker.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8000',
      '/health': 'http://localhost:8000',
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Библиотеки меняются реже кода приложения — отдельные чанки дольше живут в кэше браузера.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router'],
          mantine: ['@mantine/core', '@mantine/hooks', '@mantine/notifications'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
});
