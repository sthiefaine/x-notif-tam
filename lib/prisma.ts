import { PrismaClient } from '@prisma/client'

// PrismaClient est attaché au scope global en développement pour éviter
// d'épuiser les connexions de la base de données pendant le rechargement à chaud
const globalForPrisma = global as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;