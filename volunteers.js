/**
 * مسارات إدارة المتطوعين
 * Volunteers Management Routes
 */

const express = require('express');
const { body, validationResult, query: expressQuery } = require('express-validator');
const { query, transaction } = require('../config/database');
const { authenticateToken, requireAdmin, requireEvaluator, logAuditTrail } = require('../middleware/auth');

const router = express.Router();

/**
 * جلب جميع المتطوعين
 * GET /api/volunteers
 */
router.get('/', authenticateToken, requireEvaluator, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 10, 
      search, 
      role_type, 
      is_active,
      sort_by = 'created_at',
      sort_order = 'desc'
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    // بناء شروط البحث
    let whereClause = 'WHERE 1=1';
    const queryParams = [];
    let paramIndex = 1;

    if (search) {
      whereClause += ` AND (full_name ILIKE $${paramIndex} OR phone ILIKE $${paramIndex})`;
      queryParams.push(`%${search}%`);
      paramIndex++;
    }

    if (role_type) {
      whereClause += ` AND role_type = $${paramIndex}`;
      queryParams.push(role_type);
      paramIndex++;
    }

    if (is_active !== undefined) {
      whereClause += ` AND is_active = $${paramIndex}`;
      queryParams.push(is_active === 'true');
      paramIndex++;
    }

    // التحقق من صحة ترتيب النتائج
    const validSortFields = ['full_name', 'created_at', 'join_date', 'role_type'];
    const validSortOrders = ['asc', 'desc'];
    
    const sortBy = validSortFields.includes(sort_by) ? sort_by : 'created_at';
    const sortOrder = validSortOrders.includes(sort_order.toLowerCase()) ? sort_order.toLowerCase() : 'desc';

    // إحصاء إجمالي
    const countQuery = `SELECT COUNT(*) as total FROM volunteers ${whereClause}`;
    const countResult = await query(countQuery, queryParams);
    const total = parseInt(countResult.rows[0].total);

    // جلب البيانات مع معلومات إضافية
    queryParams.push(parseInt(limit), offset);
    const volunteersQuery = `
      SELECT 
        v.*,
        u1.full_name as created_by_name,
        u2.full_name as updated_by_name,
        COALESCE(fr.freeze_count, 0) as current_freeze_count,
        CASE 
          WHEN EXISTS(
            SELECT 1 FROM freeze_records fr2 
            WHERE fr2.volunteer_id = v.id 
            AND CURRENT_DATE BETWEEN fr2.start_date AND fr2.end_date
            AND fr2.is_active = true
          ) THEN true 
          ELSE false 
        END as is_currently_frozen
      FROM volunteers v
      LEFT JOIN users u1 ON v.created_by = u1.id
      LEFT JOIN users u2 ON v.updated_by = u2.id
      LEFT JOIN (
        SELECT volunteer_id, COUNT(*) as freeze_count
        FROM freeze_records
        WHERE freeze_year = EXTRACT(YEAR FROM CURRENT_DATE) AND is_active = true
        GROUP BY volunteer_id
      ) fr ON v.id = fr.volunteer_id
      ${whereClause}
      ORDER BY ${sortBy} ${sortOrder}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const volunteersResult = await query(volunteersQuery, queryParams);

    res.json({
      success: true,
      data: {
        volunteers: volunteersResult.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        },
        filters: {
          search: search || null,
          role_type: role_type || null,
          is_active: is_active || null
        }
      }
    });

  } catch (error) {
    console.error('❌ خطأ في جلب المتطوعين:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في جلب بيانات المتطوعين',
      code: 'GET_VOLUNTEERS_ERROR'
    });
  }
});

/**
 * جلب بيانات متطوع محدد
 * GET /api/volunteers/:id
 */
router.get('/:id', authenticateToken, requireEvaluator, async (req, res) => {
  try {
    const { id } = req.params;

    const volunteerQuery = `
      SELECT 
        v.*,
        u1.full_name as created_by_name,
        u2.full_name as updated_by_name,
        COALESCE(fr.freeze_count, 0) as current_freeze_count,
        CASE 
          WHEN EXISTS(
            SELECT 1 FROM freeze_records fr2 
            WHERE fr2.volunteer_id = v.id 
            AND CURRENT_DATE BETWEEN fr2.start_date AND fr2.end_date
            AND fr2.is_active = true
          ) THEN true 
          ELSE false 
        END as is_currently_frozen
      FROM volunteers v
      LEFT JOIN users u1 ON v.created_by = u1.id
      LEFT JOIN users u2 ON v.updated_by = u2.id
      LEFT JOIN (
        SELECT volunteer_id, COUNT(*) as freeze_count
        FROM freeze_records
        WHERE freeze_year = EXTRACT(YEAR FROM CURRENT_DATE) AND is_active = true
        GROUP BY volunteer_id
      ) fr ON v.id = fr.volunteer_id
      WHERE v.id = $1
    `;

    const volunteerResult = await query(volunteerQuery, [id]);

    if (volunteerResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'المتطوع غير موجود',
        code: 'VOLUNTEER_NOT_FOUND'
      });
    }

    const volunteer = volunteerResult.rows[0];

    // جلب آخر 5 تقييمات للمتطوع
    const recentEvaluationsQuery = `
      SELECT 
        e.evaluation_month,
        e.evaluation_year,
        e.percentage,
        e.status,
        e.created_at,
        u.full_name as evaluator_name
      FROM evaluations e
      LEFT JOIN users u ON e.evaluator_id = u.id
      WHERE e.volunteer_id = $1
      ORDER BY e.evaluation_year DESC, e.evaluation_month DESC
      LIMIT 5
    `;

    const evaluationsResult = await query(recentEvaluationsQuery, [id]);

    // جلب الملاحظات التراكمية
    const cumulativeNotesQuery = `
      SELECT 
        cn.*,
        u.full_name as created_by_name
      FROM cumulative_notes cn
      LEFT JOIN users u ON cn.created_by = u.id
      WHERE cn.volunteer_id = $1
      ORDER BY cn.created_at DESC
      LIMIT 10
    `;

    const notesResult = await query(cumulativeNotesQuery, [id]);

    // جلب التنبيهات النشطة
    const activeAlertsQuery = `
      SELECT 
        ar.*,
        ec.name_ar as criteria_name
      FROM alert_records ar
      LEFT JOIN evaluation_criteria ec ON ar.criteria_id = ec.id
      WHERE ar.volunteer_id = $1 AND ar.is_resolved = false
      ORDER BY ar.severity DESC, ar.created_at DESC
    `;

    const alertsResult = await query(activeAlertsQuery, [id]);

    res.json({
      success: true,
      data: {
        volunteer: volunteer,
        recent_evaluations: evaluationsResult.rows,
        cumulative_notes: notesResult.rows,
        active_alerts: alertsResult.rows
      }
    });

  } catch (error) {
    console.error('❌ خطأ في جلب بيانات المتطوع:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في جلب بيانات المتطوع',
      code: 'GET_VOLUNTEER_ERROR'
    });
  }
});

/**
 * إضافة متطوع جديد
 * POST /api/volunteers
 */
router.post('/', [
  authenticateToken,
  requireEvaluator,
  body('full_name').notEmpty().withMessage('الاسم الكامل مطلوب'),
  body('phone').notEmpty().withMessage('رقم الهاتف مطلوب'),
  body('role_type').optional().isIn(['ميداني', 'إداري', 'مسئول ملف']).withMessage('نوع الدور غير صالح'),
  body('join_date').optional().isISO8601().withMessage('تاريخ الانضمام غير صالح')
], async (req, res) => {
  try {
    // التحقق من صحة البيانات
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'بيانات غير صحيحة',
        errors: errors.array()
      });
    }

    const { 
      full_name, 
      phone, 
      join_date, 
      role_type = 'ميداني', 
      personality_notes 
    } = req.body;

    // التحقق من عدم تكرار رقم الهاتف
    const existingVolunteer = await query(
      'SELECT id FROM volunteers WHERE phone = $1',
      [phone]
    );

    if (existingVolunteer.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'رقم الهاتف موجود بالفعل',
        code: 'PHONE_EXISTS'
      });
    }

    // إضافة المتطوع الجديد
    const newVolunteerQuery = `
      INSERT INTO volunteers (full_name, phone, join_date, role_type, personality_notes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;

    const newVolunteer = await query(newVolunteerQuery, [
      full_name,
      phone,
      join_date || null,
      role_type,
      personality_notes || null,
      req.user.id
    ]);

    const volunteer = newVolunteer.rows[0];

    // تسجيل العملية
    await logAuditTrail(req, 'CREATE', 'volunteers', volunteer.id, null, volunteer, `إضافة متطوع جديد: ${full_name}`);

    // إضافة ملاحظة ترحيبية
    await query(
      `INSERT INTO cumulative_notes (volunteer_id, note_type, content, is_positive, created_by)
       VALUES ($1, 'achievement', $2, true, $3)`,
      [
        volunteer.id,
        `مرحباً بانضمام ${full_name} لفريق متطوعي مشروع زاد. نتطلع لعطائه وإسهامه في خدمة المجتمع.`,
        req.user.id
      ]
    );

    res.status(201).json({
      success: true,
      message: 'تم إضافة المتطوع بنجاح',
      data: {
        volunteer: volunteer
      }
    });

  } catch (error) {
    console.error('❌ خطأ في إضافة المتطوع:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في إضافة المتطوع',
      code: 'CREATE_VOLUNTEER_ERROR'
    });
  }
});

/**
 * تحديث بيانات متطوع
 * PUT /api/volunteers/:id
 */
router.put('/:id', [
  authenticateToken,
  requireEvaluator,
  body('full_name').optional().notEmpty().withMessage('الاسم الكامل لا يمكن أن يكون فارغاً'),
  body('phone').optional().notEmpty().withMessage('رقم الهاتف لا يمكن أن يكون فارغاً'),
  body('role_type').optional().isIn(['ميداني', 'إداري', 'مسئول ملف']).withMessage('نوع الدور غير صالح'),
  body('join_date').optional().isISO8601().withMessage('تاريخ الانضمام غير صالح')
], async (req, res) => {
  try {
    // التحقق من صحة البيانات
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'بيانات غير صحيحة',
        errors: errors.array()
      });
    }

    const { id } = req.params;
    const { full_name, phone, join_date, role_type, personality_notes } = req.body;

    // التحقق من وجود المتطوع
    const existingVolunteerResult = await query('SELECT * FROM volunteers WHERE id = $1', [id]);
    if (existingVolunteerResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'المتطوع غير موجود',
        code: 'VOLUNTEER_NOT_FOUND'
      });
    }

    const oldVolunteer = existingVolunteerResult.rows[0];

    // التحقق من تكرار رقم الهاتف (إذا تم تغييره)
    if (phone && phone !== oldVolunteer.phone) {
      const phoneExists = await query(
        'SELECT id FROM volunteers WHERE phone = $1 AND id != $2',
        [phone, id]
      );

      if (phoneExists.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'رقم الهاتف موجود بالفعل',
          code: 'PHONE_EXISTS'
        });
      }
    }

    // بناء الاستعلام التحديثي
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (full_name !== undefined) {
      updates.push(`full_name = $${paramIndex}`);
      values.push(full_name);
      paramIndex++;
    }

    if (phone !== undefined) {
      updates.push(`phone = $${paramIndex}`);
      values.push(phone);
      paramIndex++;
    }

    if (join_date !== undefined) {
      updates.push(`join_date = $${paramIndex}`);
      values.push(join_date);
      paramIndex++;
    }

    if (role_type !== undefined) {
      updates.push(`role_type = $${paramIndex}`);
      values.push(role_type);
      paramIndex++;
    }

    if (personality_notes !== undefined) {
      updates.push(`personality_notes = $${paramIndex}`);
      values.push(personality_notes);
      paramIndex++;
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'لا توجد بيانات للتحديث',
        code: 'NO_UPDATES'
      });
    }

    updates.push(`updated_by = $${paramIndex}`);
    values.push(req.user.id);
    paramIndex++;

    updates.push('updated_at = CURRENT_TIMESTAMP');

    values.push(id); // لشرط WHERE

    const updateQuery = `
      UPDATE volunteers 
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const updatedVolunteer = await query(updateQuery, values);
    const newVolunteer = updatedVolunteer.rows[0];

    // تسجيل العملية
    await logAuditTrail(req, 'UPDATE', 'volunteers', id, oldVolunteer, newVolunteer, `تحديث بيانات المتطوع: ${newVolunteer.full_name}`);

    res.json({
      success: true,
      message: 'تم تحديث بيانات المتطوع بنجاح',
      data: {
        volunteer: newVolunteer
      }
    });

  } catch (error) {
    console.error('❌ خطأ في تحديث المتطوع:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في تحديث بيانات المتطوع',
      code: 'UPDATE_VOLUNTEER_ERROR'
    });
  }
});

/**
 * إيقاف/تفعيل متطوع
 * PATCH /api/volunteers/:id/status
 */
router.patch('/:id/status', authenticateToken, requireEvaluator, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active, reason } = req.body;

    if (typeof is_active !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'حالة التفعيل يجب أن تكون true أو false',
        code: 'INVALID_STATUS'
      });
    }

    // التحقق من وجود المتطوع
    const existingVolunteerResult = await query('SELECT * FROM volunteers WHERE id = $1', [id]);
    if (existingVolunteerResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'المتطوع غير موجود',
        code: 'VOLUNTEER_NOT_FOUND'
      });
    }

    const oldVolunteer = existingVolunteerResult.rows[0];

    // تحديث الحالة
    const updatedVolunteer = await query(
      'UPDATE volunteers SET is_active = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
      [is_active, req.user.id, id]
    );

    const newVolunteer = updatedVolunteer.rows[0];

    // إضافة ملاحظة تراكمية
    const statusNote = is_active ? 'تم تفعيل المتطوع' : 'تم إيقاف المتطوع';
    const fullNote = reason ? `${statusNote} - السبب: ${reason}` : statusNote;

    await query(
      `INSERT INTO cumulative_notes (volunteer_id, note_type, content, is_positive, created_by)
       VALUES ($1, 'improvement', $2, $3, $4)`,
      [id, fullNote, is_active, req.user.id]
    );

    // تسجيل العملية
    await logAuditTrail(req, 'UPDATE', 'volunteers', id, oldVolunteer, newVolunteer, `${statusNote}: ${newVolunteer.full_name}`);

    res.json({
      success: true,
      message: `تم ${is_active ? 'تفعيل' : 'إيقاف'} المتطوع بنجاح`,
      data: {
        volunteer: newVolunteer
      }
    });

  } catch (error) {
    console.error('❌ خطأ في تغيير حالة المتطوع:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في تغيير حالة المتطوع',
      code: 'UPDATE_VOLUNTEER_STATUS_ERROR'
    });
  }
});

/**
 * حذف متطوع (أدمن فقط)
 * DELETE /api/volunteers/:id
 */
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // التحقق من وجود المتطوع
    const existingVolunteerResult = await query('SELECT * FROM volunteers WHERE id = $1', [id]);
    if (existingVolunteerResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'المتطوع غير موجود',
        code: 'VOLUNTEER_NOT_FOUND'
      });
    }

    const volunteer = existingVolunteerResult.rows[0];

    // حذف المتطوع (سيحذف تلقائياً البيانات المرتبطة بسبب CASCADE)
    await transaction(async (client) => {
      // حذف التقييمات والتفاصيل
      await client.query('DELETE FROM evaluation_details WHERE evaluation_id IN (SELECT id FROM evaluations WHERE volunteer_id = $1)', [id]);
      await client.query('DELETE FROM evaluations WHERE volunteer_id = $1', [id]);
      
      // حذف الملاحظات والتنبيهات
      await client.query('DELETE FROM cumulative_notes WHERE volunteer_id = $1', [id]);
      await client.query('DELETE FROM alert_records WHERE volunteer_id = $1', [id]);
      await client.query('DELETE FROM freeze_records WHERE volunteer_id = $1', [id]);
      
      // حذف المتطوع
      await client.query('DELETE FROM volunteers WHERE id = $1', [id]);
    });

    // تسجيل العملية
    await logAuditTrail(req, 'DELETE', 'volunteers', id, volunteer, null, `حذف المتطوع: ${volunteer.full_name}`);

    res.json({
      success: true,
      message: 'تم حذف المتطوع وجميع بياناته بنجاح',
      data: {
        deleted_volunteer: {
          id: volunteer.id,
          full_name: volunteer.full_name
        }
      }
    });

  } catch (error) {
    console.error('❌ خطأ في حذف المتطوع:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في حذف المتطوع',
      code: 'DELETE_VOLUNTEER_ERROR'
    });
  }
});

/**
 * إحصائيات المتطوعين
 * GET /api/volunteers/stats
 */
router.get('/statistics/overview', authenticateToken, requireEvaluator, async (req, res) => {
  try {
    // إحصائيات عامة
    const generalStatsQuery = `
      SELECT 
        COUNT(*) as total_volunteers,
        COUNT(*) FILTER (WHERE is_active = true) as active_volunteers,
        COUNT(*) FILTER (WHERE is_active = false) as inactive_volunteers,
        COUNT(*) FILTER (WHERE role_type = 'ميداني') as field_volunteers,
        COUNT(*) FILTER (WHERE role_type = 'إداري') as admin_volunteers,
        COUNT(*) FILTER (WHERE role_type = 'مسئول ملف') as file_manager_volunteers,
        COUNT(*) FILTER (WHERE EXTRACT(YEAR FROM join_date) = EXTRACT(YEAR FROM CURRENT_DATE)) as new_this_year,
        COUNT(*) FILTER (WHERE EXTRACT(MONTH FROM join_date) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM join_date) = EXTRACT(YEAR FROM CURRENT_DATE)) as new_this_month
      FROM volunteers
    `;

    const generalStats = await query(generalStatsQuery);

    // إحصائيات الفريز
    const freezeStatsQuery = `
      SELECT 
        COUNT(DISTINCT volunteer_id) as volunteers_with_freeze,
        COUNT(*) as total_freeze_records,
        COUNT(*) FILTER (WHERE CURRENT_DATE BETWEEN start_date AND end_date) as currently_frozen,
        ROUND(AVG(end_date - start_date), 2) as avg_freeze_duration_days
      FROM freeze_records
      WHERE freeze_year = EXTRACT(YEAR FROM CURRENT_DATE) AND is_active = true
    `;

    const freezeStats = await query(freezeStatsQuery);

    // إحصائيات التقييمات
    const evaluationStatsQuery = `
      SELECT 
        COUNT(*) as total_evaluations,
        COUNT(*) FILTER (WHERE evaluation_month = EXTRACT(MONTH FROM CURRENT_DATE) AND evaluation_year = EXTRACT(YEAR FROM CURRENT_DATE)) as current_month_evaluations,
        ROUND(AVG(percentage), 2) as avg_performance_percentage,
        COUNT(*) FILTER (WHERE percentage >= 80) as high_performers,
        COUNT(*) FILTER (WHERE percentage < 60) as needs_improvement
      FROM evaluations
      WHERE evaluation_year = EXTRACT(YEAR FROM CURRENT_DATE)
    `;

    const evaluationStats = await query(evaluationStatsQuery);

    // التنبيهات النشطة
    const alertsStatsQuery = `
      SELECT 
        COUNT(*) as total_active_alerts,
        COUNT(*) FILTER (WHERE severity = 'high') as high_priority_alerts,
        COUNT(*) FILTER (WHERE alert_type = 'weak_performance') as performance_alerts,
        COUNT(*) FILTER (WHERE alert_type = 'no_interaction') as interaction_alerts
      FROM alert_records
      WHERE is_resolved = false
    `;

    const alertsStats = await query(alertsStatsQuery);

    res.json({
      success: true,
      data: {
        general: generalStats.rows[0],
        freeze: freezeStats.rows[0],
        evaluation: evaluationStats.rows[0],
        alerts: alertsStats.rows[0],
        generated_at: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ خطأ في جلب إحصائيات المتطوعين:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في جلب الإحصائيات',
      code: 'GET_STATISTICS_ERROR'
    });
  }
});

module.exports = router;