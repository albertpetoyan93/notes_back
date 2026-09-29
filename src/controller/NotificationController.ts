import { Response } from "express";
import NotificationService from "../services/NotificationService";

export default class NotificationController {
  static list = async (req: any, res: Response) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const [items, unread] = await Promise.all([
      NotificationService.list(userId),
      NotificationService.unreadCount(userId),
    ]);

    res.json({ items, unread });
  };

  static markRead = async (req: any, res: Response) => {
    const userId = req.user?.id;
    const id = parseInt(req.params.id);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });

    const notification = await NotificationService.markRead(id, userId);
    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }
    res.json(notification);
  };

  static markAllRead = async (req: any, res: Response) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    await NotificationService.markAllRead(userId);
    res.json({ message: "Marked as read" });
  };
}
