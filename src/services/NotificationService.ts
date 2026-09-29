import Notification from "../models/Notification";
import { Op } from "sequelize";

class NotificationService {
  async create(userId: number, message: string, noteId?: number) {
    return Notification.create({ userId, message, noteId: noteId ?? null });
  }

  async list(userId: number) {
    return Notification.findAll({
      where: { userId },
      order: [["createdAt", "DESC"]],
      limit: 30,
    });
  }

  async unreadCount(userId: number) {
    return Notification.count({
      where: { userId, readAt: { [Op.is]: null } },
    });
  }

  async markRead(id: number, userId: number) {
    const notification = await Notification.findOne({ where: { id, userId } });
    if (!notification) return null;
    if (!notification.readAt) {
      await notification.update({ readAt: new Date() });
    }
    return notification;
  }

  async markAllRead(userId: number) {
    await Notification.update(
      { readAt: new Date() },
      { where: { userId, readAt: { [Op.is]: null } } }
    );
  }
}

export default new NotificationService();
