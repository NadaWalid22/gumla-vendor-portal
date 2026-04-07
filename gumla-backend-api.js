/**
 * Gumla Vendor Portal — Backend API
 * Node.js + Express + JWT + Odoo 18 XML-RPC Integration
 *
 * Stack: Node 20 · Express 4 · jsonwebtoken · bcrypt · node-fetch · express-rate-limit
 */

const express      = require('express');
const cors         = require('cors');
const jwt          = require('jsonwebtoken');
const bcrypt       = require('bcrypt');
const rateLimit    = require('express-rate-limit');
const xmlrpc       = require('xmlrpc');
const { body, validationResult } = require('express-validator');
require('dotenv').config();

const app = express();

/* ─── Config ───────────────────────────────────────────── */
const CONFIG = {
  PORT:       process.env.PORT || 4000,
  JWT_SECRET: process.env.JWT_SECRET || 'CHANGE_ME_IN_PRODUCTION',
  JWT_EXPIRY: '7d',

  // Odoo 18 connection
  ODOO: {
    host:     process.env.ODOO_HOST     || 'localhost',
    port:     parseInt(process.env.ODOO_PORT) || 8069,
    db:       process.env.ODOO_DB       || 'gumla_prod',
    user:     process.env.ODOO_USER     || 'admin',
    password: process.env.ODOO_PASSWORD || 'admin',
    protocol: process.env.ODOO_PROTOCOL || 'http', // 'http' | 'https'
  },
};

/* ─── Middleware ───────────────────────────────────────── */
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());

// Rate limiting — global
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

// Rate limiting — auth endpoints
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many login attempts. Try again later.' } });

/* ─── Odoo XML-RPC Client ──────────────────────────────── */
function odooClient(path) {
  const create = CONFIG.ODOO.protocol === 'https' ? xmlrpc.createSecureClient : xmlrpc.createClient;
  return create({ host: CONFIG.ODOO.host, port: CONFIG.ODOO.port, path });
}

let _odooUid = null; // cached UID

async function odooAuthenticate() {
  if (_odooUid) return _odooUid;
  return new Promise((resolve, reject) => {
    const client = odooClient('/xmlrpc/2/common');
    client.methodCall('authenticate', [
      CONFIG.ODOO.db, CONFIG.ODOO.user, CONFIG.ODOO.password, {}
    ], (err, uid) => {
      if (err || !uid) return reject(err || new Error('Odoo auth failed'));
      _odooUid = uid;
      resolve(uid);
    });
  });
}

async function odooCall(model, method, args, kwargs = {}) {
  const uid = await odooAuthenticate();
  return new Promise((resolve, reject) => {
    const client = odooClient('/xmlrpc/2/object');
    client.methodCall('execute_kw', [
      CONFIG.ODOO.db, uid, CONFIG.ODOO.password,
      model, method, args, kwargs
    ], (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

/* ─── Auth Middleware ──────────────────────────────────── */
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const payload = jwt.verify(header.slice(7), CONFIG.JWT_SECRET);
    req.vendor = payload; // { vendorId, email, odooPartnerId }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/* ─── Vendor DB (replace with real DB in production) ──── */
// In production: PostgreSQL table `vendors`
// Schema: id, email, password_hash, company_name, odoo_partner_id, is_active
const VENDOR_DB = new Map([
  ['demo@gumla.com', {
    id: 1,
    email: 'demo@gumla.com',
    passwordHash: bcrypt.hashSync('demo1234', 10),
    company: 'Hassan Electronics Co.',
    name: 'Ahmed Hassan',
    initials: 'AH',
    odooPartnerId: 42,   // res.partner id in Odoo
    odooVendorId: 1042,  // product.supplierinfo vendor id
    isActive: true,
  }]
]);

/* ═══════════════════════════════════════════════════════
   ROUTES
═══════════════════════════════════════════════════════ */

/* ─── Health ─────────────────────────────────────────── */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0', timestamp: new Date().toISOString() });
});

/* ─── POST /api/auth/login ───────────────────────────── */
app.post('/api/auth/login',
  authLimiter,
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty().isLength({ min: 6 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;
    const vendor = VENDOR_DB.get(email);

    if (!vendor || !vendor.isActive) {
      // Constant-time rejection to prevent user enumeration
      await bcrypt.compare(password, '$2b$10$invalidhashfortimingnormalization');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, vendor.passwordHash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { vendorId: vendor.id, email: vendor.email, odooPartnerId: vendor.odooPartnerId, odooVendorId: vendor.odooVendorId },
      CONFIG.JWT_SECRET,
      { expiresIn: CONFIG.JWT_EXPIRY }
    );

    res.json({
      token,
      vendor: {
        id:       vendor.id,
        name:     vendor.name,
        company:  vendor.company,
        email:    vendor.email,
        initials: vendor.initials,
      }
    });
  }
);

/* ─── POST /api/auth/logout ──────────────────────────── */
// With JWT we rely on short expiry + client-side deletion.
// For strict revocation, maintain a token blocklist in Redis.
app.post('/api/auth/logout', requireAuth, (req, res) => {
  // TODO: add token to Redis blocklist if needed
  res.json({ message: 'Logged out successfully' });
});

/* ─── GET /api/products ──────────────────────────────── */
/**
 * Fetch products assigned to this vendor from Odoo.
 *
 * Odoo model: product.supplierinfo
 * Filter: partner_id = vendor.odooPartnerId
 * Returns: product name, SKU, market price, stock, category
 */
app.get('/api/products', requireAuth, async (req, res) => {
  try {
    const { odooPartnerId, odooVendorId } = req.vendor;

    // 1. Fetch vendor-specific supplier info (includes vendor price if already set)
    const supplierInfos = await odooCall(
      'product.supplierinfo', 'search_read',
      [[['partner_id', '=', odooPartnerId]]],
      {
        fields: ['product_tmpl_id', 'product_id', 'price', 'min_qty', 'delay'],
        limit: 500,
      }
    );

    // 2. Extract product template IDs
    const productTmplIds = supplierInfos.map(si => si.product_tmpl_id[0]);

    if (!productTmplIds.length) {
      return res.json({ products: [] });
    }

    // 3. Fetch full product details
    const products = await odooCall(
      'product.template', 'search_read',
      [[['id', 'in', productTmplIds]]],
      {
        fields: [
          'id', 'name', 'default_code', 'categ_id',
          'list_price',  // market / sales price
          'standard_price', // cost price
          'qty_available', 'virtual_available',
          'active', 'image_128',
        ],
      }
    );

    // 4. Merge supplier info with product details
    const supplierMap = {};
    supplierInfos.forEach(si => {
      supplierMap[si.product_tmpl_id[0]] = si;
    });

    const enriched = products.map(p => ({
      id:            p.id,
      name:          p.name,
      sku:           p.default_code || '',
      category:      p.categ_id ? p.categ_id[1] : 'Uncategorized',
      marketPrice:   p.list_price,
      costPrice:     p.standard_price,
      vendorPrice:   supplierMap[p.id]?.price || null,
      minQty:        supplierMap[p.id]?.min_qty || 1,
      stock:         Math.max(0, p.qty_available || 0),
      virtualStock:  p.virtual_available || 0,
      odooSync:      supplierMap[p.id]?.price ? 'synced' : 'pending',
      supplierInfoId: supplierMap[p.id]?.id || null,
    }));

    res.json({ products: enriched, total: enriched.length });
  } catch (err) {
    console.error('[GET /products]', err);
    res.status(502).json({ error: 'Failed to fetch products from Odoo. Please try again.' });
  }
});

/* ─── PATCH /api/products/:id/price ─────────────────────
 * Update or create vendor price in Odoo.
 * Uses product.supplierinfo — either writes to existing record or creates new.
 */
app.patch('/api/products/:id/price',
  requireAuth,
  body('price').isFloat({ min: 0.01 }).withMessage('Price must be a positive number'),
  body('minQty').optional().isInt({ min: 1 }),
  body('note').optional().isString().trim().isLength({ max: 255 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const productId = parseInt(req.params.id);
    if (isNaN(productId)) return res.status(400).json({ error: 'Invalid product ID' });

    const { price, minQty = 1, note, supplierInfoId } = req.body;
    const { odooPartnerId } = req.vendor;

    try {
      // Verify this product belongs to this vendor
      const [allowed] = await odooCall(
        'product.supplierinfo', 'search',
        [[['partner_id', '=', odooPartnerId], ['product_tmpl_id', '=', productId]]],
        { limit: 1 }
      );

      // Also allow creating a new record if vendor is mapped to this product template
      // (In production: add a separate vendor-product mapping table for tighter control)
      const vals = {
        partner_id:       odooPartnerId,
        product_tmpl_id:  productId,
        price:            parseFloat(price),
        min_qty:          parseInt(minQty),
      };

      let siId;
      if (supplierInfoId || allowed) {
        // Update existing record
        siId = supplierInfoId || allowed;
        await odooCall('product.supplierinfo', 'write', [[siId], vals]);
      } else {
        // Create new supplier info record
        siId = await odooCall('product.supplierinfo', 'create', [vals]);
      }

      // Log to vendor audit trail (custom model or chatter)
      // await odooCall('mail.message', 'create', [{ ... }]); // optional

      res.json({
        success: true,
        supplierInfoId: siId,
        price: parseFloat(price),
        updatedAt: new Date().toISOString(),
        message: 'Price updated and synced to Odoo'
      });
    } catch (err) {
      console.error('[PATCH /products/:id/price]', err);
      res.status(502).json({ error: 'Failed to update price in Odoo. Please retry.' });
    }
  }
);

/* ─── POST /api/products/bulk-price ─────────────────────
 * Apply the same price adjustment to multiple products at once.
 */
app.post('/api/products/bulk-price',
  requireAuth,
  body('productIds').isArray({ min: 1 }),
  body('type').isIn(['fixed', 'percent_up', 'percent_down', 'absolute_up', 'absolute_down']),
  body('value').isFloat({ min: 0.01 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { productIds, type, value } = req.body;
    const { odooPartnerId } = req.vendor;

    try {
      // Fetch current supplier infos for these products
      const supplierInfos = await odooCall(
        'product.supplierinfo', 'search_read',
        [[['partner_id', '=', odooPartnerId], ['product_tmpl_id', 'in', productIds]]],
        { fields: ['id', 'product_tmpl_id', 'price'] }
      );

      const updates = [];
      for (const si of supplierInfos) {
        const base = si.price || 0;
        let newPrice;
        switch (type) {
          case 'fixed':        newPrice = value; break;
          case 'percent_up':   newPrice = base * (1 + value / 100); break;
          case 'percent_down': newPrice = base * (1 - value / 100); break;
          case 'absolute_up':  newPrice = base + value; break;
          case 'absolute_down':newPrice = Math.max(0.01, base - value); break;
        }
        newPrice = Math.round(newPrice * 100) / 100;
        await odooCall('product.supplierinfo', 'write', [[si.id], { price: newPrice }]);
        updates.push({ productId: si.product_tmpl_id[0], newPrice, supplierInfoId: si.id });
      }

      res.json({ success: true, updated: updates.length, updates });
    } catch (err) {
      console.error('[POST /products/bulk-price]', err);
      res.status(502).json({ error: 'Bulk update failed. Some prices may not have been updated.' });
    }
  }
);

/* ─── GET /api/products/:id ──────────────────────────── */
app.get('/api/products/:id', requireAuth, async (req, res) => {
  const productId = parseInt(req.params.id);
  if (isNaN(productId)) return res.status(400).json({ error: 'Invalid product ID' });

  try {
    const [product] = await odooCall(
      'product.template', 'read', [[productId]],
      { fields: ['id', 'name', 'default_code', 'list_price', 'qty_available', 'categ_id'] }
    );
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const [si] = await odooCall(
      'product.supplierinfo', 'search_read',
      [[['partner_id', '=', req.vendor.odooPartnerId], ['product_tmpl_id', '=', productId]]],
      { fields: ['price', 'min_qty'], limit: 1 }
    );

    res.json({
      ...product,
      vendorPrice:   si?.price || null,
      minQty:        si?.min_qty || 1,
      supplierInfoId: si?.id || null,
    });
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch product' });
  }
});

/* ─── GET /api/change-history ───────────────────────────
 * Returns vendor's price change log.
 * In production: query a dedicated audit_log table.
 */
app.get('/api/change-history', requireAuth, async (req, res) => {
  // Stub — in production pull from PostgreSQL audit_log table
  res.json({
    history: [
      { productName: 'Laptop Stand Pro', oldPrice: 850, newPrice: 799, changedAt: new Date().toISOString(), note: '' },
    ]
  });
});

/* ─── GET /api/sync-status ───────────────────────────── */
app.get('/api/sync-status', requireAuth, async (req, res) => {
  try {
    await odooAuthenticate();
    res.json({ status: 'connected', odooDb: CONFIG.ODOO.db, checkedAt: new Date().toISOString() });
  } catch {
    res.status(502).json({ status: 'disconnected', error: 'Cannot reach Odoo' });
  }
});

/* ─── 404 ───────────────────────────────────────────── */
app.use((req, res) => res.status(404).json({ error: 'Endpoint not found' }));

/* ─── Global error handler ──────────────────────────── */
app.use((err, req, res, next) => {
  console.error('[Unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

/* ─── Start ──────────────────────────────────────────── */
app.listen(CONFIG.PORT, () => {
  console.log(`✓ Gumla Vendor API running on port ${CONFIG.PORT}`);
  console.log(`  Odoo: ${CONFIG.ODOO.protocol}://${CONFIG.ODOO.host}:${CONFIG.ODOO.port} (db: ${CONFIG.ODOO.db})`);
});

module.exports = app;
