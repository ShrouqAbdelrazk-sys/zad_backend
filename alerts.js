/**
 * مسارات التنبيهات الذكية
 * Smart Alerts Management Routes
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../config/database');
const { authenticateToken, requireAdmin, requireEvaluator, logAuditTrail } = require('../middleware/auth');

const router = express.Router();

/**
 * جلب جميع التنبيهات
 * GET /api/alerts
 */
router.get('/', authenticateToken, requireEvaluator, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 10, 
      volunteer_id,
      alert_type,
      severity,
      is_resolved,
      sort_by = 'created_at',
      sort_order = 'desc'
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    // بناء شروط البحث
    let whereClause = 'WHERE 1=1';
    const queryParams = [];
    let paramIndex = 1;

    if (volunteer_id) {
      whereClause += ` AND ar.volunteer_id = $${paramIndex}`;
      queryParams.push(volunteer_id);
      paramIndex++;
    }

    if (alert_type) {
      whereClause += ` AND ar.alert_type = $${paramIndex}`;
      queryParams.push(alert_type);
      paramIndex++;
    }

    if (severity) {
      whereClause += ` AND ar.severity = $${paramIndex}`;
      queryParams.push(severity);
      paramIndex++;
    }

    if (is_resolved !== undefined) {
      whereClause += ` AND ar.is_resolved = $${paramIndex}`;
      queryParams.push(is_resolved === 'true');
      paramIndex++;
    }

    // التحقق من صحة ترتيب النتائج
    const validSortFields = ['created_at', 'severity', 'alert_type'];
    const validSortOrders = ['asc', 'desc'];
    
    const sortBy = validSortFields.includes(sort_by) ? sort_by : 'created_at';
    const sortOrder = validSortOrders.includes(sort_order.toLowerCase()) ? sort_order.toLowerCase() : 'desc';

    // إحصاء إجمالي
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM alert_records ar
      ${whereClause}
    `;
    const countResult = await query(countQuery, queryParams);
    const total = parseInt(countResult.rows[0].total);

    // جلب التنبيهات
    queryParams.push(parseInt(limit), offset);
    const alertsQuery = `
      SELECT 
        ar.*,
        v.full_name as volunteer_name,
        v.role_type as volunteer_role,
        ec.name_ar as criteria_name,
        u.full_name as resolved_by_name,
        CASE 
          WHEN ar.severity = 'high' THEN 'عالي'
          WHEN ar.severity = 'medium' THEN 'متوسط'
          ELSE 'منخفض'
        END as severity_ar,
        CASE 
          WHEN ar.alert_type = 'weak_performance' THEN 'ضعف أداء'
          WHEN ar.alert_type = 'no_interaction' THEN 'عدم تفاعل'
          WHEN ar.alert_type = 'improvement_needed' THEN 'يحتاج تحسين'
          ELSE 'إنجاز'
        END as alert_type_ar
      FROM alert_records ar
      INNER JOIN volunteers v ON ar.volunteer_id = v.id
      LEFT JOIN evaluation_criteria ec ON ar.criteria_id = ec.id
      LEFT JOIN users u ON ar.resolved_by = u.id
      ${whereClause}
      ORDER BY ar.${sortBy} ${sortOrder}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const alertsResult = await query(alertsQuery, queryParams);

    res.json({
      success: true,
      data: {
        alerts: alertsResult.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        },
        filters: {
          volunteer_id: volunteer_id || null,
          alert_type: alert_type || null,
          severity: severity || null,
          is_resolved: is_resolved || null
        }
      }
    });

  } catch (error) {
    console.error('❌ خطأ في جلب التنبيهات:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في جلب التنبيهات',
      code: 'GET_ALERTS_ERROR'
    });
  }
});

/**
 * جلب تنبيه محدد
 * GET /api/alerts/:id
 */
router.get('/:id', authenticateToken, requireEvaluator, async (req, res) => {
  try {
    const { id } = req.params;

    const alertQuery = `
      SELECT 
        ar.*,
        v.full_name as volunteer_name,
        v.role_type as volunteer_role,
        v.phone as volunteer_phone,
        ec.name_ar as criteria_name,
        u.full_name as resolved_by_name
      FROM alert_records ar
      INNER JOIN volunteers v ON ar.volunteer_id = v.id
      LEFT JOIN evaluation_criteria ec ON ar.criteria_id = ec.id
      LEFT JOIN users u ON ar.resolved_by = u.id
      WHERE ar.id = $1
    `;

    const alertResult = await query(alertQuery, [id]);

    if (alertResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'التنبيه غير موجود',
        code: 'ALERT_NOT_FOUND'
      });
    }

    const alert = alertResult.rows[0];

    // جلب التقييمات ذات العلاقة إذا كان التنبيه مرتبط بمعيار محدد
    let relatedEvaluations = [];
    if (alert.criteria_id) {
      const evaluationsQuery = `
        SELECT 
          e.evaluation_month,
          e.evaluation_year,
          e.percentage as overall_percentage,
          ed.score_value as criteria_score,
          ec.max_score as criteria_max_score,
          ROUND((ed.score_value / ec.max_score) * 100, 2) as criteria_percentage
        FROM evaluations e
        INNER JOIN evaluation_details ed ON e.id = ed.evaluation_id
        INNER JOIN evaluation_criteria ec ON ed.criteria_id = ec.id
        WHERE e.volunteer_id = $1 
        AND ed.criteria_id = $2
        AND e.status = 'approved'
        ORDER BY e.evaluation_year DESC, e.evaluation_month DESC
        LIMIT 6
      `;

      const evaluationsResult = await query(evaluationsQuery, [alert.volunteer_id, alert.criteria_id]);
      relatedEvaluations = evaluationsResult.rows;
    }

    res.json({
      success: true,
      data: {
        alert: alert,
        related_evaluations: relatedEvaluations,
        recommendations: generateRecommendations(alert, relatedEvaluations)
      }
    });

  } catch (error) {
    console.error('❌ خطأ في جلب التنبيه:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في جلب التنبيه',
      code: 'GET_ALERT_ERROR'
    });
  }
});

/**
 * إنشاء تنبيه يدوي (أدمن والمقيمين)
 * POST /api/alerts
 */
router.post('/', [
  authenticateToken,
  requireEvaluator,
  body('volunteer_id').isUUID().withMessage('معرف المتطوع غير صالح'),
  body('alert_type').isIn(['weak_performance', 'no_interaction', 'improvement_needed', 'achievement']).withMessage('نوع التنبيه غير صالح'),
  body('alert_message').notEmpty().withMessage('رسالة التنبيه مطلوبة'),
  body('severity').isIn(['low', 'medium', 'high']).withMessage('مستوى الأولوية غير صالح')
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
      volunteer_id,
      alert_type,
      criteria_id,
      alert_message,
      severity,
      trigger_condition
    } = req.body;

    // التحقق من وجود المتطوع
    const volunteerResult = await query('SELECT * FROM volunteers WHERE id = $1', [volunteer_id]);
    if (volunteerResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'المتطوع غير موجود',
        code: 'VOLUNTEER_NOT_FOUND'
      });
    }

    const volunteer = volunteerResult.rows[0];

    // إنشاء التنبيه
    const newAlertQuery = `
      INSERT INTO alert_records (
        volunteer_id, alert_type, criteria_id, trigger_condition, 
        alert_message, severity, consecutive_months
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;

    const newAlert = await query(newAlertQuery, [
      volunteer_id,
      alert_type,
      criteria_id || null,
      trigger_condition ? JSON.stringify(trigger_condition) : '{}',
      alert_message,
      severity,
      0 // للتنبيهات اليدوية
    ]);

    const alert = newAlert.rows[0];

    // تسجيل العملية
    await logAuditTrail(req, 'CREATE', 'alert_records', alert.id, null, alert, `إنشاء تنبيه يدوي للمتطوع: ${volunteer.full_name}`);

    res.status(201).json({
      success: true,
      message: 'تم إنشاء التنبيه بنجاح',
      data: {
        alert: alert
      }
    });

  } catch (error) {
    console.error('❌ خطأ في إنشاء التنبيه:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في إنشاء التنبيه',
      code: 'CREATE_ALERT_ERROR'
    });
  }
});

/**
 * حل تنبيه
 * PATCH /api/alerts/:id/resolve
 */
router.patch('/:id/resolve', [
  authenticateToken,
  requireEvaluator,
  body('resolution_notes').optional().isLength({ max: 1000 }).withMessage('ملاحظات الحل طويلة جداً')
], async (req, res) => {
  try {
    const { id } = req.params;
    const { resolution_notes } = req.body;

    // التحقق من وجود التنبيه
    const alertResult = await query('SELECT * FROM alert_records WHERE id = $1', [id]);
    if (alertResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'التنبيه غير موجود',
        code: 'ALERT_NOT_FOUND'
      });
    }

    const alert = alertResult.rows[0];

    if (alert.is_resolved) {
      return res.status(409).json({
        success: false,
        message: 'التنبيه محلول بالفعل',
        code: 'ALERT_ALREADY_RESOLVED'
      });
    }

    // حل التنبيه
    const resolvedAlert = await query(
      `UPDATE alert_records 
       SET is_resolved = true, resolved_by = $1, resolved_at = CURRENT_TIMESTAMP, resolution_notes = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 
       RETURNING *`,
      [req.user.id, resolution_notes || null, id]
    );

    // إضافة ملاحظة تراكمية للمتطوع
    const noteContent = `تم حل التنبيه: ${alert.alert_message}${resolution_notes ? ` - ${resolution_notes}` : ''}`;
    await query(
      `INSERT INTO cumulative_notes (volunteer_id, note_type, content, is_positive, created_by)
       VALUES ($1, 'improvement', $2, true, $3)`,
      [alert.volunteer_id, noteContent, req.user.id]
    );

    // تسجيل العملية
    await logAuditTrail(req, 'UPDATE', 'alert_records', id, alert, resolvedAlert.rows[0], 'حل التنبيه');

    res.json({
      success: true,
      message: 'تم حل التنبيه بنجاح',
      data: {
        alert: resolvedAlert.rows[0]
      }
    });

  } catch (error) {
    console.error('❌ خطأ في حل التنبيه:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في حل التنبيه',
      code: 'RESOLVE_ALERT_ERROR'
    });
  }
});

/**
 * حذف تنبيه (أدمن فقط)
 * DELETE /api/alerts/:id
 */
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // التحقق من وجود التنبيه
    const alertResult = await query('SELECT * FROM alert_records WHERE id = $1', [id]);
    if (alertResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'التنبيه غير موجود',
        code: 'ALERT_NOT_FOUND'
      });
    }

    const alert = alertResult.rows[0];

    // حذف التنبيه
    await query('DELETE FROM alert_records WHERE id = $1', [id]);

    // تسجيل العملية
    await logAuditTrail(req, 'DELETE', 'alert_records', id, alert, null, 'حذف التنبيه');

    res.json({
      success: true,
      message: 'تم حذف التنبيه بنجاح',
      data: {
        deleted_alert: {
          id: alert.id,
          alert_type: alert.alert_type,
          alert_message: alert.alert_message
        }
      }
    });

  } catch (error) {
    console.error('❌ خطأ في حذف التنبيه:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في حذف التنبيه',
      code: 'DELETE_ALERT_ERROR'
    });
  }
});

/**
 * فحص وتوليد التنبيهات الذكية التلقائية
 * POST /api/alerts/check-automatic
 */
router.post('/check-automatic', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const newAlerts = [];

    // فحص ضعف الأداء لمدة 3 شهور متتالية
    const weakPerformanceQuery = `
      WITH consecutive_weak AS (
        SELECT 
          volunteer_id,
          COUNT(*) as weak_months,
          MIN(evaluation_year) as start_year,
          MIN(evaluation_month) as start_month,
          MAX(evaluation_year) as end_year,
          MAX(evaluation_month) as end_month
        FROM evaluations
        WHERE percentage < 60 
        AND status = 'approved'
        AND evaluation_year >= EXTRACT(YEAR FROM CURRENT_DATE) - 1
        GROUP BY volunteer_id
        HAVING COUNT(*) >= 3
      )
      SELECT 
        cw.*,
        v.full_name as volunteer_name
      FROM consecutive_weak cw
      INNER JOIN volunteers v ON cw.volunteer_id = v.id
      WHERE NOT EXISTS (
        SELECT 1 FROM alert_records ar 
        WHERE ar.volunteer_id = cw.volunteer_id 
        AND ar.alert_type = 'weak_performance' 
        AND ar.is_resolved = false
      )
    `;

    const weakPerformanceResult = await query(weakPerformanceQuery);

    for (const record of weakPerformanceResult.rows) {
      const alertMessage = `المتطوع ${record.volunteer_name} يظهر أداء ضعيف لمدة ${record.weak_months} شهر متتالي`;
      
      const newAlert = await query(
        `INSERT INTO alert_records (volunteer_id, alert_type, trigger_condition, alert_message, severity, consecutive_months)
         VALUES ($1, 'weak_performance', $2, $3, 'high', $4)
         RETURNING *`,
        [
          record.volunteer_id,
          JSON.stringify({
            type: 'consecutive_weak_performance',
            months: record.weak_months,
            threshold: 60
          }),
          alertMessage,
          record.weak_months
        ]
      );

      newAlerts.push(newAlert.rows[0]);
    }

    // فحص عدم التفاعل لمدة شهرين
    const noInteractionQuery = `
      WITH last_two_months AS (
        SELECT 
          e.volunteer_id,
          COUNT(*) as no_interaction_count,
          v.full_name as volunteer_name
        FROM evaluations e
        INNER JOIN evaluation_details ed ON e.id = ed.evaluation_id
        INNER JOIN evaluation_criteria ec ON ed.criteria_id = ec.id
        INNER JOIN volunteers v ON e.volunteer_id = v.id
        WHERE ec.name_ar ILIKE '%تفاعل%' OR ec.name_ar ILIKE '%جروب%'
        AND (ed.score_value IS NULL OR ed.score_value < 3)
        AND e.status = 'approved'
        AND e.evaluation_year = EXTRACT(YEAR FROM CURRENT_DATE)
        AND e.evaluation_month >= EXTRACT(MONTH FROM CURRENT_DATE) - 2
        AND e.is_frozen = false
        GROUP BY e.volunteer_id, v.full_name
        HAVING COUNT(*) >= 2
      )
      SELECT *
      FROM last_two_months
      WHERE NOT EXISTS (
        SELECT 1 FROM alert_records ar 
        WHERE ar.volunteer_id = last_two_months.volunteer_id 
        AND ar.alert_type = 'no_interaction' 
        AND ar.is_resolved = false
      )
    `;

    const noInteractionResult = await query(noInteractionQuery);

    for (const record of noInteractionResult.rows) {
      const alertMessage = `المتطوع ${record.volunteer_name} يظهر عدم تفاعل في المجموعات لمدة ${record.no_interaction_count} شهر`;
      
      const newAlert = await query(
        `INSERT INTO alert_records (volunteer_id, alert_type, trigger_condition, alert_message, severity, consecutive_months)
         VALUES ($1, 'no_interaction', $2, $3, 'medium', $4)
         RETURNING *`,
        [
          record.volunteer_id,
          JSON.stringify({
            type: 'no_group_interaction',
            months: record.no_interaction_count,
            threshold: 3
          }),
          alertMessage,
          record.no_interaction_count
        ]
      );

      newAlerts.push(newAlert.rows[0]);
    }

    // تسجيل العملية
    await logAuditTrail(req, 'CREATE', 'alert_records', 'automatic', null, { count: newAlerts.length }, 'فحص وتوليد التنبيهات التلقائية');

    res.json({
      success: true,
      message: `تم فحص التنبيهات وإنشاء ${newAlerts.length} تنبيه جديد`,
      data: {
        new_alerts_count: newAlerts.length,
        alerts: newAlerts
      }
    });

  } catch (error) {
    console.error('❌ خطأ في فحص التنبيهات التلقائية:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في فحص التنبيهات التلقائية',
      code: 'CHECK_AUTOMATIC_ALERTS_ERROR'
    });
  }
});

/**
 * إحصائيات التنبيهات
 * GET /api/alerts/statistics/overview
 */
router.get('/statistics/overview', authenticateToken, requireEvaluator, async (req, res) => {
  try {
    // إحصائيات عامة
    const generalStatsQuery = `
      SELECT 
        COUNT(*) as total_alerts,
        COUNT(*) FILTER (WHERE is_resolved = false) as active_alerts,
        COUNT(*) FILTER (WHERE is_resolved = true) as resolved_alerts,
        COUNT(*) FILTER (WHERE severity = 'high') as high_priority_alerts,
        COUNT(*) FILTER (WHERE severity = 'medium') as medium_priority_alerts,
        COUNT(*) FILTER (WHERE severity = 'low') as low_priority_alerts,
        COUNT(*) FILTER (WHERE alert_type = 'weak_performance') as performance_alerts,
        COUNT(*) FILTER (WHERE alert_type = 'no_interaction') as interaction_alerts,
        COUNT(*) FILTER (WHERE alert_type = 'improvement_needed') as improvement_alerts,
        COUNT(*) FILTER (WHERE alert_type = 'achievement') as achievement_alerts
      FROM alert_records
    `;

    const generalStats = await query(generalStatsQuery);

    // التنبيهات الأكثر شيوعاً
    const commonAlertsQuery = `
      SELECT 
        alert_type,
        COUNT(*) as count,
        CASE 
          WHEN alert_type = 'weak_performance' THEN 'ضعف أداء'
          WHEN alert_type = 'no_interaction' THEN 'عدم تفاعل'
          WHEN alert_type = 'improvement_needed' THEN 'يحتاج تحسين'
          ELSE 'إنجاز'
        END as alert_type_ar
      FROM alert_records
      WHERE is_resolved = false
      GROUP BY alert_type
      ORDER BY count DESC
    `;

    const commonAlerts = await query(commonAlertsQuery);

    // المتطوعين الأكثر تنبيهات
    const mostAlertsVolunteersQuery = `
      SELECT 
        v.full_name,
        v.role_type,
        COUNT(ar.id) as alerts_count,
        COUNT(ar.id) FILTER (WHERE ar.is_resolved = false) as active_alerts_count
      FROM alert_records ar
      INNER JOIN volunteers v ON ar.volunteer_id = v.id
      GROUP BY v.id, v.full_name, v.role_type
      ORDER BY alerts_count DESC
      LIMIT 10
    `;

    const mostAlertsVolunteers = await query(mostAlertsVolunteersQuery);

    res.json({
      success: true,
      data: {
        general_stats: generalStats.rows[0],
        common_alert_types: commonAlerts.rows,
        volunteers_with_most_alerts: mostAlertsVolunteers.rows,
        resolution_rate: generalStats.rows[0].total_alerts > 0 
          ? Math.round((generalStats.rows[0].resolved_alerts / generalStats.rows[0].total_alerts) * 100)
          : 0,
        generated_at: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ خطأ في جلب إحصائيات التنبيهات:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في جلب إحصائيات التنبيهات',
      code: 'GET_ALERTS_STATISTICS_ERROR'
    });
  }
});

/**
 * دالة مساعدة لتوليد التوصيات حسب نوع التنبيه
 */
function generateRecommendations(alert, relatedEvaluations) {
  const recommendations = [];

  switch (alert.alert_type) {
    case 'weak_performance':
      recommendations.push('مراجعة أهداف المتطوع وتقديم التدريب اللازم');
      recommendations.push('تخصيص مرشد أو مشرف لمتابعة التطوير');
      recommendations.push('وضع خطة تحسين مخصصة مع مواعيد محددة');
      if (relatedEvaluations.length > 0) {
        const avgPerformance = relatedEvaluations.reduce((sum, e) => sum + e.criteria_percentage, 0) / relatedEvaluations.length;
        if (avgPerformance < 40) {
          recommendations.push('النظر في إعادة تأهيل المتطوع أو تغيير دوره');
        }
      }
      break;

    case 'no_interaction':
      recommendations.push('التواصل المباشر مع المتطوع لمعرفة الأسباب');
      recommendations.push('تحفيز المشاركة في الأنشطة الاجتماعية للفريق');
      recommendations.push('تقديم ورش تدريبية حول أهمية التواصل والتفاعل');
      break;

    case 'improvement_needed':
      recommendations.push('تحديد المجالات المحددة التي تحتاج تطوير');
      recommendations.push('وضع خطة تدريبية مرحلية');
      recommendations.push('متابعة دورية للتقدم المحرز');
      break;

    case 'achievement':
      recommendations.push('تقدير وشكر المتطوع على الإنجاز المتميز');
      recommendations.push('مشاركة النجاح مع باقي أعضاء الفريق');
      recommendations.push('النظر في إسناد مسؤوليات إضافية أو قيادية');
      break;
  }

  return recommendations;
}

module.exports = router;