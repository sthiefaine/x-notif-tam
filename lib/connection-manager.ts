import { prisma } from './prisma';

class ConnectionManager {
  private static instance: ConnectionManager;
  private isConnected = false;
  private connectionPromise: Promise<void> | null = null;

  private constructor() {}

  static getInstance(): ConnectionManager {
    if (!ConnectionManager.instance) {
      ConnectionManager.instance = new ConnectionManager();
    }
    return ConnectionManager.instance;
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.establishConnection();
    return this.connectionPromise;
  }

  private async establishConnection(): Promise<void> {
    try {
      await prisma.$connect();
      this.isConnected = true;
      console.log('Database connection established');
    } catch (error) {
      console.error('Failed to establish database connection:', error);
      this.connectionPromise = null;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      await prisma.$disconnect();
      this.isConnected = false;
      this.connectionPromise = null;
      console.log('Database connection closed');
    } catch (error) {
      console.error('Error closing database connection:', error);
    }
  }

  isHealthy(): boolean {
    return this.isConnected;
  }
}

export const connectionManager = ConnectionManager.getInstance();