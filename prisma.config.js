// Prisma 7 yapılandırması – bağlantı adresi .env içindeki DATABASE_URL'den okunur
import { defineConfig } from 'prisma/config'

try {
  process.loadEnvFile()
} catch {
  /* .env yoksa ortam değişkenleri kullanılır */
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node --env-file-if-exists=.env prisma/seed.js',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
})
