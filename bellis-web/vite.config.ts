import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from "vite-tsconfig-paths";
import { traeBadgePlugin } from 'vite-plugin-trae-solo-badge';
import fs from 'fs'
import path from 'path'

/** Vite 插件：将项目根目录的 data/ 目录作为 /data/ 静态资源提供 */
function serveDataDir(): Plugin {
  return {
    name: 'serve-data-dir',
    configureServer(server) {
      const dataRoot = path.resolve(__dirname, '..', 'data')
      server.middlewares.use('/data', (req, res, next) => {
        const filePath = path.join(dataRoot, req.url || '')
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath).toLowerCase()
          const mimeMap: Record<string, string> = {
            '.json': 'application/json',
            '.moc': 'application/octet-stream',
            '.moc3': 'application/octet-stream',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.mp3': 'audio/mpeg',
            '.wav': 'audio/wav',
            '.physic3.json': 'application/json',
          }
          res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream')
          res.setHeader('Access-Control-Allow-Origin', '*')
          fs.createReadStream(filePath).pipe(res)
        } else {
          next()
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  build: {
    sourcemap: 'hidden',
  },
  plugins: [
    react({
      babel: {
        plugins: [
          'react-dev-locator',
        ],
      },
    }),
    traeBadgePlugin({
      variant: 'dark',
      position: 'bottom-right',
      prodOnly: true,
      clickable: true,
      clickUrl: 'https://www.trae.ai/solo?showJoin=1',
      autoTheme: true,
      autoThemeTarget: '#root'
    }),
    tsconfigPaths(),
    serveDataDir(),
  ],
  server: {
    fs: {
      allow: ['..'],
    },
  },
})
