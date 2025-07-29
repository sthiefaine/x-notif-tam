import { PrismaClient } from '@prisma/client'

// PrismaClient est attaché au scope global en développement pour éviter
// d'épuiser les connexions de la base de données pendant le rechargement à chaud
const globalForPrisma = global as unknown as {
  prisma: PrismaClient | undefined;
};

const createPrismaClient = () => new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// Ensure connection is established
export async function ensurePrismaConnection() {
  try {
    await prisma.$connect();
  } catch (error) {
    console.error('Failed to connect to Prisma:', error);
    throw error;
  }
}