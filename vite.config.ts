import { defineConfig } from 'vite'

export default defineConfig({
  // Two apps, one project: the child's board (index.html) and the parents' phone app (phone.html).
  build: {
    rollupOptions: {
      input: { main: 'index.html', phone: 'phone.html' },
    },
  },
  // During development (npm run dev), send /api requests on to the relay server (npm run server),
  // so the page and the server look like one website, just like after deployment.
  server: {
    proxy: { '/api': 'http://localhost:8787' },
  },
})
