/**
 * @swagger
 * tags:
 *   - name: Notifications
 *     description: General notification management endpoints
 *   - name: Role Notifications
 *     description: Role-based notification endpoints for targeting specific user groups
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Notification:
 *       type: object
 *       properties:
 *         notification_id:
 *           type: integer
 *           description: Unique identifier for the notification
 *         staff_id:
 *           type: integer
 *           nullable: true
 *           description: ID of the staff member if this is a direct notification
 *         title:
 *           type: string
 *           description: Notification title
 *         message:
 *           type: string
 *           description: Notification message content
 *         type:
 *           type: string
 *           enum: [system, alert, info, warning, success, error]
 *           description: Type of notification
 *         read:
 *           type: string
 *           enum: [Y, N]
 *           description: Read status for direct notifications
 *         status:
 *           type: string
 *           enum: [active, inactive, pending]
 *           description: Notification status
 *         date_created:
 *           type: string
 *           format: date-time
 *           description: When the notification was created
 *         date_read:
 *           type: string
 *           format: date-time
 *           nullable: true
 *           description: When the notification was read
 *         priority:
 *           type: string
 *           enum: [high, medium, low]
 *           description: Notification priority
 *         target_type:
 *           type: string
 *           enum: [staff, all]
 *           description: Target type for notification
 *         action_url:
 *           type: string
 *           nullable: true
 *           description: Optional URL for notification action
 *         metadata:
 *           type: object
 *           nullable: true
 *           description: Additional metadata in JSON format
 *       required:
 *         - notification_id
 *         - title
 *         - message
 *         - type
 *         - read
 *         - status
 *         - date_created
 *         - priority
 *         - target_type
 *
 *     CreateNotificationRequest:
 *       type: object
 *       properties:
 *         title:
 *           type: string
 *           description: Notification title
 *         message:
 *           type: string
 *           description: Notification message content
 *         type:
 *           type: string
 *           enum: [system, alert, info, warning, success, error]
 *           description: Type of notification
 *         target_type:
 *           type: string
 *           enum: [user, staff, distributor, all]
 *           description: Target type for notification
 *         user_id:
 *           type: string
 *           description: User ID for user-targeted notifications
 *         staff_id:
 *           type: integer
 *           description: Staff ID for staff-targeted notifications
 *         distributor_id:
 *           type: integer
 *           description: Distributor ID for distributor-targeted notifications
 *         priority:
 *           type: string
 *           enum: [high, medium, low]
 *           default: medium
 *           description: Notification priority
 *         action_url:
 *           type: string
 *           description: Optional URL for notification action
 *         metadata:
 *           type: object
 *           description: Additional metadata
 *       required:
 *         - title
 *         - message
 *         - type
 *         - target_type
 *
 *     RoleNotificationRequest:
 *       type: object
 *       properties:
 *         title:
 *           type: string
 *           description: Notification title
 *         message:
 *           type: string
 *           description: Notification message content
 *         type:
 *           type: string
 *           enum: [system, alert, info, warning, success, error]
 *           description: Type of notification
 *         role:
 *           type: string
 *           example: manager
 *           description: Staff role to send notification to
 *         priority:
 *           type: string
 *           enum: [high, medium, low]
 *           default: medium
 *           description: Notification priority
 *         action_url:
 *           type: string
 *           description: Optional URL for notification action
 *         metadata:
 *           type: object
 *           description: Additional metadata
 *       required:
 *         - title
 *         - message
 *         - type
 *         - role
 *
 *   responses:
 *     NotificationNotFound:
 *       description: Notification not found
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               error:
 *                 type: string
 *                 example: Notification not found
 *
 *     Unauthorized:
 *       description: Unauthorized access
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               error:
 *                 type: string
 *                 example: Authentication required
 *
 *     BadRequest:
 *       description: Bad request
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               error:
 *                 type: string
 *                 example: Invalid request data
 */

/**
 * @swagger
 * /api/notifications:
 *   get:
 *     description: Get all notifications
 *     tags:
 *       - Notifications
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: order
 *         description: Sort order
 *         in: query
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *       - name: sortKey
 *         description: Key to sort by
 *         in: query
 *         schema:
 *           type: string
 *       - name: page
 *         description: Page number
 *         in: query
 *         schema:
 *           type: integer
 *       - name: limit
 *         description: Number of items per page
 *         in: query
 *         schema:
 *           type: integer
 *       - name: filter
 *         description: Filter criteria
 *         in: query
 *         schema:
 *           type: object
 *     responses:
 *       200:
 *         description: List of notifications
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Notification'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *
 *   post:
 *     description: Create a new notification
 *     tags:
 *       - Notifications
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateNotificationRequest'
 *     responses:
 *       201:
 *         description: Notification created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Notification'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */

/**
 * @swagger
 * /api/notifications/count:
 *   get:
 *     description: Get unread notification count
 *     tags:
 *       - Notifications
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: user_id
 *         description: User ID
 *         in: query
 *         schema:
 *           type: string
 *       - name: staff_id
 *         description: Staff ID
 *         in: query
 *         schema:
 *           type: integer
 *       - name: distributor_id
 *         description: Distributor ID
 *         in: query
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Unread notification count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     unreadCount:
 *                       type: integer
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */

/**
 * @swagger
 * /api/notifications/{id}:
 *   get:
 *     description: Get a notification by ID
 *     tags:
 *       - Notifications
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         description: Notification ID
 *         in: path
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Notification details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Notification'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotificationNotFound'
 *
 *   put:
 *     description: Update a notification
 *     tags:
 *       - Notifications
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         description: Notification ID
 *         in: path
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               message:
 *                 type: string
 *               type:
 *                 type: string
 *                 enum: [system, alert, info, warning, success, error]
 *               priority:
 *                 type: string
 *                 enum: [high, medium, low]
 *               status:
 *                 type: string
 *                 enum: [active, inactive, pending]
 *               action_url:
 *                 type: string
 *               metadata:
 *                 type: object
 *     responses:
 *       200:
 *         description: Notification updated
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotificationNotFound'
 *
 *   delete:
 *     description: Delete a notification
 *     tags:
 *       - Notifications
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         description: Notification ID
 *         in: path
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Notification deleted
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotificationNotFound'
 */

/**
 * @swagger
 * /api/notifications/{id}/read:
 *   put:
 *     description: Mark a notification as read
 *     tags:
 *       - Notifications
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         description: Notification ID
 *         in: path
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Notification marked as read
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotificationNotFound'
 */

/**
 * @swagger
 * /api/notifications/system:
 *   post:
 *     description: Create a system notification for all users
 *     tags:
 *       - Notifications
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - message
 *               - type
 *             properties:
 *               title:
 *                 type: string
 *               message:
 *                 type: string
 *               type:
 *                 type: string
 *               priority:
 *                 type: string
 *                 enum: [high, medium, low]
 *               action_url:
 *                 type: string
 *               metadata:
 *                 type: object
 *     responses:
 *       201:
 *         description: System notification created
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */

/**
 * @swagger
 * /api/notifications/bulk:
 *   post:
 *     description: Create multiple notifications at once
 *     tags:
 *       - Notifications
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: array
 *             items:
 *               $ref: '#/components/schemas/CreateNotificationRequest'
 *     responses:
 *       201:
 *         description: Notifications created
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */

/**
 * @swagger
 * /api/notifications/read-all:
 *   put:
 *     description: Mark all notifications as read
 *     tags:
 *       - Notifications
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               user_id:
 *                 type: string
 *               staff_id:
 *                 type: integer
 *               distributor_id:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Notifications marked as read
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */

/**
 * @swagger
 * /api/notifications/role:
 *   post:
 *     description: Send a notification to staff with a specific role
 *     tags:
 *       - Role Notifications
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RoleNotificationRequest'
 *     responses:
 *       201:
 *         description: Notification sent to staff with specified role
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     notificationId:
 *                       type: integer
 *                     recipientCount:
 *                       type: integer
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */

/**
 * @swagger
 * /api/notifications/role/{role}:
 *   get:
 *     description: Get notifications for staff with a specific role
 *     tags:
 *       - Role Notifications
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: role
 *         description: Staff role (e.g., manager, admin)
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *           example: manager
 *       - name: limit
 *         description: Number of items per page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *       - name: page
 *         description: Page number
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: includeRead
 *         description: Whether to include read notifications
 *         in: query
 *         schema:
 *           type: boolean
 *           default: true
 *     responses:
 *       200:
 *         description: List of notifications for the specified role
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     notifications:
 *                       type: array
 *                       items:
 *                         allOf:
 *                           - $ref: '#/components/schemas/Notification'
 *                           - type: object
 *                             properties:
 *                               isRead:
 *                                 type: boolean
 *                                 description: Whether this notification has been read by the current user
 *                     total:
 *                       type: integer
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     totalPages:
 *                       type: integer
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */

/**
 * @swagger
 * /api/notifications/role/{role}/read-all:
 *   put:
 *     description: Mark all notifications as read for staff with a specific role
 *     tags:
 *       - Role Notifications
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: role
 *         description: Staff role (e.g., manager, admin)
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *           example: manager
 *     responses:
 *       200:
 *         description: Notifications marked as read for the specified role
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     updatedCount:
 *                       type: integer
 *                       description: Number of notifications marked as read
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */

/**
 * @swagger
 * /api/notifications/staff/{staffId}/join-role-room:
 *   post:
 *     description: Have a staff member join their role-based notification room
 *     tags:
 *       - Role Notifications
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: staffId
 *         description: Staff ID
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Staff joined role room
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     staffId:
 *                       type: string
 *                     role:
 *                       type: string
 *                     room:
 *                       type: string
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         description: Staff not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Staff not found
 */

module.exports = {};
