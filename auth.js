/**
 * Middleware المصادقة والتحقق من الصلاحيات
 * Authentication and Authorization Middleware
 */

const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

/**
 * Middleware التحقق من صحة JWT Token
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Next middleware function
 */
const authenticateToken = async (req, res, next) => {
  try {
    // الحصول على التوكن من Header
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'مطلوب تسجيل الدخول للوصول لهذا المورد',
        code: 'NO_TOKEN_PROVIDED'
      });
    }

    // التحقق من صحة التوكن
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // التحقق من وجود المستخدم في قاعدة البيانات
    const userResult = await query(
      'SELECT id, username, email, full_name, role, permissions, is_active FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'المستخدم غير موجود',
        code: 'USER_NOT_FOUND'
      });
    }

    const user = userResult.rows[0];

    // التحقق من حالة المستخدم
    if (!user.is_active) {
      return res.status(401).json({
        success: false,
        message: 'حساب المستخدم معطل',
        code: 'USER_DISABLED'
      });
    }

    // إضافة معلومات المستخدم للطلب
    req.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      fullName: user.full_name,
      role: user.role,
      permissions: user.permissions || {}
    };

    // تحديث آخر نشاط
    await query(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'رمز التوكن غير صالح',
        code: 'INVALID_TOKEN'
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'انتهت صلاحية رمز التوكن',
        code: 'TOKEN_EXPIRED'
      });
    }

    console.error('❌ خطأ في middleware المصادقة:', error);
    return res.status(500).json({
      success: false,
      message: 'خطأ في التحقق من المصادقة',
      code: 'AUTH_ERROR'
    });
  }
};

/**
 * Middleware التحقق من صلاحية الأدمن
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Next middleware function
 */
const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: 'مطلوب تسجيل الدخول',
      code: 'NO_AUTH'
    });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'غير مصرح لك بالوصول لهذا المورد - مطلوب صلاحيات أدمن',
      code: 'ADMIN_REQUIRED'
    });
  }

  next();
};

/**
 * Middleware التحقق من صلاحية المقيم أو الأدمن
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Next middleware function
 */
const requireEvaluator = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: 'مطلوب تسجيل الدخول',
      code: 'NO_AUTH'
    });
  }

  if (!['admin', 'evaluator'].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'غير مصرح لك بالوصول لهذا المورد - مطلوب صلاحيات تقييم',
      code: 'EVALUATOR_REQUIRED'
    });
  }

  next();
};

/**
 * Middleware التحقق من صلاحية محددة
 * @param {string} permission - Required permission
 * @returns {Function} Middleware function
 */
const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'مطلوب تسجيل الدخول',
        code: 'NO_AUTH'
      });
    }

    // الأدمن له جميع الصلاحيات
    if (req.user.role === 'admin') {
      return next();
    }

    // التحقق من الصلاحية المحددة
    const userPermissions = req.user.permissions;
    
    if (!userPermissions[permission] && !userPermissions.all_permissions) {
      return res.status(403).json({
        success: false,
        message: `غير مصرح لك بتنفيذ هذا الإجراء - مطلوب صلاحية: ${permission}`,
        code: 'PERMISSION_DENIED',
        required_permission: permission
      });
    }

    next();
  };
};

/**
 * Middleware اختياري للمصادقة (لا يطلب تسجيل دخول إجباري)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Next middleware function
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      req.user = null;
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const userResult = await query(
      'SELECT id, username, email, full_name, role, permissions, is_active FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (userResult.rows.length > 0 && userResult.rows[0].is_active) {
      const user = userResult.rows[0];
      req.user = {
        id: user.id,
        username: user.username,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        permissions: user.permissions || {}
      };
    } else {
      req.user = null;
    }

    next();
  } catch (error) {
    // في حالة خطأ في التوكن، نكمل بدون مستخدم
    req.user = null;
    next();
  }
};

/**
 * تسجيل العمليات في audit trail
 * @param {string} action - Action type
 * @param {string} tableName - Table name affected
 * @param {string} recordId - Record ID affected
 * @param {Object} oldValues - Old values before change
 * @param {Object} newValues - New values after change
 * @param {string} description - Action description
 */
const logAuditTrail = async (req, action, tableName, recordId, oldValues = null, newValues = null, description = null) => {
  try {
    if (!req.user) return;

    await query(
      `INSERT INTO audit_trail (user_id, action_type, table_name, record_id, old_values, new_values, description, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        req.user.id,
        action,
        tableName,
        recordId,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        description,
        req.clientIP,
        req.get('User-Agent')
      ]
    );
  } catch (error) {
    console.error('❌ خطأ في تسجيل audit trail:', error.message);
  }
};

module.exports = {
  authenticateToken,
  requireAdmin,
  requireEvaluator,
  requirePermission,
  optionalAuth,
  logAuditTrail
};