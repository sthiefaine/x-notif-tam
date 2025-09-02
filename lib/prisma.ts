import { PrismaClient } from '@prisma/client'

// PrismaClient est attaché au scope global en développement pour éviter
// d'épuiser les connexions de la base de données pendant le rechargement à chaud
const globalForPrisma = global as unknown as {
  prisma: PrismaClient | undefined;
};

const createPrismaClient = () => new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// Ensure connection is established
export async function ensurePrismaConnection() {
  try {
    await prisma.$connect();
    console.log('Prisma connection established successfully');
  } catch (error) {
    console.error('Failed to connect to Prisma:', error);
    // Retry once after a short delay
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      await prisma.$connect();
      console.log('Prisma connection established on retry');
    } catch (retryError) {
      console.error('Failed to connect to Prisma on retry:', retryError);
      throw retryError;
    }
  }
}

// Graceful shutdown function
export async function disconnectPrisma() {
  try {
    await prisma.$disconnect();
    console.log('Prisma disconnected gracefully');
  } catch (error) {
    console.error('Error disconnecting Prisma:', error);
  }
}