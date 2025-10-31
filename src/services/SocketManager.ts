import { Server as SocketIOServer, Socket } from "socket.io";
import { Server as HttpServer } from "http";

interface SocketMessage {
  to?: string | string[]; // User ID(s) or room name(s)
  message: any;
  event?: string;
  timestamp?: Date;
}

interface SocketUser {
  id: string;
  socketId: string;
  rooms: Set<string>;
}

class SocketManager {
  private io: SocketIOServer | null = null;
  private connectedUsers: Map<string, SocketUser> = new Map();
  private userSockets: Map<string, Socket> = new Map();

  /**
   * Initialize the socket server
   */
  public initialize(server: HttpServer): void {
    this.io = new SocketIOServer(server, {
      cors: {
        origin: process.env.CORS_ORIGIN || "*",
        methods: ["GET", "POST"],
      },
      transports: ["websocket", "polling"],
      pingTimeout: 60000,
      pingInterval: 25000,
      upgradeTimeout: 10000,
      allowEIO3: true,
    });

    this.setupEventHandlers();
    console.log("Socket server initialized");
  }

  /**
   * Setup socket event handlers
   */
  private setupEventHandlers(): void {
    if (!this.io) return;

    this.io.on("connection", (socket: Socket) => {
      console.log(`User connected: ${socket.id}`);

      // Handle user authentication/identification
      socket.on("authenticate", (userData: any) => {
        this.authenticateUser(socket, userData);
      });

      // Handle joining rooms
      socket.on("joinRoom", (roomName: string) => {
        this.joinRoom(socket, roomName);
      });

      // Handle leaving rooms
      socket.on("leaveRoom", (roomName: string) => {
        this.leaveRoom(socket, roomName);
      });

      // Handle disconnection
      socket.on("disconnect", () => {
        this.handleDisconnection(socket);
      });

      // Handle custom events
      socket.on("sendmessage", (data: any) => {
        this.handleSendMessage(socket, data);
      });

      // Handle status events from clients
      socket.on("statusTriggered", (data: any) => {
        this.statusTriggered(data);
      });

      socket.on("externalUserStatusChanged", (data: any) => {
        this.externalUserStatusChanged(data);
      });

      socket.on("statusVerified", (data: any) => {
        this.statusVerified(data);
      });
    });
  }

  /**
   * Authenticate and register a user
   */
  private authenticateUser(socket: Socket, userData: any): void {
    // Always normalize staff_id to string for consistent Map key type
    const staffIdStr = String(userData.staff_id);

    const user: SocketUser = {
      id: staffIdStr,
      socketId: socket.id,
      rooms: new Set(),
    };

    this.connectedUsers.set(staffIdStr, user);
    this.userSockets.set(socket.id, socket);

    // Properly log Map contents (Maps can't be JSON.stringified)
    console.log(`Connected Users Count: ${this.connectedUsers.size}`);
    console.log(
      `Connected User IDs: ${Array.from(this.connectedUsers.keys()).join(", ")}`
    );
    console.log(
      `Socket IDs: ${Array.from(this.userSockets.keys()).join(", ")}`
    );

    socket.emit("authenticated", { user: userData, socketId: socket.id });
    console.log(`User authenticated: ${staffIdStr} (${socket.id})`);
  }

  /**
   * Join a room
   */
  private joinRoom(socket: Socket, roomName: string): void {
    socket.join(roomName);

    // Update user's room list
    const user = Array.from(this.connectedUsers.values()).find(
      (u) => u.socketId === socket.id
    );
    if (user) {
      user.rooms.add(roomName);
    }

    socket.emit("joinedRoom", { room: roomName });
    console.log(`Socket ${socket.id} joined room: ${roomName}`);
  }

  /**
   * Leave a room
   */
  private leaveRoom(socket: Socket, roomName: string): void {
    socket.leave(roomName);

    // Update user's room list
    const user = Array.from(this.connectedUsers.values()).find(
      (u) => u.socketId === socket.id
    );
    if (user) {
      user.rooms.delete(roomName);
    }

    socket.emit("leftRoom", { room: roomName });
    console.log(`Socket ${socket.id} left room: ${roomName}`);
  }

  /**
   * Handle user disconnection
   */
  private handleDisconnection(socket: Socket): void {
    const user = Array.from(this.connectedUsers.values()).find(
      (u) => u.socketId === socket.id
    );
    if (user) {
      this.connectedUsers.delete(user.id);
      this.userSockets.delete(socket.id);
      console.log(`User disconnected: ${user.id} (${socket.id})`);
    }
  }

  /**
   * Handle incoming statusTriggered events from dbPoller
   */
  private statusTriggered(data: any): void {
    console.log(`Received statusTriggered event:`, data);

    // Validate and process the data
    if (data && data.value && data.value.count > 0) {
      const statusData = {
        type: "status_triggered",
        count: data.value.count,
        records: data.value.rows || [],
        timestamp: new Date(),
        source: "db_poller",
      };

      // Emit to all connected users
      this.io?.emit("statusTriggered", statusData);

      // Also emit to specific rooms if needed
      this.io?.to("admin_room").emit("statusTriggered", statusData);
      this.io?.to("monitoring_room").emit("statusTriggered", statusData);
    }
  }

  /**
   * Handle incoming statusVerified events from dbPoller
   */
  private statusVerified(data: any): void {
    console.log(`Received statusVerified event:`, data);

    // Validate and process the data
    if (data && data.count > 0) {
      const statusData = {
        type: "status_verified",
        count: data.count,
        records: data.rows || [],
        timestamp: new Date(),
        source: "db_poller",
      };

      // Emit to all connected users
      this.io?.emit("statusVerified", statusData);

      // Also emit to specific rooms if needed
      this.io?.to("admin_room").emit("statusVerified", statusData);
      this.io?.to("monitoring_room").emit("statusVerified", statusData);
    }
  }
  /**
   * Handle incoming externalUserStatusChanged events from ExternalUser model
   */
  public externalUserStatusChanged(data: any): void {
    // console.log(`Received externalUserStatusChanged event:`, data);

    // Emit to all connected users
    this.io?.emit("externalUserStatusChanged", data);

    // Also emit to specific rooms if needed
    this.io?.to("admin_room").emit("externalUserStatusChanged", data);
    this.io?.to("monitoring_room").emit("externalUserStatusChanged", data);
  }

  /**
   * Send notification to specific staff members
   * @param staffIds Array of staff IDs to send notification to
   * @param notificationData The notification data to send
   */
  public sendNotification(
    staffIds: (string | number)[],
    notificationData: any
  ): void {
    if (!this.io) {
      console.error("Socket server not initialized");
      return;
    }

    console.log(
      `Sending notification to ${staffIds.length} staff member(s):`,
      notificationData.title || "Notification"
    );

    const payload = {
      ...notificationData,
      timestamp: notificationData.timestamp || new Date(),
    };

    // Send to each staff member individually
    staffIds.forEach((staffId) => {
      const staffIdStr = staffId.toString();
      const isConnected = this.isUserConnected(staffIdStr);
      console.log(
        `Connected User IDs: ${Array.from(this.connectedUsers.keys()).join(
          ", "
        )}`
      );
      console.log(`Checking staff ${staffIdStr}: Connected=${isConnected}`);

      // Check if staff member is connected
      if (isConnected) {
        const user = this.connectedUsers.get(staffIdStr);
        if (user) {
          const socket = this.userSockets.get(user.socketId);
          if (socket) {
            socket.emit("sendNotification", payload);
            console.log(
              `✅ Notification sent to staff ${staffId} (socket: ${user.socketId})`
            );
          } else {
            console.log(`⚠️ Socket not found for staff ${staffId}`);
          }
        } else {
          console.log(
            `⚠️ User not found in connectedUsers for staff ${staffId}`
          );
        }
      } else {
        console.log(
          `❌ Staff ${staffId} is not connected (Total connected: ${this.connectedUsers.size})`
        );
      }
    });

    // Also emit to admin/monitoring rooms for oversight
    this.io.to("admin_room").emit("sendNotification", payload);
    this.io.to("monitoring_room").emit("sendNotification", payload);
  }

  /**
   * Handle incoming sendmessage events
   */
  private handleSendMessage(socket: Socket, data: any): void {
    console.log(`Received message from ${socket.id}:`, data);

    // Echo the message back or process it as needed
    socket.emit("messageReceived", {
      ...data,
      timestamp: new Date(),
      from: socket.id,
    });
  }

  /**
   * Send a message to specific user(s) or room(s)
   */
  public sendMessage(messageData: SocketMessage): void {
    if (!this.io) {
      console.error("Socket server not initialized");
      return;
    }

    const {
      to,
      message,
      event = "sendmessage",
      timestamp = new Date(),
    } = messageData;

    const payload = {
      message,
      timestamp,
      event,
    };

    if (to) {
      if (Array.isArray(to)) {
        // Send to multiple recipients
        to.forEach((recipient) => {
          this.sendToRecipient(recipient, payload);
        });
      } else {
        // Send to single recipient
        this.sendToRecipient(to, payload);
      }
    } else {
      // Broadcast to all connected users
      this.io.emit(event, payload);
    }
  }

  /**
   * Send message to a specific recipient (user ID or room)
   */
  private sendToRecipient(recipient: string, payload: any): void {
    if (!this.io) return;

    // Check if recipient is a user ID
    const user = this.connectedUsers.get(recipient);
    if (user) {
      const socket = this.userSockets.get(user.socketId);
      if (socket) {
        socket.emit(payload.event, payload);
        console.log(`Message sent to user ${recipient}`);
        return;
      }
    }

    // Check if recipient is a room
    this.io.to(recipient).emit(payload.event, payload);
    console.log(`Message sent to room ${recipient}`);
  }

  /**
   * Broadcast message to all connected users
   */
  public broadcast(message: any, event: string = "broadcast"): void {
    if (!this.io) {
      console.error("Socket server not initialized");
      return;
    }

    this.io.emit(event, {
      message,
      timestamp: new Date(),
    });

    console.log(`Broadcast sent to all users: ${event}`);
  }

  /**
   * Send message to a specific room
   */
  public sendToRoom(
    roomName: string,
    message: any,
    event: string = "roomMessage"
  ): void {
    if (!this.io) {
      console.error("Socket server not initialized");
      return;
    }

    this.io.to(roomName).emit(event, {
      message,
      room: roomName,
      timestamp: new Date(),
    });

    console.log(`Message sent to room ${roomName}: ${event}`);
  }

  /**
   * Get list of connected users
   */
  public getConnectedUsers(): string[] {
    return Array.from(this.connectedUsers.keys());
  }

  /**
   * Get user's socket information
   */
  public getUserInfo(userId: string): SocketUser | undefined {
    return this.connectedUsers.get(userId);
  }

  /**
   * Check if user is connected
   */
  public isUserConnected(userId: string): boolean {
    return this.connectedUsers.has(userId);
  }

  /**
   * Get total number of connected users
   */
  public getConnectionCount(): number {
    return this.connectedUsers.size;
  }

  /**
   * Force disconnect a user
   */
  public disconnectUser(userId: string): void {
    const user = this.connectedUsers.get(userId);
    if (user) {
      const socket = this.userSockets.get(user.socketId);
      if (socket) {
        socket.disconnect();
        this.connectedUsers.delete(userId);
        this.userSockets.delete(user.socketId);
        console.log(`User ${userId} forcefully disconnected`);
      }
    }
  }

  /**
   * Send status triggered notification
   */
  public sendStatusTriggered(data: any): void {
    this.statusTriggered(data);
  }

  /**
   * Send status verified notification
   */
  public sendStatusVerified(data: any): void {
    this.statusVerified(data);
  }

  /**
   * Send status update to specific user
   */
  public sendStatusUpdateToUser(userId: string, statusData: any): void {
    if (!this.isUserConnected(userId)) {
      console.log(`User ${userId} is not connected, status update not sent`);
      return;
    }

    this.sendMessage({
      to: userId,
      message: {
        type: "status_update",
        data: statusData,
      },
      event: "statusUpdate",
    });
  }

  /**
   * Send status update to specific room
   */
  public sendStatusUpdateToRoom(roomName: string, statusData: any): void {
    this.sendToRoom(
      roomName,
      {
        type: "status_update",
        data: statusData,
      },
      "statusUpdate"
    );
  }

  /**
   * Broadcast status update to all users
   */
  public broadcastStatusUpdate(statusData: any): void {
    this.broadcast(
      {
        type: "status_update",
        data: statusData,
      },
      "statusUpdate"
    );
  }

  /**
   * Send notification to users with a specific role
   * This is especially useful for targeting staff with specific roles like "manager"
   * @param role The role to target (e.g., "manager")
   * @param notificationData The notification data
   * @param persistToDb Whether to persist the notification to the database
   */
  public async sendRoleNotification(
    role: string,
    notificationData: {
      title: string;
      message: string;
      type?: "system" | "alert" | "info" | "warning" | "success" | "error";
      priority?: "high" | "medium" | "low";
      action_url?: string;
      metadata?: any;
    },
    persistToDb: boolean = true
  ): Promise<void> {
    // Room name convention for roles is "{role}_room", e.g. "manager_room"
    const roleRoom = `${role}_room`;

    // Prepare the socket notification payload
    const socketPayload = {
      type: "role_notification",
      role: role,
      data: notificationData,
    };

    // Send real-time notification to the role room
    this.sendStatusUpdateToRoom(roleRoom, socketPayload);

    // If enabled, persist to database using GroupNotificationService
    if (persistToDb) {
      try {
        // Dynamically import to avoid circular dependencies
        const GroupNotificationService =
          require("./GroupNotificationService").default;

        await GroupNotificationService.createRoleNotification(
          {
            title: notificationData.title,
            message: notificationData.message,
            type: notificationData.type || "info",
            priority: notificationData.priority || "medium",
            action_url: notificationData.action_url,
            metadata: notificationData.metadata,
          },
          role
        );

        console.log(
          `Role notification persisted to database for role: ${role}`
        );
      } catch (error) {
        console.error(
          `Failed to persist role notification to database:`,
          error
        );
      }
    }
  }

  /**
   * Send notification to specific staff members
   * @param staffIds Array of staff IDs to receive the notification
   * @param notificationData The notification data
   * @param persistToDb Whether to persist the notification to the database
   */
  public async sendStaffNotification(
    staffIds: number[],
    notificationData: {
      title: string;
      message: string;
      type?: "system" | "alert" | "info" | "warning" | "success" | "error";
      priority?: "high" | "medium" | "low";
      action_url?: string;
      metadata?: any;
    },
    persistToDb: boolean = true
  ): Promise<void> {
    // Prepare the socket notification payload
    const socketPayload = {
      type: "staff_notification",
      data: notificationData,
    };

    // Send real-time notification to each staff member
    staffIds.forEach((staffId) => {
      // Assuming each staff member might have a specific room or direct connection
      const staffRoom = `staff_${staffId}`;
      this.sendStatusUpdateToRoom(staffRoom, socketPayload);
    });

    // If enabled, persist to database using GroupNotificationService
    if (persistToDb) {
      try {
        // Dynamically import to avoid circular dependencies
        const GroupNotificationService =
          require("./GroupNotificationService").default;

        await GroupNotificationService.createGroupNotification({
          title: notificationData.title,
          message: notificationData.message,
          type: notificationData.type || "info",
          priority: notificationData.priority || "medium",
          action_url: notificationData.action_url,
          metadata: notificationData.metadata,
          staffIds: staffIds,
        });

        console.log(
          `Staff notification persisted to database for ${staffIds.length} staff members`
        );
      } catch (error) {
        console.error(
          `Failed to persist staff notification to database:`,
          error
        );
      }
    }
  }

  /**
   * Get socket server instance
   */
  public getIO(): SocketIOServer | null {
    return this.io;
  }
}

// Create and export singleton instance
const socketService = new SocketManager();

export default socketService;
export { SocketManager, SocketMessage, SocketUser };
