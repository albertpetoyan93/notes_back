import logger from "jet-logger";
import { getPoller } from "../services/DBPoller";
import socketService from "../services/SocketManager";

interface HealthMetrics {
  timestamp: Date;
  system: {
    uptime: number;
    memory: {
      used: number;
      total: number;
      free: number;
      percentage: number;
    };
    cpu: {
      load: number;
    };
  };
  database: {
    status: "healthy" | "degraded" | "unhealthy";
    lastPoll: Date;
    pollingHealth: boolean;
    consecutiveFailures: number;
    averageResponseTime: number;
  };
  sockets: {
    activeConnections: number;
    totalConnections: number;
    rooms: number;
    health: "healthy" | "degraded" | "unhealthy";
  };
  overall: "healthy" | "degraded" | "unhealthy";
}

// State management using closure
interface HealthState {
  startTime: Date;
  metrics: HealthMetrics[];
  maxMetricsHistory: number;
  monitoringInterval: NodeJS.Timeout | null;
}

// Create initial state
const createHealthState = (): HealthState => ({
  startTime: new Date(),
  metrics: [],
  maxMetricsHistory: 100,
  monitoringInterval: null,
});

// Pure functions for metrics collection
const getSystemMetrics = (): HealthMetrics["system"] => {
  const uptime = process.uptime();
  const totalMem = require("os").totalmem();
  const freeMem = require("os").freemem();
  const usedMem = totalMem - freeMem;

  return {
    uptime,
    memory: {
      used: Math.round(usedMem / 1024 / 1024), // MB
      total: Math.round(totalMem / 1024 / 1024), // MB
      free: Math.round(freeMem / 1024 / 1024), // MB
      percentage: Math.round((usedMem / totalMem) * 100),
    },
    cpu: {
      load: require("os").loadavg()[0] || 0,
    },
  };
};

const getDatabaseMetrics = async (
  poller: any
): Promise<HealthMetrics["database"]> => {
  try {
    const stats = poller.getStats();
    const isHealthy = poller.isHealthy();

    let status: "healthy" | "degraded" | "unhealthy" = "healthy";

    if (!isHealthy) {
      status = "unhealthy";
    } else if (stats.consecutiveFailures > 2) {
      status = "degraded";
    }

    return {
      status,
      lastPoll: stats.lastSuccess,
      pollingHealth: isHealthy,
      consecutiveFailures: stats.consecutiveFailures,
      averageResponseTime: stats.averageResponseTime,
    };
  } catch (error) {
    return {
      status: "unhealthy",
      lastPoll: new Date(0),
      pollingHealth: false,
      consecutiveFailures: 999,
      averageResponseTime: 0,
    };
  }
};

const getSocketMetrics = (): HealthMetrics["sockets"] => {
  try {
    // Use the main io instance directly
    if (!socketService.getIO()) {
      return {
        activeConnections: 0,
        totalConnections: 0,
        rooms: 0,
        health: "degraded" as const,
      };
    }

    // Get socket stats from the main io instance
    const connectedSockets = Object.keys(
      socketService.getIO()?.sockets.sockets || {}
    );
    const activeConnections = connectedSockets.length;

    // Socket health assessment:
    // - "healthy": Socket.IO server working, can accept connections
    // - "degraded": Socket.IO server available but no active connections (normal for new systems)
    // - "unhealthy": Socket.IO server errors or connection failures

    let health: "healthy" | "degraded" | "unhealthy" = "healthy";

    // No connections yet - this is normal for new systems, not degraded
    if (activeConnections === 0) {
      health = "healthy";
    }

    return {
      activeConnections,
      totalConnections: activeConnections, // Simplified for now
      rooms: 0, // Simplified for now
      health,
    };
  } catch (error) {
    // If we can't get socket info, Socket.IO is unhealthy
    logger.err("Error getting socket metrics:", error);
    return {
      activeConnections: 0,
      totalConnections: 0,
      rooms: 0,
      health: "unhealthy" as const,
    };
  }
};

// Health assessment function
const assessOverallHealth = (
  metrics: HealthMetrics
): "healthy" | "degraded" | "unhealthy" => {
  if (
    metrics.database.status === "unhealthy" ||
    metrics.sockets.health === "unhealthy"
  ) {
    return "unhealthy";
  } else if (
    metrics.database.status === "degraded" ||
    metrics.sockets.health === "degraded"
  ) {
    return "degraded";
  }
  return "healthy";
};

// Metrics collection function
const collectMetrics = async (
  state: HealthState,
  poller: any
): Promise<HealthMetrics> => {
  const metrics: HealthMetrics = {
    timestamp: new Date(),
    system: getSystemMetrics(),
    database: await getDatabaseMetrics(poller),
    sockets: getSocketMetrics(),
    overall: "healthy",
  };

  metrics.overall = assessOverallHealth(metrics);
  return metrics;
};

// State update function
const updateHealthState = (
  state: HealthState,
  newMetrics: HealthMetrics
): HealthState => {
  const updatedMetrics = [...state.metrics, newMetrics];

  // Keep only recent metrics
  if (updatedMetrics.length > state.maxMetricsHistory) {
    updatedMetrics.splice(0, updatedMetrics.length - state.maxMetricsHistory);
  }

  return {
    ...state,
    metrics: updatedMetrics,
  };
};

// Main health monitoring function
const startHealthMonitoring = (
  state: HealthState,
  poller: any,
  onMetricsCollected?: (metrics: HealthMetrics) => void
): HealthState => {
  const monitoringInterval = setInterval(async () => {
    try {
      const metrics = await collectMetrics(state, poller);
      const updatedState = updateHealthState(state, metrics);

      // Log health status if degraded
      if (metrics.overall !== "healthy") {
        logger.warn(
          `System health degraded: ${metrics.overall} - Database: ${
            metrics.database.status
          }, Sockets: ${
            metrics.sockets.health
          }, Time: ${metrics.timestamp.toISOString()}`
        );

        // Additional logging for socket issues
        if (metrics.sockets.health !== "healthy") {
          logger.info(
            `Socket health details: Active: ${metrics.sockets.activeConnections}, Total: ${metrics.sockets.totalConnections}, Rooms: ${metrics.sockets.rooms}`
          );
        }
      }

      // Callback for external handling
      if (onMetricsCollected) {
        onMetricsCollected(metrics);
      }

      // Update state reference
      Object.assign(state, updatedState);
    } catch (error) {
      logger.err(`Error collecting health metrics: ${error.message}`);
    }
  }, 30000);

  return {
    ...state,
    monitoringInterval,
  };
};

// Utility functions
const stopHealthMonitoring = (state: HealthState): HealthState => {
  if (state.monitoringInterval) {
    clearInterval(state.monitoringInterval);
  }

  return {
    ...state,
    monitoringInterval: null,
  };
};

const getCurrentHealth = (state: HealthState): HealthMetrics | null => {
  return state.metrics.length > 0
    ? state.metrics[state.metrics.length - 1]
    : null;
};

const getHealthSummary = (state: HealthState) => {
  const current = getCurrentHealth(state);
  const uptime = formatUptime(process.uptime());
  const issues: string[] = [];

  if (current) {
    if (current.database.status !== "healthy") {
      issues.push(`Database: ${current.database.status}`);
    }
    if (current.sockets.health !== "healthy") {
      issues.push(`Sockets: ${current.sockets.health}`);
    }
    if (current.system.memory.percentage > 90) {
      issues.push("High memory usage");
    }
  }

  return {
    status: current?.overall || "unknown",
    uptime,
    lastCheck: current?.timestamp || null,
    issues,
  };
};

// Helper function
const formatUptime = (seconds: number): string => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
};

// Export functions and state management
let healthState: HealthState = createHealthState();

export const healthMonitor = {
  start: (
    poller: any,
    onMetricsCollected?: (metrics: HealthMetrics) => void
  ) => {
    healthState = startHealthMonitoring(
      healthState,
      poller,
      onMetricsCollected
    );
    logger.info("Health monitoring started");
  },

  stop: () => {
    healthState = stopHealthMonitoring(healthState);
    logger.info("Health monitoring stopped");
  },

  getCurrentHealth: () => getCurrentHealth(healthState),
  getHealthHistory: () => [...healthState.metrics],
  getHealthSummary: () => getHealthSummary(healthState),
  isHealthy: () => {
    const current = getCurrentHealth(healthState);
    return current ? current.overall === "healthy" : false;
  },

  forceHealthCheck: async (poller: any) => {
    const metrics = await collectMetrics(healthState, poller);
    healthState = updateHealthState(healthState, metrics);
    return metrics;
  },
};

// Export singleton instance for backward compatibility
export function getHealthMonitor() {
  return healthMonitor;
}

export default healthMonitor;
