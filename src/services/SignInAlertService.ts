import logger from "jet-logger";
import { Op } from "sequelize";
import AuditEvent from "../models/AuditEvent";
import User from "../models/User";
import { browserAndOs } from "../util/device";
import EmailService from "./EmailService";
import NotificationService from "./NotificationService";

// A device seen in this window is a known device.
const KNOWN_FOR_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Tells people when their account is signed in from a device it hasn't seen.
 * A device is "browser on OS" from the user agent, so the extension in a
 * browser counts as the same device as the vault in that browser.
 */
class SignInAlertService {
  /** Called after a `login` event is stored. Never throws. */
  async afterLogin(event: AuditEvent) {
    try {
      if (!event.actorId) return;
      const device = browserAndOs(event.userAgent);
      const earlier = await AuditEvent.findAll({
        where: {
          actorId: event.actorId,
          action: "login",
          id: { [Op.lt]: event.id },
        },
        attributes: ["userAgent", "createdAt"],
        order: [["id", "DESC"]],
        limit: 500,
      });
      // The first sign-in ever (or since the audit log started) has nothing
      // to compare with, and is usually right after registering.
      if (!earlier.length) return;
      const since = Date.now() - KNOWN_FOR_MS;
      const known = earlier.some(
        (item) =>
          item.createdAt.getTime() > since && browserAndOs(item.userAgent) === device
      );
      if (known) return;

      const user = await User.findByPk(event.actorId, { attributes: ["id", "email"] });
      if (!user) return;
      const deviceName = device || "an unknown device";
      const details = (event.details || {}) as Record<string, unknown>;
      const how = details.passkey
        ? "with a passkey"
        : details.kind === "extension"
          ? "in the browser extension"
          : "with your password";

      await NotificationService.create(
        user.id,
        `New sign-in from ${deviceName}${event.ip ? ` (IP ${event.ip})` : ""}. ` +
          "Not you? Change your password and sign out other devices in Security settings."
      );
      if (user.email) {
        await EmailService.sendNewSignIn({
          to: user.email,
          device: deviceName,
          how,
          ip: event.ip || null,
          time: event.createdAt,
        }).catch((error) => logger.err(`New sign-in email failed: ${error}`));
      }
    } catch (error) {
      logger.err(`Could not check the sign-in device: ${error}`);
    }
  }
}

export default new SignInAlertService();
