/**
 * خادم التطبيق الرئيسي لنظام تقييم متطوعي مشروع زاد
 * Main Application Server for Zad Volunteer Evaluation System
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// استيراد إعدادات قاعدة البيانات
const { testConnection } = require('./config/database');

// استيراد المسارات
const authRoutes = require('./routes/auth');
const volunteerRoutes = require('./routes/volunteers');
const evaluationRoutes = require('./routes/evaluations');
const criteriaRoutes = require('./routes/criteria');
const reportRoutes = require('./routes/reports');
const alertRoutes = require('./routes/alerts');

// إنشاء التطبيق
const app = express();
const PORT = process.env.PORT || 3000;

// إنشاء مجلد السجلات إذا لم يكن موجوداً
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// إعدادات الأمان
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      scriptSrc: ["'self'"],
    },
  },
}));

// إعدادات CORS لـ Railway
const corsOptions = {
  origin: function (origin, callback) {
    // قبول جميع نطاقات railway.app
    const allowedOrigins = [
      process.env.CORS_ORIGIN,
      process.env.FRONTEND_URL,
      'http://localhost:3001',
      'http://localhost:3000'
    ];
    
    // قبول جميع نطاقات railway.app 
    if (!origin || allowedOrigins.indexOf(origin) !== -1 || origin.includes('railway.app')) {
      callback(null, true);
    } else {
      callback(null, true); // متسامح في الإنتاج
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};
app.use(cors(corsOptions));

// إعدادات معدل الطلبات
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 دقيقة
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: {
    error: 'تم تجاوز الحد الأقصى للطلبات، حاول مرة أخرى لاحقاً',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// إعدادات السجلات
const logStream = fs.createWriteStream(path.join(logDir, 'access.log'), { flags: 'a' });
app.use(morgan('combined', { stream: logStream }));

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// Middleware لمعالجة JSON
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Middleware للملفات الثابتة
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// إضافة معلومات الطلب
app.use((req, res, next) => {
  req.requestTime = new Date().toISOString();
  req.clientIP = req.ip || req.connection.remoteAddress;
  next();
});

// الصفحة الرئيسية للـ API
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'مرحباً بك في نظام تقييم متطوعي مشروع زاد',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    documentation: '/api/docs',
    status: 'running'
  });
});

// صفحة معلومات النظام
app.get('/api', (req, res) => {
  res.json({
    success: true,
    data: {
      system: 'نظام تقييم متطوعي مشروع زاد',
      version: '1.0.0',
      description: 'نظام ويب متكامل لتقييم وإدارة المتطوعين',
      organization: 'مؤسسة إنسان الخيرية',
      features: [
        'إدارة المتطوعين',
        'نظام التقييم الشهري',
        'التقارير والإحصائيات',
        'نظام الفريز والأعذار',
        'التنبيهات الذكية',
        'الملاحظات التراكمية'
      ],
      endpoints: {
        auth: '/api/auth',
        volunteers: '/api/volunteers',
        evaluations: '/api/evaluations',
        criteria: '/api/criteria',
        reports: '/api/reports',
        alerts: '/api/alerts'
      }
    }
  });
});

// اختبار حالة النظام
app.get('/api/health', async (req, res) => {
  try {
    const dbStatus = await testConnection();
    const systemInfo = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      database: dbStatus ? 'connected' : 'disconnected',
      version: '1.0.0',
      environment: process.env.NODE_ENV || 'development'
    };

    res.json({
      success: true,
      data: systemInfo
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'خطأ في فحص حالة النظام',
      error: error.message
    });
  }
});

// استخدام المسارات
app.use('/api/auth', authRoutes);
app.use('/api/volunteers', volunteerRoutes);
app.use('/api/evaluations', evaluationRoutes);
app.use('/api/criteria', criteriaRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/alerts', alertRoutes);

// Middleware لمعالجة الأخطاء العامة
app.use((err, req, res, next) => {
  console.error('❌ خطأ غير متوقع:', err);
  
  // سجل تفاصيل الخطأ
  const errorLog = {
    timestamp: new Date().toISOString(),
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    ip: req.clientIP,
    userAgent: req.get('User-Agent')
  };
  
  fs.appendFileSync(path.join(logDir, 'error.log'), JSON.stringify(errorLog) + '\n');
  
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'خطأ داخلي في الخادم',
    code: err.code || 'INTERNAL_SERVER_ERROR',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Middleware للمسارات غير الموجودة
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'المسار المطلوب غير موجود',
    code: 'NOT_FOUND',
    path: req.originalUrl
  });
});

// بدء تشغيل الخادم
const startServer = async () => {
  try {
    // اختبار الاتصال بقاعدة البيانات
    console.log('🔍 اختبار الاتصال بقاعدة البيانات...');
    const dbConnected = await testConnection();
    
    if (!dbConnected) {
      console.error('❌ فشل الاتصال بقاعدة البيانات');
      process.exit(1);
    }
    
    // بدء تشغيل الخادم
    const server = app.listen(PORT, () => {
      console.log('🚀 تم تشغيل خادم نظام تقييم متطوعي مشروع زاد');
      console.log(`📍 عنوان الخادم: http://localhost:${PORT}`);
      console.log(`🌍 بيئة التشغيل: ${process.env.NODE_ENV || 'development'}`);
      console.log(`📊 API متاح على: http://localhost:${PORT}/api`);
      console.log(`💚 النظام جاهز لاستقبال الطلبات`);
    });

    // إعداد إيقاف النظام بأمان
    const gracefulShutdown = (signal) => {
      console.log(`\n📴 تلقي إشارة الإيقاف: ${signal}`);
      server.close(() => {
        console.log('🔚 تم إغلاق الخادم بأمان');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    
  } catch (error) {
    console.error('❌ فشل في تشغيل الخادم:', error.message);
    process.exit(1);
  }
};

// تشغيل الخادم
startServer();

module.exports = app;