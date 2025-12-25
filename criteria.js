/**
 * مسارات إدارة معايير التقييم
 * Evaluation Criteria Management Routes
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../config/database');
const { authenticateToken, requireAdmin, requireEvaluator, logAuditTrail } = require('../middleware/auth');

const router = express.Router();

/**
 * جلب جميع معايير التقييم
 * GET /api/criteria
 */
router.get('/', authenticateToken, requireEvaluator, async (req, res) => {
  try {
    const { 
      category, 
      applies_to_role, 
      is_active,
      include_inactive = false
    } = req.query;

    // بناء شروط البحث
    let whereClause = 'WHERE 1=1';
    const queryParams = [];
    let paramIndex = 1;

    if (!include_inactive || include_inactive === 'false') {
      whereClause += ' AND is_active = true';
    }

    if (category) {
      whereClause += ` AND category = $${paramIndex}`;
      queryParams.push(category);
      paramIndex++;
    }

    if (applies_to_role) {
      whereClause += ` AND (applies_to_role = $${paramIndex} OR applies_to_role = 'all')`;
      queryParams.push(applies_to_role);
      paramIndex++;
    }

    if (is_active !== undefined) {
      whereClause += ` AND is_active = $${paramIndex}`;
      queryParams.push(is_active === 'true');
      paramIndex++;
    }

    const criteriaQuery = `
      SELECT * FROM evaluation_criteria
      ${whereClause}
      ORDER BY category, sort_order, name_ar
    `;

    const criteriaResult = await query(criteriaQuery, queryParams);

    // تجميع النتائج حسب الفئة
    const groupedCriteria = criteriaResult.rows.reduce((acc, criterion) => {
      if (!acc[criterion.category]) {
        acc[criterion.category] = [];
      }
      acc[criterion.category].push(criterion);
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        criteria: criteriaResult.rows,
        grouped_criteria: groupedCriteria,
        categories: {
          basic: 'المعايير الأساسية',
          responsibility: 'معايير المسؤولية',
          bonus: 'معايير البونص'
        },
        total_count: criteriaResult.rows.length
      }
    });

  } catch (error) {
    console.error('❌ خطأ في جلب معايير التقييم:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في جلب معايير التقييم',
      code: 'GET_CRITERIA_ERROR'
    });
  }
});

/**
 * جلب معيار تقييم محدد
 * GET /api/criteria/:id
 */
router.get('/:id', authenticateToken, requireEvaluator, async (req, res) => {
  try {
    const { id } = req.params;

    const criterionResult = await query(
      'SELECT * FROM evaluation_criteria WHERE id = $1',
      [id]
    );

    if (criterionResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'معيار التقييم غير موجود',
        code: 'CRITERION_NOT_FOUND'
      });
    }

    const criterion = criterionResult.rows[0];

    // جلب إحصائيات استخدام المعيار
    const usageStatsQuery = `
      SELECT 
        COUNT(*) as total_evaluations,
        ROUND(AVG(score_value), 2) as avg_score,
        MIN(score_value) as min_score,
        MAX(score_value) as max_score,
        COUNT(*) FILTER (WHERE score_value >= (${criterion.max_score} * 0.8)) as high_scores,
        COUNT(*) FILTER (WHERE score_value < (${criterion.max_score} * 0.6)) as low_scores
      FROM evaluation_details
      WHERE criteria_id = $1
    `;

    const statsResult = await query(usageStatsQuery, [id]);

    res.json({
      success: true,
      data: {
        criterion: criterion,
        usage_stats: statsResult.rows[0]
      }
    });

  } catch (error) {
    console.error('❌ خطأ في جلب معيار التقييم:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في جلب معيار التقييم',
      code: 'GET_CRITERION_ERROR'
    });
  }
});

/**
 * إضافة معيار تقييم جديد (أدمن فقط)
 * POST /api/criteria
 */
router.post('/', [
  authenticateToken,
  requireAdmin,
  body('name_ar').notEmpty().withMessage('الاسم العربي مطلوب'),
  body('category').isIn(['basic', 'responsibility', 'bonus']).withMessage('فئة غير صالحة'),
  body('weight').optional().isFloat({ min: 0 }).withMessage('الوزن يجب أن يكون رقم موجب'),
  body('max_score').optional().isInt({ min: 1 }).withMessage('النقاط القصوى يجب أن تكون رقم صحيح موجب'),
  body('data_type').isIn(['numeric', 'text', 'choice', 'boolean']).withMessage('نوع البيانات غير صالح'),
  body('applies_to_role').isIn(['all', 'ميداني', 'إداري', 'مسئول ملف']).withMessage('الدور المطبق عليه غير صالح')
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
      name_ar,
      name_en,
      description,
      category,
      weight = 1.0,
      max_score = 10,
      data_type,
      choices,
      is_required = true,
      show_in_report = true,
      applies_to_role = 'all',
      sort_order = 0
    } = req.body;

    // التحقق من عدم تكرار الاسم
    const existingCriterion = await query(
      'SELECT id FROM evaluation_criteria WHERE name_ar = $1',
      [name_ar]
    );

    if (existingCriterion.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'معيار التقييم بهذا الاسم موجود بالفعل',
        code: 'CRITERION_EXISTS'
      });
    }

    // إدراج المعيار الجديد
    const newCriterionQuery = `
      INSERT INTO evaluation_criteria (
        name_ar, name_en, description, category, weight, max_score, 
        data_type, choices, is_required, show_in_report, applies_to_role, sort_order
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `;

    const newCriterion = await query(newCriterionQuery, [
      name_ar,
      name_en || null,
      description || null,
      category,
      weight,
      max_score,
      data_type,
      choices ? JSON.stringify(choices) : null,
      is_required,
      show_in_report,
      applies_to_role,
      sort_order
    ]);

    const criterion = newCriterion.rows[0];

    // تسجيل العملية
    await logAuditTrail(req, 'CREATE', 'evaluation_criteria', criterion.id, null, criterion, `إضافة معيار تقييم جديد: ${name_ar}`);

    res.status(201).json({
      success: true,
      message: 'تم إضافة معيار التقييم بنجاح',
      data: {
        criterion: criterion
      }
    });

  } catch (error) {
    console.error('❌ خطأ في إضافة معيار التقييم:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في إضافة معيار التقييم',
      code: 'CREATE_CRITERION_ERROR'
    });
  }
});

/**
 * تحديث معيار تقييم (أدمن فقط)
 * PUT /api/criteria/:id
 */
router.put('/:id', [
  authenticateToken,
  requireAdmin,
  body('name_ar').optional().notEmpty().withMessage('الاسم العربي لا يمكن أن يكون فارغاً'),
  body('category').optional().isIn(['basic', 'responsibility', 'bonus']).withMessage('فئة غير صالحة'),
  body('weight').optional().isFloat({ min: 0 }).withMessage('الوزن يجب أن يكون رقم موجب'),
  body('max_score').optional().isInt({ min: 1 }).withMessage('النقاط القصوى يجب أن تكون رقم صحيح موجب'),
  body('data_type').optional().isIn(['numeric', 'text', 'choice', 'boolean']).withMessage('نوع البيانات غير صالح'),
  body('applies_to_role').optional().isIn(['all', 'ميداني', 'إداري', 'مسئول ملف']).withMessage('الدور المطبق عليه غير صالح')
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

    // التحقق من وجود المعيار
    const existingCriterionResult = await query('SELECT * FROM evaluation_criteria WHERE id = $1', [id]);
    if (existingCriterionResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'معيار التقييم غير موجود',
        code: 'CRITERION_NOT_FOUND'
      });
    }

    const oldCriterion = existingCriterionResult.rows[0];

    const {
      name_ar,
      name_en,
      description,
      category,
      weight,
      max_score,
      data_type,
      choices,
      is_required,
      show_in_report,
      applies_to_role,
      sort_order
    } = req.body;

    // التحقق من عدم تكرار الاسم (إذا تم تغييره)
    if (name_ar && name_ar !== oldCriterion.name_ar) {
      const duplicateName = await query(
        'SELECT id FROM evaluation_criteria WHERE name_ar = $1 AND id != $2',
        [name_ar, id]
      );

      if (duplicateName.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'معيار التقييم بهذا الاسم موجود بالفعل',
          code: 'CRITERION_EXISTS'
        });
      }
    }

    // بناء الاستعلام التحديثي
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name_ar !== undefined) {
      updates.push(`name_ar = $${paramIndex}`);
      values.push(name_ar);
      paramIndex++;
    }

    if (name_en !== undefined) {
      updates.push(`name_en = $${paramIndex}`);
      values.push(name_en);
      paramIndex++;
    }

    if (description !== undefined) {
      updates.push(`description = $${paramIndex}`);
      values.push(description);
      paramIndex++;
    }

    if (category !== undefined) {
      updates.push(`category = $${paramIndex}`);
      values.push(category);
      paramIndex++;
    }

    if (weight !== undefined) {
      updates.push(`weight = $${paramIndex}`);
      values.push(weight);
      paramIndex++;
    }

    if (max_score !== undefined) {
      updates.push(`max_score = $${paramIndex}`);
      values.push(max_score);
      paramIndex++;
    }

    if (data_type !== undefined) {
      updates.push(`data_type = $${paramIndex}`);
      values.push(data_type);
      paramIndex++;
    }

    if (choices !== undefined) {
      updates.push(`choices = $${paramIndex}`);
      values.push(choices ? JSON.stringify(choices) : null);
      paramIndex++;
    }

    if (is_required !== undefined) {
      updates.push(`is_required = $${paramIndex}`);
      values.push(is_required);
      paramIndex++;
    }

    if (show_in_report !== undefined) {
      updates.push(`show_in_report = $${paramIndex}`);
      values.push(show_in_report);
      paramIndex++;
    }

    if (applies_to_role !== undefined) {
      updates.push(`applies_to_role = $${paramIndex}`);
      values.push(applies_to_role);
      paramIndex++;
    }

    if (sort_order !== undefined) {
      updates.push(`sort_order = $${paramIndex}`);
      values.push(sort_order);
      paramIndex++;
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'لا توجد بيانات للتحديث',
        code: 'NO_UPDATES'
      });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id); // لشرط WHERE

    const updateQuery = `
      UPDATE evaluation_criteria 
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const updatedCriterion = await query(updateQuery, values);
    const newCriterion = updatedCriterion.rows[0];

    // تسجيل العملية
    await logAuditTrail(req, 'UPDATE', 'evaluation_criteria', id, oldCriterion, newCriterion, `تحديث معيار التقييم: ${newCriterion.name_ar}`);

    res.json({
      success: true,
      message: 'تم تحديث معيار التقييم بنجاح',
      data: {
        criterion: newCriterion
      }
    });

  } catch (error) {
    console.error('❌ خطأ في تحديث معيار التقييم:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في تحديث معيار التقييم',
      code: 'UPDATE_CRITERION_ERROR'
    });
  }
});

/**
 * تغيير حالة تفعيل معيار التقييم (أدمن فقط)
 * PATCH /api/criteria/:id/status
 */
router.patch('/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    if (typeof is_active !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'حالة التفعيل يجب أن تكون true أو false',
        code: 'INVALID_STATUS'
      });
    }

    // التحقق من وجود المعيار
    const existingCriterionResult = await query('SELECT * FROM evaluation_criteria WHERE id = $1', [id]);
    if (existingCriterionResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'معيار التقييم غير موجود',
        code: 'CRITERION_NOT_FOUND'
      });
    }

    const oldCriterion = existingCriterionResult.rows[0];

    // تحديث الحالة
    const updatedCriterion = await query(
      'UPDATE evaluation_criteria SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [is_active, id]
    );

    const newCriterion = updatedCriterion.rows[0];

    // تسجيل العملية
    const statusText = is_active ? 'تفعيل' : 'إلغاء تفعيل';
    await logAuditTrail(req, 'UPDATE', 'evaluation_criteria', id, oldCriterion, newCriterion, `${statusText} معيار التقييم: ${newCriterion.name_ar}`);

    res.json({
      success: true,
      message: `تم ${statusText} معيار التقييم بنجاح`,
      data: {
        criterion: newCriterion
      }
    });

  } catch (error) {
    console.error('❌ خطأ في تغيير حالة معيار التقييم:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في تغيير حالة معيار التقييم',
      code: 'UPDATE_CRITERION_STATUS_ERROR'
    });
  }
});

/**
 * حذف معيار تقييم (أدمن فقط) - خطير!
 * DELETE /api/criteria/:id
 */
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { force = false } = req.query;

    // التحقق من وجود المعيار
    const existingCriterionResult = await query('SELECT * FROM evaluation_criteria WHERE id = $1', [id]);
    if (existingCriterionResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'معيار التقييم غير موجود',
        code: 'CRITERION_NOT_FOUND'
      });
    }

    const criterion = existingCriterionResult.rows[0];

    // فحص إذا كان المعيار مستخدم في تقييمات
    const usageResult = await query(
      'SELECT COUNT(*) as usage_count FROM evaluation_details WHERE criteria_id = $1',
      [id]
    );

    const usageCount = parseInt(usageResult.rows[0].usage_count);

    if (usageCount > 0 && !force) {
      return res.status(409).json({
        success: false,
        message: `لا يمكن حذف معيار التقييم لأنه مستخدم في ${usageCount} تقييم. استخدم ?force=true للحذف الإجباري`,
        code: 'CRITERION_IN_USE',
        usage_count: usageCount
      });
    }

    // حذف المعيار والبيانات المرتبطة به
    await transaction(async (client) => {
      // حذف تفاصيل التقييمات المرتبطة
      if (usageCount > 0) {
        await client.query('DELETE FROM evaluation_details WHERE criteria_id = $1', [id]);
      }
      
      // حذف المعيار
      await client.query('DELETE FROM evaluation_criteria WHERE id = $1', [id]);
    });

    // تسجيل العملية
    await logAuditTrail(req, 'DELETE', 'evaluation_criteria', id, criterion, null, `حذف معيار التقييم: ${criterion.name_ar}`);

    res.json({
      success: true,
      message: 'تم حذف معيار التقييم بنجاح',
      data: {
        deleted_criterion: {
          id: criterion.id,
          name_ar: criterion.name_ar
        },
        deleted_evaluations: usageCount
      }
    });

  } catch (error) {
    console.error('❌ خطأ في حذف معيار التقييم:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في حذف معيار التقييم',
      code: 'DELETE_CRITERION_ERROR'
    });
  }
});

/**
 * تكرار معيار تقييم (أدمن فقط)
 * POST /api/criteria/:id/duplicate
 */
router.post('/:id/duplicate', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { new_name_ar } = req.body;

    if (!new_name_ar) {
      return res.status(400).json({
        success: false,
        message: 'الاسم الجديد للمعيار مطلوب',
        code: 'NEW_NAME_REQUIRED'
      });
    }

    // التحقق من وجود المعيار الأصلي
    const originalCriterionResult = await query('SELECT * FROM evaluation_criteria WHERE id = $1', [id]);
    if (originalCriterionResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'معيار التقييم الأصلي غير موجود',
        code: 'CRITERION_NOT_FOUND'
      });
    }

    const originalCriterion = originalCriterionResult.rows[0];

    // التحقق من عدم تكرار الاسم الجديد
    const existingNameResult = await query('SELECT id FROM evaluation_criteria WHERE name_ar = $1', [new_name_ar]);
    if (existingNameResult.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'معيار التقييم بهذا الاسم موجود بالفعل',
        code: 'CRITERION_EXISTS'
      });
    }

    // إنشاء نسخة من المعيار
    const duplicatedCriterionQuery = `
      INSERT INTO evaluation_criteria (
        name_ar, name_en, description, category, weight, max_score, 
        data_type, choices, is_required, show_in_report, applies_to_role, sort_order, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false)
      RETURNING *
    `;

    const duplicatedCriterion = await query(duplicatedCriterionQuery, [
      new_name_ar,
      originalCriterion.name_en ? `${originalCriterion.name_en} (Copy)` : null,
      originalCriterion.description,
      originalCriterion.category,
      originalCriterion.weight,
      originalCriterion.max_score,
      originalCriterion.data_type,
      originalCriterion.choices,
      originalCriterion.is_required,
      originalCriterion.show_in_report,
      originalCriterion.applies_to_role,
      originalCriterion.sort_order + 1
    ]);

    const newCriterion = duplicatedCriterion.rows[0];

    // تسجيل العملية
    await logAuditTrail(req, 'CREATE', 'evaluation_criteria', newCriterion.id, null, newCriterion, `تكرار معيار التقييم من: ${originalCriterion.name_ar}`);

    res.status(201).json({
      success: true,
      message: 'تم تكرار معيار التقييم بنجاح',
      data: {
        original_criterion: {
          id: originalCriterion.id,
          name_ar: originalCriterion.name_ar
        },
        duplicated_criterion: newCriterion
      }
    });

  } catch (error) {
    console.error('❌ خطأ في تكرار معيار التقييم:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في تكرار معيار التقييم',
      code: 'DUPLICATE_CRITERION_ERROR'
    });
  }
});

/**
 * إعادة ترتيب معايير التقييم (أدمن فقط)
 * PUT /api/criteria/reorder
 */
router.put('/reorder', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { criteria_order } = req.body;

    if (!Array.isArray(criteria_order) || criteria_order.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'ترتيب المعايير يجب أن يكون مصفوفة غير فارغة',
        code: 'INVALID_ORDER_DATA'
      });
    }

    // تحديث ترتيب المعايير في معاملة واحدة
    await transaction(async (client) => {
      for (let i = 0; i < criteria_order.length; i++) {
        const { id, sort_order } = criteria_order[i];
        
        if (!id || typeof sort_order !== 'number') {
          throw new Error('بيانات الترتيب غير صالحة');
        }

        await client.query(
          'UPDATE evaluation_criteria SET sort_order = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [sort_order, id]
        );
      }
    });

    // تسجيل العملية
    await logAuditTrail(req, 'UPDATE', 'evaluation_criteria', 'multiple', null, { criteria_order }, 'إعادة ترتيب معايير التقييم');

    res.json({
      success: true,
      message: 'تم إعادة ترتيب معايير التقييم بنجاح',
      data: {
        updated_count: criteria_order.length
      }
    });

  } catch (error) {
    console.error('❌ خطأ في إعادة ترتيب معايير التقييم:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في إعادة ترتيب معايير التقييم',
      code: 'REORDER_CRITERIA_ERROR'
    });
  }
});

module.exports = router;