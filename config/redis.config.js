const Redis = require('ioredis');

const redisConfig = {
  development: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB) || 0,
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    enableOfflineQueue: true,
    connectTimeout: 10000,
    lazyConnect: false,
  },
  
  production: {
    // For Upstash or other cloud Redis
    url: process.env.REDIS_URL,
    // OR
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB) || 0,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    retryStrategy: (times) => {
      if (times > 5) {
        return null; // Stop retrying after 5 attempts
      }
      return Math.min(times * 100, 3000);
    },
    maxRetriesPerRequest: 5,
    enableReadyCheck: true,
    enableOfflineQueue: true,
    connectTimeout: 15000,
  }
};

// Get current environment
const env = process.env.NODE_ENV || 'development';
const config = redisConfig[env];

// Create Redis client
let redisClient;
let subscriberClient;
let isRedisAvailable = false;

const createRedisClient = () => {
  try {
    // Main Redis client
    if (config.url) {
      redisClient = new Redis(config.url, {
        retryStrategy: config.retryStrategy,
        maxRetriesPerRequest: config.maxRetriesPerRequest,
        enableReadyCheck: config.enableReadyCheck,
        enableOfflineQueue: config.enableOfflineQueue,
        connectTimeout: config.connectTimeout,
      });
    } else {
      redisClient = new Redis(config);
    }

    // Subscriber client (for pub/sub)
    if (config.url) {
      subscriberClient = new Redis(config.url, {
        retryStrategy: config.retryStrategy,
      });
    } else {
      subscriberClient = new Redis(config);
    }

    // Event handlers
    redisClient.on('connect', () => {
      console.log('✅ Redis client connected');
      isRedisAvailable = true;
    });

    redisClient.on('ready', () => {
      console.log('✅ Redis client ready');
      isRedisAvailable = true;
    });

    redisClient.on('error', (err) => {
      console.error('❌ Redis client error:', err.message);
      isRedisAvailable = false;
    });

    redisClient.on('close', () => {
      console.log('⚠️  Redis client connection closed');
      isRedisAvailable = false;
    });

    redisClient.on('reconnecting', () => {
      console.log('🔄 Redis client reconnecting...');
    });

    subscriberClient.on('connect', () => {
      console.log('✅ Redis subscriber connected');
    });

    subscriberClient.on('error', (err) => {
      console.error('❌ Redis subscriber error:', err.message);
    });

    return { redisClient, subscriberClient };
  } catch (error) {
    console.error('❌ Failed to create Redis client:', error.message);
    isRedisAvailable = false;
    return { redisClient: null, subscriberClient: null };
  }
};

// Initialize clients
const clients = createRedisClient();
redisClient = clients.redisClient;
subscriberClient = clients.subscriberClient;

// Health check
const checkRedisHealth = async () => {
  try {
    if (!redisClient) return false;
    await redisClient.ping();
    isRedisAvailable = true;
    return true;
  } catch (error) {
    isRedisAvailable = false;
    return false;
  }
};

// Graceful shutdown
const closeRedisConnections = async () => {
  try {
    if (redisClient) {
      await redisClient.quit();
      console.log('✅ Redis client closed gracefully');
    }
    if (subscriberClient) {
      await subscriberClient.quit();
      console.log('✅ Redis subscriber closed gracefully');
    }
  } catch (error) {
    console.error('❌ Error closing Redis connections:', error.message);
  }
};

// Redis key prefixes (for organization)
const KEY_PREFIXES = {
  ROOM: 'room:',
  ROOMS_ACTIVE: 'rooms:active',
  ROOMS_WAITING: 'rooms:waiting',
  PLAYER: 'player:',
  PLAYER_SESSION: 'player:session:',
  MATCHMAKING_QUEUE: 'matchmaking:queue',
  LEADERBOARD_GLOBAL: 'leaderboard:global',
  LEADERBOARD_WEEKLY: 'leaderboard:weekly',
  ROOM_PLAYERS: 'room:players:',
  ROOM_EVENTS: 'room:events:',
  GAME_STATE: 'game:state:',
  USER_PRESENCE: 'presence:',
  ACHIEVEMENT_ALL: 'achievements:all',
  USER_ACHIEVEMENTS: 'user:achievements',
  ACHIEVEMENT: 'achievement'
};

// TTL configurations (in seconds)
const TTL = {
  ROOM_WAITING: 1800,      // .5 hour
  ROOM_PLAYING: 3600,      // 1 hours
  ROOM_FINISHED: 300,      // 5 minutes
  PLAYER_SESSION: 86400,   // 24 hours
  GAME_STATE: 7200,        // 2 hours
  MATCHMAKING_QUEUE: 600,  // 10 minutes
  USER_PRESENCE: 600,      // 5 minutes
  LONG: 3600,
  MEDIUM: 1800
};

module.exports = {
  redisClient,
  subscriberClient,
  createRedisClient,
  checkRedisHealth,
  closeRedisConnections,
  isRedisAvailable: () => isRedisAvailable,
  KEY_PREFIXES,
  TTL,
  config: config,
};