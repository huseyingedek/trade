import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { config } from '../config.js'

const adapter = new PrismaPg({ connectionString: config.DATABASE_URL })

export const prisma = globalThis.__prisma ?? new PrismaClient({ adapter, log: ['warn', 'error'] })
if (config.NODE_ENV !== 'production') globalThis.__prisma = prisma
