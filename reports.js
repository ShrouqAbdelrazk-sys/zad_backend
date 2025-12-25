/**
 * مسارات التقارير والتحليل
 * Reports and Analytics Routes
 */

const express = require('express');
const { query } = require('../config/database');
const { authenticateToken, requireEvaluator, logAuditTrail } = require('../middleware/auth');

const router = express.Router();

/**
 * تقرير شامل لمتطوع محدد
 * GET /api/reports/volunteer/:id
 */
router.get('/volunteer/:id', authenticateToken, requireEvaluator, async (req, res) => {
  try {
    const { id } = req.params;
    const { year, months } = req.query;

    // التحقق من وجود المتطوع
    const volunteerResult = await query('SELECT * FROM volunteers WHERE id = $1', [id]);
    if (volunteerResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'المتطوع غير موجود',
        code: 'VOLUNTEER_NOT_FOUND'
      });
    }

    const volunteer = volunteerResult.rows[0];

    // بناء شروط البحث للتقييمات
    let evaluationsWhere = 'WHERE e.volunteer_id = $1';
    const queryParams = [id];
    let paramIndex = 2;

    if (year) {
      evaluationsWhere += ` AND e.evaluation_year = $${paramIndex}`;
      queryParams.push(parseInt(year));
      paramIndex++;
    }

    if (months) {
      const monthsArray = months.split(',').map(m => parseInt(m));
      evaluationsWhere += ` AND e.evaluation_month = ANY($${paramIndex})`;
      queryParams.push(monthsArray);
      paramIndex++;
    }

    // جلب التقييمات مع التفاصيل
    const evaluationsQuery = `
      SELECT 
        e.*,
        u.full_name as evaluator_name,
        CASE 
          WHEN e.percentage >= 90 THEN 'ممتاز'
          WHEN e.percentage >= 80 THEN 'جيد جداً'
          WHEN e.percentage >= 70 THEN 'جيد'
          WHEN e.percentage >= 60 THEN 'مقبول'
          ELSE 'يحتاج تحسين'
        END as grade
      FROM evaluations e
      LEFT JOIN users u ON e.evaluator_id = u.id
      ${evaluationsWhere}
      ORDER BY e.evaluation_year DESC, e.evaluation_month DESC
    `;

    const evaluationsResult = await query(evaluationsQuery, queryParams);
    const evaluations = evaluationsResult.rows;

    // حساب الإحصائيات
    const totalEvaluations = evaluations.length;
    const avgPerformance = evaluations.length > 0 
      ? (evaluations.reduce((sum, e) => sum + (e.percentage || 0), 0) / evaluations.length).toFixed(2)
      : 0;

    // تحليل الاتجاه
    let trend = 'مستقر';
    if (evaluations.length >= 2) {
      const recent = evaluations[0]?.percentage || 0;
      const previous = evaluations[1]?.percentage || 0;
      if (recent > previous + 5) trend = 'تحسن';
      else if (recent < previous - 5) trend = 'تراجع';
    }

    // جلب تفاصيل الأداء لآخر تقييم
    let detailedPerformance = null;
    if (evaluations.length > 0) {
      const latestEvaluationId = evaluations[0].id;
      
      const detailsQuery = `
        SELECT 
          ed.*,
          ec.name_ar as criteria_name,
          ec.category,
          ec.max_score,
          ec.weight,
          ROUND((ed.score_value / ec.max_score) * 100, 2) as percentage_for_criteria
        FROM evaluation_details ed
        INNER JOIN evaluation_criteria ec ON ed.criteria_id = ec.id
        WHERE ed.evaluation_id = $1
        ORDER BY ec.category, ec.sort_order
      `;

      const detailsResult = await query(detailsQuery, [latestEvaluationId]);
      
      // تجميع الأداء حسب الفئة
      detailedPerformance = detailsResult.rows.reduce((acc, detail) => {
        if (!acc[detail.category]) {
          acc[detail.category] = [];
        }
        acc[detail.category].push(detail);
        return acc;
      }, {});
    }

    // تحديد نقاط القوة والضعف
    const strengths = [];
    const weaknesses = [];
    
    if (detailedPerformance) {
      Object.values(detailedPerformance).flat().forEach(detail => {
        if (detail.percentage_for_criteria >= 80) {
          strengths.push({
            criteria: detail.criteria_name,
            score: detail.score_value,
            percentage: detail.percentage_for_criteria
          });
        } else if (detail.percentage_for_criteria < 60) {
          weaknesses.push({
            criteria: detail.criteria_name,
            score: detail.score_value,
            percentage: detail.percentage_for_criteria
          });
        }
      });
    }

    // جلب الملاحظات التراكمية
    const notesResult = await query(`
      SELECT * FROM cumulative_notes 
      WHERE volunteer_id = $1 
      ORDER BY created_at DESC 
      LIMIT 20
    `, [id]);

    // جلب التنبيهات النشطة
    const alertsResult = await query(`
      SELECT 
        ar.*,
        ec.name_ar as criteria_name
      FROM alert_records ar
      LEFT JOIN evaluation_criteria ec ON ar.criteria_id = ec.id
      WHERE ar.volunteer_id = $1 AND ar.is_resolved = false
      ORDER BY ar.severity DESC
    `, [id]);

    // اقتراحات التحسين
    const improvementSuggestions = [];
    
    weaknesses.forEach(weakness => {
      improvementSuggestions.push(`تطوير مهارات ${weakness.criteria} - النسبة الحالية ${weakness.percentage}%`);
    });

    if (evaluations.length >= 3) {
      const lastThreeAvg = evaluations.slice(0, 3).reduce((sum, e) => sum + (e.percentage || 0), 0) / 3;
      if (lastThreeAvg < 70) {
        improvementSuggestions.push('التركيز على تحسين الأداء العام خلال الشهور القادمة');
      }
    }

    // إنشاء فقرة المدح الإنسانية
    let praiseMessage = `الأخ/الأخت ${volunteer.full_name}، `;
    if (parseFloat(avgPerformance) >= 80) {
      praiseMessage += 'نشكركم على العطاء المتميز والالتزام الدائم في خدمة المجتمع. أداؤكم يستحق كل التقدير والثناء.';
    } else if (parseFloat(avgPerformance) >= 70) {
      praiseMessage += 'نقدر جهودكم المخلصة في العمل التطوعي. نشجعكم على الاستمرار والتطوير.';
    } else {
      praiseMessage += 'نثمن انضمامكم لفريق العمل التطوعي ونتطلع للمزيد من العطاء والتطوير معاً.';
    }

    const report = {
      volunteer: {
        id: volunteer.id,
        name: volunteer.full_name,
        role: volunteer.role_type,
        phone: volunteer.phone,
        join_date: volunteer.join_date
      },
      period: {
        year: year || 'جميع السنوات',
        months: months || 'جميع الشهور'
      },
      summary: {
        total_evaluations: totalEvaluations,
        average_performance: parseFloat(avgPerformance),
        trend: trend,
        current_status: volunteer.is_active ? 'نشط' : 'غير نشط'
      },
      performance_analysis: {
        strengths: strengths,
        weaknesses: weaknesses,
        detailed_by_category: detailedPerformance
      },
      evaluations_history: evaluations,
      cumulative_notes: notesResult.rows,
      active_alerts: alertsResult.rows,
      improvement_plan: {
        suggestions: improvementSuggestions,
        priority_areas: weaknesses.slice(0, 3).map(w => w.criteria)
      },
      human_feedback: {
        praise_message: praiseMessage,
        encouragement: 'نحن نؤمن بقدرتكم على التطوير والنمو، ونتطلع لرؤية المزيد من إنجازاتكم القادمة.'
      },
      generated_at: new Date().toISOString(),
      generated_by: req.user.fullName
    };

    res.json({
      success: true,
      data: report
    });

  } catch (error) {
    console.error('❌ خطأ في توليد تقرير المتطوع:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في توليد التقرير',
      code: 'GENERATE_VOLUNTEER_REPORT_ERROR'
    });
  }
});

/**
 * تقرير شامل للمؤسسة
 * GET /api/reports/organization
 */
router.get('/organization', authenticateToken, requireEvaluator, async (req, res) => {
  try {
    const { year = new Date().getFullYear(), month } = req.query;

    // إحصائيات عامة
    const overallStatsQuery = `
      SELECT 
        COUNT(*) FILTER (WHERE is_active = true) as active_volunteers,
        COUNT(*) FILTER (WHERE is_active = false) as inactive_volunteers,
        COUNT(*) FILTER (WHERE role_type = 'ميداني') as field_volunteers,
        COUNT(*) FILTER (WHERE role_type = 'إداري') as admin_volunteers,
        COUNT(*) FILTER (WHERE role_type = 'مسئول ملف') as file_manager_volunteers,
        COUNT(*) as total_volunteers
      FROM volunteers
    `;

    const overallStats = await query(overallStatsQuery);

    // إحصائيات التقييمات
    let evaluationWhere = 'WHERE evaluation_year = $1';
    const evaluationParams = [parseInt(year)];
    let paramIndex = 2;

    if (month) {
      evaluationWhere += ` AND evaluation_month = $${paramIndex}`;
      evaluationParams.push(parseInt(month));
      paramIndex++;
    }

    const evaluationStatsQuery = `
      SELECT 
        COUNT(*) as total_evaluations,
        COUNT(*) FILTER (WHERE status = 'approved') as approved_evaluations,
        COUNT(*) FILTER (WHERE is_frozen = true) as frozen_evaluations,
        ROUND(AVG(percentage), 2) as avg_performance,
        COUNT(*) FILTER (WHERE percentage >= 90) as excellent_performers,
        COUNT(*) FILTER (WHERE percentage >= 80 AND percentage < 90) as very_good_performers,
        COUNT(*) FILTER (WHERE percentage >= 70 AND percentage < 80) as good_performers,
        COUNT(*) FILTER (WHERE percentage >= 60 AND percentage < 70) as acceptable_performers,
        COUNT(*) FILTER (WHERE percentage < 60) as needs_improvement_performers
      FROM evaluations
      ${evaluationWhere}
    `;

    const evaluationStats = await query(evaluationStatsQuery, evaluationParams);

    // أفضل المتطوعين
    const topPerformersQuery = `
      SELECT 
        v.full_name,
        v.role_type,
        ROUND(AVG(e.percentage), 2) as avg_performance,
        COUNT(e.id) as evaluations_count
      FROM volunteers v
      INNER JOIN evaluations e ON v.id = e.volunteer_id
      ${evaluationWhere.replace('WHERE', 'WHERE e.')}
      AND e.status = 'approved'
      GROUP BY v.id, v.full_name, v.role_type
      HAVING COUNT(e.id) >= 1
      ORDER BY AVG(e.percentage) DESC
      LIMIT 10
    `;

    const topPerformers = await query(topPerformersQuery, evaluationParams);

    // المتطوعين الذين يحتاجون متابعة
    const needsAttentionQuery = `
      SELECT 
        v.full_name,
        v.role_type,
        ROUND(AVG(e.percentage), 2) as avg_performance,
        COUNT(e.id) as evaluations_count
      FROM volunteers v
      INNER JOIN evaluations e ON v.id = e.volunteer_id
      ${evaluationWhere.replace('WHERE', 'WHERE e.')}
      AND e.status = 'approved'
      GROUP BY v.id, v.full_name, v.role_type
      HAVING AVG(e.percentage) < 60
      ORDER BY AVG(e.percentage) ASC
      LIMIT 10
    `;

    const needsAttention = await query(needsAttentionQuery, evaluationParams);

    // إحصائيات الفريز
    const freezeStatsQuery = `
      SELECT 
        COUNT(*) as total_freezes,
        COUNT(DISTINCT volunteer_id) as volunteers_with_freezes,
        ROUND(AVG(end_date - start_date), 2) as avg_freeze_duration,
        COUNT(*) FILTER (WHERE CURRENT_DATE BETWEEN start_date AND end_date) as currently_frozen
      FROM freeze_records
      WHERE freeze_year = $1 AND is_active = true
    `;

    const freezeStats = await query(freezeStatsQuery, [parseInt(year)]);

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

    // أداء المعايير
    const criteriaPerformanceQuery = `
      SELECT 
        ec.name_ar as criteria_name,
        ec.category,
        ROUND(AVG(ed.score_value), 2) as avg_score,
        ec.max_score,
        ROUND((AVG(ed.score_value) / ec.max_score) * 100, 2) as avg_percentage,
        COUNT(ed.id) as usage_count
      FROM evaluation_criteria ec
      INNER JOIN evaluation_details ed ON ec.id = ed.criteria_id
      INNER JOIN evaluations e ON ed.evaluation_id = e.id
      ${evaluationWhere.replace('WHERE', 'WHERE e.')}
      AND e.status = 'approved'
      GROUP BY ec.id, ec.name_ar, ec.category, ec.max_score
      ORDER BY ec.category, avg_percentage DESC
    `;

    const criteriaPerformance = await query(criteriaPerformanceQuery, evaluationParams);

    const report = {
      period: {
        year: parseInt(year),
        month: month ? parseInt(month) : null,
        report_type: month ? 'شهري' : 'سنوي'
      },
      organization_overview: overallStats.rows[0],
      evaluation_summary: evaluationStats.rows[0],
      performance_distribution: {
        excellent: evaluationStats.rows[0]?.excellent_performers || 0,
        very_good: evaluationStats.rows[0]?.very_good_performers || 0,
        good: evaluationStats.rows[0]?.good_performers || 0,
        acceptable: evaluationStats.rows[0]?.acceptable_performers || 0,
        needs_improvement: evaluationStats.rows[0]?.needs_improvement_performers || 0
      },
      top_performers: topPerformers.rows,
      needs_attention: needsAttention.rows,
      freeze_statistics: freezeStats.rows[0],
      alerts_summary: alertsStats.rows[0],
      criteria_performance: criteriaPerformance.rows,
      insights: {
        overall_health: evaluationStats.rows[0]?.avg_performance >= 75 ? 'ممتاز' : 
                       evaluationStats.rows[0]?.avg_performance >= 65 ? 'جيد' : 'يحتاج تطوير',
        improvement_areas: criteriaPerformance.rows
          .filter(c => c.avg_percentage < 70)
          .slice(0, 5)
          .map(c => c.criteria_name),
        recommendations: [
          'متابعة المتطوعين ذوي الأداء المنخفض',
          'تعزيز المعايير ضعيفة الأداء',
          'تقدير المتطوعين المتميزين',
          'مراجعة أسباب التنبيهات النشطة'
        ]
      },
      generated_at: new Date().toISOString(),
      generated_by: req.user.fullName
    };

    // تسجيل العملية
    await logAuditTrail(req, 'VIEW', 'reports', 'organization', null, { year, month }, 'عرض تقرير المؤسسة');

    res.json({
      success: true,
      data: report
    });

  } catch (error) {
    console.error('❌ خطأ في توليد تقرير المؤسسة:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في توليد تقرير المؤسسة',
      code: 'GENERATE_ORGANIZATION_REPORT_ERROR'
    });
  }
});

/**
 * تقرير مقارنة أداء المتطوعين
 * GET /api/reports/comparison
 */
router.get('/comparison', authenticateToken, requireEvaluator, async (req, res) => {
  try {
    const { volunteer_ids, year = new Date().getFullYear() } = req.query;

    if (!volunteer_ids) {
      return res.status(400).json({
        success: false,
        message: 'معرفات المتطوعين مطلوبة للمقارنة',
        code: 'VOLUNTEER_IDS_REQUIRED'
      });
    }

    const volunteerIdsArray = volunteer_ids.split(',');

    if (volunteerIdsArray.length < 2 || volunteerIdsArray.length > 10) {
      return res.status(400).json({
        success: false,
        message: 'يمكن مقارنة 2-10 متطوعين فقط',
        code: 'INVALID_COMPARISON_COUNT'
      });
    }

    // جلب بيانات المتطوعين
    const volunteersQuery = `
      SELECT id, full_name, role_type, join_date
      FROM volunteers 
      WHERE id = ANY($1)
      ORDER BY full_name
    `;

    const volunteersResult = await query(volunteersQuery, [volunteerIdsArray]);
    
    if (volunteersResult.rows.length !== volunteerIdsArray.length) {
      return res.status(404).json({
        success: false,
        message: 'بعض المتطوعين غير موجودين',
        code: 'VOLUNTEERS_NOT_FOUND'
      });
    }

    const volunteers = volunteersResult.rows;

    // جلب تقييمات المتطوعين
    const evaluationsQuery = `
      SELECT 
        e.volunteer_id,
        e.evaluation_month,
        e.percentage,
        e.status
      FROM evaluations e
      WHERE e.volunteer_id = ANY($1) 
      AND e.evaluation_year = $2 
      AND e.status = 'approved'
      ORDER BY e.volunteer_id, e.evaluation_month
    `;

    const evaluationsResult = await query(evaluationsQuery, [volunteerIdsArray, parseInt(year)]);

    // تنظيم البيانات للمقارنة
    const comparisonData = volunteers.map(volunteer => {
      const volunteerEvaluations = evaluationsResult.rows.filter(e => e.volunteer_id === volunteer.id);
      
      const monthlyPerformance = {};
      for (let month = 1; month <= 12; month++) {
        const monthEval = volunteerEvaluations.find(e => e.evaluation_month === month);
        monthlyPerformance[month] = monthEval ? monthEval.percentage : null;
      }

      const avgPerformance = volunteerEvaluations.length > 0 
        ? volunteerEvaluations.reduce((sum, e) => sum + e.percentage, 0) / volunteerEvaluations.length
        : 0;

      return {
        volunteer: volunteer,
        statistics: {
          total_evaluations: volunteerEvaluations.length,
          average_performance: Math.round(avgPerformance * 100) / 100,
          highest_score: volunteerEvaluations.length > 0 ? Math.max(...volunteerEvaluations.map(e => e.percentage)) : 0,
          lowest_score: volunteerEvaluations.length > 0 ? Math.min(...volunteerEvaluations.map(e => e.percentage)) : 0,
          consistency_rating: calculateConsistency(volunteerEvaluations.map(e => e.percentage))
        },
        monthly_performance: monthlyPerformance,
        trend_analysis: analyzeTrend(volunteerEvaluations)
      };
    });

    // حساب الترتيب
    const rankedVolunteers = comparisonData
      .sort((a, b) => b.statistics.average_performance - a.statistics.average_performance)
      .map((volunteer, index) => ({
        ...volunteer,
        rank: index + 1
      }));

    const report = {
      comparison_period: {
        year: parseInt(year),
        volunteers_count: volunteers.length
      },
      volunteers_data: rankedVolunteers,
      insights: {
        best_performer: rankedVolunteers[0],
        most_consistent: rankedVolunteers.reduce((prev, current) => 
          (prev.statistics.consistency_rating > current.statistics.consistency_rating) ? prev : current
        ),
        most_improved: rankedVolunteers.find(v => v.trend_analysis.trend === 'تحسن مستمر'),
        average_of_group: Math.round(
          (rankedVolunteers.reduce((sum, v) => sum + v.statistics.average_performance, 0) / rankedVolunteers.length) * 100
        ) / 100
      },
      generated_at: new Date().toISOString(),
      generated_by: req.user.fullName
    };

    res.json({
      success: true,
      data: report
    });

  } catch (error) {
    console.error('❌ خطأ في توليد تقرير المقارنة:', error);
    res.status(500).json({
      success: false,
      message: 'خطأ في توليد تقرير المقارنة',
      code: 'GENERATE_COMPARISON_REPORT_ERROR'
    });
  }
});

// دوال مساعدة لحساب الاتساق والاتجاه
const calculateConsistency = (scores) => {
  if (scores.length < 2) return 0;
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const variance = scores.reduce((sum, score) => sum + Math.pow(score - mean, 2), 0) / scores.length;
  const standardDeviation = Math.sqrt(variance);
  return Math.max(0, 100 - standardDeviation); // كلما قل الانحراف المعياري، زاد الاتساق
};

const analyzeTrend = (evaluations) => {
  if (evaluations.length < 3) return { trend: 'غير كافي للتحليل', direction: 'stable' };
  
  const scores = evaluations.map(e => e.percentage);
  const firstHalf = scores.slice(0, Math.floor(scores.length / 2));
  const secondHalf = scores.slice(Math.floor(scores.length / 2));
  
  const firstAvg = firstHalf.reduce((sum, score) => sum + score, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((sum, score) => sum + score, 0) / secondHalf.length;
  
  const difference = secondAvg - firstAvg;
  
  if (difference > 5) return { trend: 'تحسن مستمر', direction: 'improving' };
  if (difference < -5) return { trend: 'تراجع', direction: 'declining' };
  return { trend: 'مستقر', direction: 'stable' };
};

module.exports = router;