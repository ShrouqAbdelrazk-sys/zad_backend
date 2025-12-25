/**
 * مسارات إدارة التقييمات الشهرية
 * Monthly Evaluations Management Routes
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../config/database');
const { authenticateToken, requireAdmin, requireEvaluator, logAuditTrail } = require('../middleware/auth');

const router = express.Router();

/**
 * جلب جميع التقييمات مع فلترة
 * GET /api/evaluations
 */
router.get('/', authenticateToken, requireEvaluator, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 10, 
      volunteer_id,
      evaluator_id,
      year,
      month,
      status,
      min_percentage,
      max_percentage
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    // بناء شروط البحث
    let whereClause = 'WHERE 1=1';
    const queryParams = [];
    let paramIndex = 1;

    if (volunteer_id) {
      whereClause += ` AND e.volunteer_id = $${paramIndex}`;
      queryParams.push(volunteer_id);
      paramIndex++;
    }

    if (evaluator_id) {
      whereClause += ` AND e.evaluator_id = $${paramIndex}`;
      queryParams.push(evaluator_id);
      paramIndex++;
    }

    if (year) {
      whereClause += ` AND e.evaluation_year = $${paramIndex}`;
      queryParams.push(parseInt(year));
      paramIndex++;
    }

    if (month) {
      whereClause += ` AND e.evaluation_month = $${paramIndex}`;
      queryParams.push(parseInt(month));
      paramIndex++;
    }

    if (status) {
      whereClause += ` AND e.status = $${paramIndex}`;
      queryParams.push(status);
      paramIndex++;
    }

    if (min_percentage) {
      whereClause += ` AND e.percentage >= $${paramIndex}`;
      queryParams.push(parseFloat(min_percentage));
      paramIndex++;
    }

    if (max_percentage) {
      whereClause += ` AND e.percentage <= $${paramIndex}`;
      queryParams.push(parseFloat(max_percentage));
      paramIndex++;
    }

    // إحصاء إجمالي
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM evaluations e
      ${whereClause}
    `;
    const countResult = await query(countQuery, queryParams);
    const total = parseInt(countResult.rows[0].total);

    // جلب التقييمات
    queryParams.push(parseInt(limit), offset);
    const evaluationsQuery = `
      SELECT 
        e.*,
        v.full_name as volunteer_name,
        v.role_type as volunteer_role,
        u.full_name as evaluator_name,
        CASE 
          WHEN e.percentage >= 90 THEN 'ممتاز'
          WHEN e.percentage >= 80 THEN 'جيد جداً'
          WHEN e.percentage >= 70 THEN 'جيد'
          WHEN e.percentage >= 60 THEN 'مقبول'
          ELSE 'يحتاج تحسين'
        END as performance_grade
      FROM evaluations e
      INNER JOIN volunteers v ON e.volunteer_id = v.id
      INNER JOIN users u ON e.evaluator_id = u.id
      ${whereClause}
      ORDER BY e.evaluation_year DESC, e.evaluation_month DESC, e.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const evaluationsResult = await query(evaluationsQuery, queryParams);

    res.json({
      success: true,
      data: {
        evaluations: evaluationsResult.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });

  } catch (error) {
    console.error('❌ خطأ في جلب التقييمات:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في جلب التقييمات',
      code: 'GET_EVALUATIONS_ERROR'
    });
  }
});

/**
 * جلب تقييم محدد مع التفاصيل
 * GET /api/evaluations/:id
 */
router.get('/:id', authenticateToken, requireEvaluator, async (req, res) => {
  try {
    const { id } = req.params;

    // جلب التقييم الأساسي
    const evaluationQuery = `
      SELECT 
        e.*,
        v.full_name as volunteer_name,
        v.role_type as volunteer_role,
        v.phone as volunteer_phone,
        u.full_name as evaluator_name
      FROM evaluations e
      INNER JOIN volunteers v ON e.volunteer_id = v.id
      INNER JOIN users u ON e.evaluator_id = u.id
      WHERE e.id = $1
    `;

    const evaluationResult = await query(evaluationQuery, [id]);

    if (evaluationResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'التقييم غير موجود',
        code: 'EVALUATION_NOT_FOUND'
      });
    }

    const evaluation = evaluationResult.rows[0];

    // جلب تفاصيل التقييم
    const detailsQuery = `
      SELECT 
        ed.*,
        ec.name_ar as criteria_name,
        ec.name_en as criteria_name_en,
        ec.category,
        ec.max_score,
        ec.data_type,
        ec.applies_to_role
      FROM evaluation_details ed
      INNER JOIN evaluation_criteria ec ON ed.criteria_id = ec.id
      WHERE ed.evaluation_id = $1
      ORDER BY ec.category, ec.sort_order, ec.name_ar
    `;

    const detailsResult = await query(detailsQuery, [id]);

    // تجميع التفاصيل حسب الفئة
    const groupedDetails = detailsResult.rows.reduce((acc, detail) => {
      if (!acc[detail.category]) {
        acc[detail.category] = [];
      }
      acc[detail.category].push(detail);
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        evaluation: evaluation,
        details: detailsResult.rows,
        grouped_details: groupedDetails,
        categories: {
          basic: 'المعايير الأساسية',
          responsibility: 'معايير المسؤولية',
          bonus: 'معايير البونص'
        }
      }
    });

  } catch (error) {
    console.error('❌ خطأ في جلب التقييم:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في جلب التقييم',
      code: 'GET_EVALUATION_ERROR'
    });
  }
});

/**
 * إنشاء تقييم شهري جديد
 * POST /api/evaluations
 */
router.post('/', [
  authenticateToken,
  requireEvaluator,
  body('volunteer_id').isUUID().withMessage('معرف المتطوع غير صالح'),
  body('evaluation_month').isInt({ min: 1, max: 12 }).withMessage('الشهر يجب أن يكون بين 1 و 12'),
  body('evaluation_year').isInt({ min: 2020, max: 2030 }).withMessage('السنة غير صالحة'),
  body('criteria_scores').isArray().withMessage('نتائج المعايير يجب أن تكون مصفوفة'),
  body('human_note').optional().isLength({ max: 2000 }).withMessage('الملاحظة الإنسانية طويلة جداً')
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
      evaluation_month,
      evaluation_year,
      criteria_scores,
      human_note,
      praise_note,
      improvement_suggestions,
      is_frozen = false,
      freeze_reason,
      freeze_start_date,
      freeze_end_date
    } = req.body;

    // التحقق من وجود المتطوع
    const volunteerResult = await query(
      'SELECT * FROM volunteers WHERE id = $1 AND is_active = true',
      [volunteer_id]
    );

    if (volunteerResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'المتطوع غير موجود أو غير نشط',
        code: 'VOLUNTEER_NOT_FOUND'
      });
    }

    const volunteer = volunteerResult.rows[0];

    // التحقق من عدم وجود تقييم مكرر
    const existingEvaluationResult = await query(
      'SELECT id FROM evaluations WHERE volunteer_id = $1 AND evaluation_month = $2 AND evaluation_year = $3',
      [volunteer_id, evaluation_month, evaluation_year]
    );

    if (existingEvaluationResult.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'يوجد تقييم بالفعل لهذا المتطوع في هذا الشهر',
        code: 'EVALUATION_EXISTS'
      });
    }

    // في حالة الفريز، التحقق من صحة البيانات
    if (is_frozen) {
      if (!freeze_reason || !freeze_start_date || !freeze_end_date) {
        return res.status(400).json({
          success: false,
          message: 'بيانات الفريز غير مكتملة',
          code: 'INCOMPLETE_FREEZE_DATA'
        });
      }

      // التحقق من الحد الأقصى للفريز السنوي
      const freezeCountResult = await query(
        'SELECT COUNT(*) as count FROM freeze_records WHERE volunteer_id = $1 AND freeze_year = $2 AND is_active = true',
        [volunteer_id, evaluation_year]
      );

      if (parseInt(freezeCountResult.rows[0].count) >= 2) {
        return res.status(409).json({
          success: false,
          message: 'تم تجاوز الحد الأقصى للفريز السنوي (2 مرات)',
          code: 'FREEZE_LIMIT_EXCEEDED'
        });
      }
    }

    // إنشاء التقييم في معاملة واحدة
    const result = await transaction(async (client) => {
      // إنشاء التقييم الأساسي
      const evaluationQuery = `
        INSERT INTO evaluations (
          volunteer_id, evaluator_id, evaluation_month, evaluation_year,
          is_frozen, freeze_reason, freeze_start_date, freeze_end_date,
          human_note, praise_note, improvement_suggestions, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'draft')
        RETURNING *
      `;

      const evaluationResult = await client.query(evaluationQuery, [
        volunteer_id,
        req.user.id,
        evaluation_month,
        evaluation_year,
        is_frozen,
        freeze_reason || null,
        freeze_start_date || null,
        freeze_end_date || null,
        human_note || null,
        praise_note || null,
        improvement_suggestions || null
      ]);

      const evaluation = evaluationResult.rows[0];

      // جلب معايير التقييم المناسبة للمتطوع
      const criteriaQuery = `
        SELECT * FROM evaluation_criteria 
        WHERE is_active = true 
        AND (applies_to_role = $1 OR applies_to_role = 'all')
        ORDER BY category, sort_order
      `;

      const criteriaResult = await client.query(criteriaQuery, [volunteer.role_type]);
      const availableCriteria = criteriaResult.rows;

      // حساب النتائج بشكل صحيح
      let totalScore = 0;
      let maxPossibleScore = 0;

      // إدراج تفاصيل التقييم
      for (const criteriaScore of criteria_scores) {
        const { criteria_id, score_value, text_value, choice_value, boolean_value, notes } = criteriaScore;

        // العثور على المعيار
        const criterion = availableCriteria.find(c => c.id === criteria_id);
        if (!criterion) {
          console.warn(`معيار غير موجود: ${criteria_id}`);
          continue;
        }

        // تحديد القيمة حسب نوع البيانات
        let finalScore = 0;
        if (criterion.data_type === 'numeric' && score_value !== undefined && score_value !== null) {
          finalScore = Math.max(0, Math.min(parseFloat(score_value) || 0, criterion.max_score));
        } else if (criterion.data_type === 'boolean') {
          finalScore = boolean_value === true ? criterion.max_score : 0;
        } else if (criterion.data_type === 'choice' && choice_value) {
          // معالجة الخيارات - يمكن تخصيصها حسب الحاجة
          const choices = criterion.choices || {};
          finalScore = choices[choice_value] || criterion.max_score * 0.8; // قيمة افتراضية
        }

        // إدراج تفاصيل التقييم
        await client.query(
          `INSERT INTO evaluation_details (evaluation_id, criteria_id, score_value, text_value, choice_value, boolean_value, notes, weight_used)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [evaluation.id, criteria_id, finalScore || null, text_value || null, choice_value || null, boolean_value || null, notes || null, criterion.weight]
        );

        // حساب النتيجة الإجمالية مع الوزن
        const weightedScore = finalScore * parseFloat(criterion.weight || 1);
        const maxWeightedScore = parseFloat(criterion.max_score || 10) * parseFloat(criterion.weight || 1);
        
        totalScore += weightedScore;
        maxPossibleScore += maxWeightedScore;
        
        console.log(`معيار: ${criterion.name_ar}, النتيجة: ${finalScore}, الوزن: ${criterion.weight}, النتيجة الموزونة: ${weightedScore}`);
      }

      // تحديث النتيجة الإجمالية والنسبة المئوية
      const percentage = maxPossibleScore > 0 ? Math.round((totalScore / maxPossibleScore) * 100 * 100) / 100 : 0;
      await client.query(
        'UPDATE evaluations SET total_score = $1, max_possible_score = $2, percentage = $3 WHERE id = $4',
        [totalScore, maxPossibleScore, percentage, evaluation.id]
      );

      evaluation.percentage = percentage;

      // إضافة سجل فريز إذا لزم الأمر
      if (is_frozen) {
        await client.query(
          `INSERT INTO freeze_records (volunteer_id, freeze_year, start_date, end_date, reason, evaluation_month, evaluation_year, approved_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [volunteer_id, evaluation_year, freeze_start_date, freeze_end_date, freeze_reason, evaluation_month, evaluation_year, req.user.id]
        );
      }

      return { ...evaluation, total_score: totalScore, max_possible_score: maxPossibleScore };
    });

    // تسجيل العملية
    await logAuditTrail(req, 'CREATE', 'evaluations', result.id, null, result, `إنشاء تقييم شهري جديد للمتطوع: ${volunteer.full_name}`);

    res.status(201).json({
      success: true,
      message: 'تم إنشاء التقييم بنجاح',
      data: {
        evaluation: result
      }
    });

  } catch (error) {
    console.error('❌ خطأ في إنشاء التقييم:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في إنشاء التقييم',
      code: 'CREATE_EVALUATION_ERROR'
    });
  }
});

/**
 * تحديث تقييم موجود
 * PUT /api/evaluations/:id
 */
router.put('/:id', [
  authenticateToken,
  requireEvaluator,
  body('criteria_scores').optional().isArray().withMessage('نتائج المعايير يجب أن تكون مصفوفة'),
  body('human_note').optional().isLength({ max: 2000 }).withMessage('الملاحظة الإنسانية طويلة جداً')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'بيانات غير صحيحة',
        errors: errors.array()
      });
    }

    const { id } = req.params;
    const {
      criteria_scores,
      human_note,
      praise_note,
      improvement_suggestions,
      is_frozen,
      freeze_reason,
      freeze_start_date,
      freeze_end_date
    } = req.body;

    // التحقق من وجود التقييم
    const existingEvaluationResult = await query('SELECT * FROM evaluations WHERE id = $1', [id]);
    if (existingEvaluationResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'التقييم غير موجود',
        code: 'EVALUATION_NOT_FOUND'
      });
    }

    const oldEvaluation = existingEvaluationResult.rows[0];

    // التحقق من الصلاحيات (المقيم يمكنه تعديل تقييماته فقط، الأدمن يعدل أي تقييم)
    if (req.user.role !== 'admin' && oldEvaluation.evaluator_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'غير مصرح لك بتعديل هذا التقييم',
        code: 'UNAUTHORIZED_EDIT'
      });
    }

    // التحقق من حالة التقييم
    if (oldEvaluation.status === 'approved' && req.user.role !== 'admin') {
      return res.status(409).json({
        success: false,
        message: 'لا يمكن تعديل التقييم بعد اعتماده',
        code: 'EVALUATION_APPROVED'
      });
    }

    // تحديث التقييم في معاملة واحدة
    const updatedEvaluation = await transaction(async (client) => {
      // تحديث البيانات الأساسية
      const updates = [];
      const values = [];
      let paramIndex = 1;

      if (human_note !== undefined) {
        updates.push(`human_note = $${paramIndex}`);
        values.push(human_note);
        paramIndex++;
      }

      if (praise_note !== undefined) {
        updates.push(`praise_note = $${paramIndex}`);
        values.push(praise_note);
        paramIndex++;
      }

      if (improvement_suggestions !== undefined) {
        updates.push(`improvement_suggestions = $${paramIndex}`);
        values.push(improvement_suggestions);
        paramIndex++;
      }

      if (is_frozen !== undefined) {
        updates.push(`is_frozen = $${paramIndex}`);
        values.push(is_frozen);
        paramIndex++;
      }

      if (freeze_reason !== undefined) {
        updates.push(`freeze_reason = $${paramIndex}`);
        values.push(freeze_reason);
        paramIndex++;
      }

      if (freeze_start_date !== undefined) {
        updates.push(`freeze_start_date = $${paramIndex}`);
        values.push(freeze_start_date);
        paramIndex++;
      }

      if (freeze_end_date !== undefined) {
        updates.push(`freeze_end_date = $${paramIndex}`);
        values.push(freeze_end_date);
        paramIndex++;
      }

      if (updates.length > 0) {
        updates.push('updated_at = CURRENT_TIMESTAMP');
        values.push(id);

        const updateQuery = `UPDATE evaluations SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
        const result = await client.query(updateQuery, values);
        
        if (result.rows.length === 0) {
          throw new Error('فشل في تحديث التقييم');
        }
      }

      // تحديث تفاصيل التقييم إذا تم توفيرها
      if (criteria_scores && criteria_scores.length > 0) {
        // حذف التفاصيل الحالية
        await client.query('DELETE FROM evaluation_details WHERE evaluation_id = $1', [id]);

        // جلب المتطوع لمعرفة دوره
        const volunteerResult = await client.query('SELECT role_type FROM volunteers WHERE id = $1', [oldEvaluation.volunteer_id]);
        const volunteerRole = volunteerResult.rows[0].role_type;

        // جلب معايير التقييم المناسبة
        const criteriaResult = await client.query(
          `SELECT * FROM evaluation_criteria 
           WHERE is_active = true AND (applies_to_role = $1 OR applies_to_role = 'all')
           ORDER BY category, sort_order`,
          [volunteerRole]
        );

        const availableCriteria = criteriaResult.rows;
        let totalScore = 0;
        let maxPossibleScore = 0;

        // إعادة إدراج التفاصيل الجديدة
        for (const criteriaScore of criteria_scores) {
          const { criteria_id, score_value, text_value, choice_value, boolean_value, notes } = criteriaScore;

          const criterion = availableCriteria.find(c => c.id === criteria_id);
          if (!criterion) {
            console.warn(`معيار غير موجود: ${criteria_id}`);
            continue;
          }

          let finalScore = 0;
          if (criterion.data_type === 'numeric' && score_value !== undefined && score_value !== null) {
            finalScore = Math.max(0, Math.min(parseFloat(score_value) || 0, criterion.max_score));
          } else if (criterion.data_type === 'boolean') {
            finalScore = boolean_value === true ? criterion.max_score : 0;
          } else if (criterion.data_type === 'choice' && choice_value) {
            const choices = criterion.choices || {};
            finalScore = choices[choice_value] || criterion.max_score * 0.8;
          }

          await client.query(
            `INSERT INTO evaluation_details (evaluation_id, criteria_id, score_value, text_value, choice_value, boolean_value, notes, weight_used)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [id, criteria_id, finalScore || null, text_value || null, choice_value || null, boolean_value || null, notes || null, criterion.weight]
          );

          const weightedScore = finalScore * parseFloat(criterion.weight || 1);
          const maxWeightedScore = parseFloat(criterion.max_score || 10) * parseFloat(criterion.weight || 1);
          
          totalScore += weightedScore;
          maxPossibleScore += maxWeightedScore;
        }

        // تحديث النتيجة الإجمالية والنسبة المئوية
        const percentage = maxPossibleScore > 0 ? Math.round((totalScore / maxPossibleScore) * 100 * 100) / 100 : 0;
        await client.query(
          'UPDATE evaluations SET total_score = $1, max_possible_score = $2, percentage = $3 WHERE id = $4',
          [totalScore, maxPossibleScore, percentage, id]
        );
      }

      // جلب التقييم المحدث
      const finalResult = await client.query('SELECT * FROM evaluations WHERE id = $1', [id]);
      return finalResult.rows[0];
    });

    // تسجيل العملية
    await logAuditTrail(req, 'UPDATE', 'evaluations', id, oldEvaluation, updatedEvaluation, `تحديث التقييم الشهري`);

    res.json({
      success: true,
      message: 'تم تحديث التقييم بنجاح',
      data: {
        evaluation: updatedEvaluation
      }
    });

  } catch (error) {
    console.error('❌ خطأ في تحديث التقييم:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في تحديث التقييم',
      code: 'UPDATE_EVALUATION_ERROR'
    });
  }
});

/**
 * اعتماد تقييم
 * PATCH /api/evaluations/:id/approve
 */
router.patch('/:id/approve', authenticateToken, requireEvaluator, async (req, res) => {
  try {
    const { id } = req.params;

    // التحقق من وجود التقييم
    const evaluationResult = await query('SELECT * FROM evaluations WHERE id = $1', [id]);
    if (evaluationResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'التقييم غير موجود',
        code: 'EVALUATION_NOT_FOUND'
      });
    }

    const evaluation = evaluationResult.rows[0];

    // التحقق من الصلاحيات
    if (req.user.role !== 'admin' && evaluation.evaluator_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'غير مصرح لك باعتماد هذا التقييم',
        code: 'UNAUTHORIZED_APPROVAL'
      });
    }

    if (evaluation.status === 'approved') {
      return res.status(409).json({
        success: false,
        message: 'التقييم معتمد بالفعل',
        code: 'ALREADY_APPROVED'
      });
    }

    // اعتماد التقييم
    const updatedEvaluation = await query(
      'UPDATE evaluations SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      ['approved', id]
    );

    // تسجيل العملية
    await logAuditTrail(req, 'UPDATE', 'evaluations', id, evaluation, updatedEvaluation.rows[0], 'اعتماد التقييم الشهري');

    res.json({
      success: true,
      message: 'تم اعتماد التقييم بنجاح',
      data: {
        evaluation: updatedEvaluation.rows[0]
      }
    });

  } catch (error) {
    console.error('❌ خطأ في اعتماد التقييم:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في اعتماد التقييم',
      code: 'APPROVE_EVALUATION_ERROR'
    });
  }
});

/**
 * حذف تقييم (أدمن فقط)
 * DELETE /api/evaluations/:id
 */
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // التحقق من وجود التقييم
    const evaluationResult = await query('SELECT * FROM evaluations WHERE id = $1', [id]);
    if (evaluationResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'التقييم غير موجود',
        code: 'EVALUATION_NOT_FOUND'
      });
    }

    const evaluation = evaluationResult.rows[0];

    // حذف التقييم وتفاصيله
    await transaction(async (client) => {
      await client.query('DELETE FROM evaluation_details WHERE evaluation_id = $1', [id]);
      await client.query('DELETE FROM evaluations WHERE id = $1', [id]);
    });

    // تسجيل العملية
    await logAuditTrail(req, 'DELETE', 'evaluations', id, evaluation, null, 'حذف التقييم الشهري');

    res.json({
      success: true,
      message: 'تم حذف التقييم بنجاح',
      data: {
        deleted_evaluation: {
          id: evaluation.id,
          evaluation_month: evaluation.evaluation_month,
          evaluation_year: evaluation.evaluation_year
        }
      }
    });

  } catch (error) {
    console.error('❌ خطأ في حذف التقييم:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في حذف التقييم',
      code: 'DELETE_EVALUATION_ERROR'
    });
  }
});

/**
 * إحصائيات التقييمات
 * GET /api/evaluations/statistics/overview
 */
router.get('/statistics/overview', authenticateToken, requireEvaluator, async (req, res) => {
  try {
    const { year = new Date().getFullYear() } = req.query;

    // إحصائيات عامة للسنة
    const generalStatsQuery = `
      SELECT 
        COUNT(*) as total_evaluations,
        COUNT(*) FILTER (WHERE status = 'approved') as approved_evaluations,
        COUNT(*) FILTER (WHERE status = 'draft') as draft_evaluations,
        COUNT(*) FILTER (WHERE is_frozen = true) as frozen_evaluations,
        ROUND(AVG(percentage), 2) as avg_percentage,
        COUNT(*) FILTER (WHERE percentage >= 90) as excellent_count,
        COUNT(*) FILTER (WHERE percentage >= 80 AND percentage < 90) as very_good_count,
        COUNT(*) FILTER (WHERE percentage >= 70 AND percentage < 80) as good_count,
        COUNT(*) FILTER (WHERE percentage >= 60 AND percentage < 70) as acceptable_count,
        COUNT(*) FILTER (WHERE percentage < 60) as needs_improvement_count
      FROM evaluations
      WHERE evaluation_year = $1
    `;

    const generalStats = await query(generalStatsQuery, [year]);

    // إحصائيات شهرية
    const monthlyStatsQuery = `
      SELECT 
        evaluation_month,
        COUNT(*) as evaluations_count,
        ROUND(AVG(percentage), 2) as avg_percentage,
        COUNT(*) FILTER (WHERE status = 'approved') as approved_count
      FROM evaluations
      WHERE evaluation_year = $1
      GROUP BY evaluation_month
      ORDER BY evaluation_month
    `;

    const monthlyStats = await query(monthlyStatsQuery, [year]);

    // أفضل المتطوعين
    const topPerformersQuery = `
      SELECT 
        v.full_name,
        ROUND(AVG(e.percentage), 2) as avg_percentage,
        COUNT(e.id) as evaluations_count
      FROM evaluations e
      INNER JOIN volunteers v ON e.volunteer_id = v.id
      WHERE e.evaluation_year = $1 AND e.status = 'approved'
      GROUP BY v.id, v.full_name
      HAVING COUNT(e.id) >= 3
      ORDER BY AVG(e.percentage) DESC
      LIMIT 10
    `;

    const topPerformers = await query(topPerformersQuery, [year]);

    res.json({
      success: true,
      data: {
        year: parseInt(year),
        general_stats: generalStats.rows[0],
        monthly_stats: monthlyStats.rows,
        top_performers: topPerformers.rows,
        generated_at: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ خطأ في جلب إحصائيات التقييمات:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في جلب الإحصائيات',
      code: 'GET_EVALUATION_STATISTICS_ERROR'
    });
  }
});

module.exports = router;