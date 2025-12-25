/**
 * إعدادات قاعدة البيانات لنظام تقييم متطوعي مشروع زاد
 * Database Configuration for Zad Volunteer Evaluation System
 */

const { Pool } = require('pg');
require('dotenv').config();

// إعدادات قاعدة البيانات لـ Railway
const config = {
  // Railway يوفر DATABASE_URL كاملة
  connectionString: process.env.DATABASE_URL,
  // إعدادات بديلة
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: process.env.DB_PORT || process.env.PGPORT || 5432,
  database: process.env.DB_NAME || process.env.PGDATABASE || 'zad_volunteer_system',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASSWORD || process.env.PGPASSWORD || '',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
};

// إنشاء pool للاتصالات
const pool = new Pool(config);

// Event listeners لمتابعة حالة الاتصال
pool.on('connect', (client) => {
  // console.log('✅ اتصال جديد بقاعدة البيانات:', client.processID);
});

pool.on('error', (err) => {
  console.error('❌ خطأ في قاعدة البيانات:', err.message);
});

pool.on('acquire', (client) => {
  // console.log('📦 تم الحصول على اتصال من المجموعة:', client.processID);
});

pool.on('release', (client) => {
  // console.log('🔄 تم إرجاع الاتصال للمجموعة:', client.processID);
});

/**
 * تنفيذ استعلام مع إدارة الأخطاء
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise} Query result
 */
const query = async (text, params) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log(`📊 تم تنفيذ الاستعلام في ${duration}ms:`, text.substring(0, 100));
    return result;
  } catch (error) {
    console.error('❌ خطأ في تنفيذ الاستعلام:', error.message);
    console.error('🔍 الاستعلام:', text);
    console.error('📝 المعاملات:', params);
    throw error;
  }
};

/**
 * الحصول على client مستقل للمعاملات
 * @returns {Promise} Database client
 */
const getClient = async () => {
  try {
    const client = await pool.connect();
    return client;
  } catch (error) {
    console.error('❌ فشل في الحصول على client:', error.message);
    throw error;
  }
};

/**
 * تنفيذ معاملة كاملة
 * @param {Function} callback - Function to execute within transaction
 * @returns {Promise} Transaction result
 */
const transaction = async (callback) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ تم التراجع عن المعاملة:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

/**
 * اختبار الاتصال بقاعدة البيانات
 * @returns {Promise<boolean>} Connection status
 */
const testConnection = async () => {
  try {
    const result = await query('SELECT NOW() as current_time, version() as db_version');
    console.log('✅ نجح اتصال قاعدة البيانات');
    console.log('⏰ الوقت الحالي:', result.rows[0].current_time);
    console.log('🔢 إصدار قاعدة البيانات:', result.rows[0].db_version);
    return true;
  } catch (error) {
    console.error('❌ فشل اتصال قاعدة البيانات:', error.message);
    return false;
  }
};

/**
 * إغلاق جميع الاتصالات
 */
const closePool = async () => {
  try {
    await pool.end();
    console.log('🔚 تم إغلاق جميع اتصالات قاعدة البيانات');
  } catch (error) {
    console.error('❌ خطأ في إغلاق الاتصالات:', error.message);
  }
};

// إغلاق الاتصالات عند إنهاء التطبيق
process.on('SIGINT', closePool);
process.on('SIGTERM', closePool);

module.exports = {
  pool,
  query,
  getClient,
  transaction,
  testConnection,
  closePool
};