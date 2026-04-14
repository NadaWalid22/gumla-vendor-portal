# Gumla Vendor Portal — Architecture & Documentation

> **Version:** 2.0.0 · **Stack:** HTML/CSS/JS + Node.js + Gumla app · **Author:** Gumla Engineering

---

## 1. Project Overview

The Gumla Vendor Portal is a **B2B marketplace vendor management system** with two parts:

| Part | Description |
|------|-------------|
| **Public Landing Page** | Attracts and onboards vendors; explains the platform value proposition |
| **Vendor Dashboard** | Authenticated area for viewing products, editing prices, and syncing to Gumla app |

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND (Browser)                       │
│  Landing Page ──► Login Form ──► Vendor Dashboard               │
│  Vanilla HTML/CSS/JS  OR  React (if scaled)                     │
└────────────────────────────┬────────────────────────────────────┘
                             │  HTTPS REST API (JWT)
┌────────────────────────────▼────────────────────────────────────┐
│                     BACKEND API (Node.js)                       │
│  Express · JWT Auth · Input Validation · Rate Limiting          │
│  Role-based access — vendors only see their own products        │
└──────────────┬──────────────────────────┬───────────────────────┘
               │ XML-RPC / JSON-RPC        │ SQL
┌──────────────▼──────────┐   ┌───────────▼──────────────────────┐
│     Gumla app ERP         │   │   PostgreSQL (Vendor Auth DB)     │
│  product.template       │   │   vendors, audit_log tables       │
│  product.supplierinfo   │   │   (separate from Odoo DB)         │
│  res.partner            │   └──────────────────────────────────┘
│  stock.quant            │
└─────────────────────────┘
```

---

## 3. Folder Structure

```
gumla-vendor-portal/
├── index.html                  ← Complete frontend (landing + dashboard)
│
├── backend/
│   ├── server.js               ← Express API server (main entry)
│   ├── package.json
│   ├── .env.example
│   │
│   ├── routes/
│   │   ├── auth.js             ← POST /api/auth/login, /logout
│   │   ├── products.js         ← GET /api/products, PATCH /:id/price
│   │   └── sync.js             ← GET /api/sync-status
│   │
│   ├── middleware/
│   │   ├── auth.js             ← JWT verification middleware
│   │   └── rateLimiter.js      ← Auth & global rate limits
│   │
│   ├── services/
│   │   ├── odoo.js             ← Odoo XML-RPC client wrapper
│   │   └── auditLog.js         ← Price change logging
│   │
│   └── db/
│       ├── schema.sql          ← PostgreSQL schema
│       └── seeds.sql           ← Demo vendor data
│
├── README.md                   ← This file
└── docs/
    ├── api-reference.md        ← Full API endpoint docs
    ├── odoo-setup.md           ← Gumla app configuration guide
    └── deployment.md           ← Production deployment guide
```

---

## 4. Database Schema (PostgreSQL)

```sql
-- Vendor accounts (separate from Odoo user management)
CREATE TABLE vendors (
  id              SERIAL PRIMARY KEY,
  email           VARCHAR(255) UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  company_name    VARCHAR(255) NOT NULL,
  contact_name    VARCHAR(255),
  phone           VARCHAR(50),
  odoo_partner_id INTEGER NOT NULL,  -- links to res.partner in Odoo
  odoo_vendor_id  INTEGER,           -- links to product.supplierinfo partner
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  last_login      TIMESTAMPTZ
);

-- Price change audit trail
CREATE TABLE price_audit_log (
  id              SERIAL PRIMARY KEY,
  vendor_id       INTEGER REFERENCES vendors(id),
  product_id      INTEGER NOT NULL,         -- Odoo product.template id
  product_name    VARCHAR(255),
  old_price       NUMERIC(12,2),
  new_price       NUMERIC(12,2) NOT NULL,
  min_qty         INTEGER DEFAULT 1,
  note            TEXT,
  odoo_sync_ok    BOOLEAN DEFAULT FALSE,
  odoo_si_id      INTEGER,                  -- product.supplierinfo id
  changed_at      TIMESTAMPTZ DEFAULT NOW(),
  ip_address      INET
);

-- Index for fast vendor product lookups
CREATE INDEX idx_audit_vendor ON price_audit_log(vendor_id);
CREATE INDEX idx_audit_product ON price_audit_log(product_id);
```

---

## 5. Key API Endpoints

### Authentication

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| POST | `/api/auth/login` | Vendor login — returns JWT | ✗ |
| POST | `/api/auth/logout` | Invalidate session | ✓ |

**Login Request:**
```json
POST /api/auth/login
{ "email": "vendor@co.com", "password": "secret123" }
```

**Login Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR...",
  "vendor": {
    "id": 1,
    "name": "Ahmed Hassan",
    "company": "Hassan Electronics Co.",
    "email": "vendor@co.com"
  }
}
```

---

### Products

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | `/api/products` | Fetch all vendor-specific products from Odoo | ✓ |
| GET | `/api/products/:id` | Single product detail | ✓ |
| PATCH | `/api/products/:id/price` | Update/set vendor price in Odoo | ✓ |
| POST | `/api/products/bulk-price` | Bulk price adjustment | ✓ |

**Update Price Request:**
```json
PATCH /api/products/42/price
Authorization: Bearer <token>

{
  "price": 799.00,
  "minQty": 1,
  "supplierInfoId": 88,
  "note": "Promotional pricing Q1"
}
```

**Update Price Response:**
```json
{
  "success": true,
  "supplierInfoId": 88,
  "price": 799.00,
  "updatedAt": "2025-06-01T14:33:10.000Z",
  "message": "Price updated and synced to Odoo"
}
```

**Bulk Price Request:**
```json
POST /api/products/bulk-price
{
  "productIds": [1, 2, 3, 7],
  "type": "percent_down",
  "value": 10
}
```

---

### Sync & Status

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | `/api/sync-status` | Check Odoo connection health | ✓ |
| GET | `/api/change-history` | Vendor price change audit log | ✓ |

---

## 6. Gumla app Integration Details

### Models Used

| Odoo Model | Purpose |
|------------|---------|
| `product.template` | Product catalog (name, SKU, price, stock) |
| `product.supplierinfo` | **Per-vendor pricing** — one record per vendor per product |
| `res.partner` | Vendor identity (matched by `partner_id`) |
| `stock.quant` | Real-time stock levels (optional) |

### How Vendor Pricing Works in Gumla app

```
product.template (id: 42, name: "Laptop Stand Pro")
    └── product.supplierinfo
            partner_id   → res.partner (vendor's Odoo partner)
            price        → 799.00   ← THIS is what the portal updates
            min_qty      → 1
            delay        → 0
```

Each vendor has **one `product.supplierinfo` record per product** they supply. The portal reads and writes only these records — never touching other vendors' data.

### XML-RPC Call for Price Update

```javascript
// Authenticate
uid = authenticate(db, 'admin', password, {})

// Write vendor price
execute_kw(db, uid, password,
  'product.supplierinfo', 'write',
  [[supplierInfoId], { price: 799.00, min_qty: 1 }]
)
```

---

## 7. Security Design

### Vendor Data Isolation

Every API route that reads/writes Odoo data includes:
```javascript
// ALWAYS filter by authenticated vendor's partner_id
[['partner_id', '=', req.vendor.odooPartnerId], ...]
```

This ensures **Vendor A cannot access or modify Vendor B's pricing** even if they know product IDs.

### Security Checklist

| Control | Implementation |
|---------|---------------|
| Authentication | JWT (RS256 in production), 7-day expiry |
| Password storage | bcrypt (cost factor 12) |
| Input validation | express-validator on all endpoints |
| Rate limiting | 10 auth attempts / 15 min |
| CORS | Whitelist of allowed origins |
| Data isolation | All Odoo queries filtered by `partner_id` |
| HTTPS | Required in production (nginx TLS termination) |
| SQL injection | Parameterized queries (no raw SQL) |
| XSS | HTML encoded on render |

---

## 8. Setup & Deployment

### Local Development

```bash
# 1. Clone the repo
git clone https://github.com/gumla/vendor-portal.git
cd vendor-portal

# 2. Install backend deps
cd backend
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your Odoo credentials

# 4. Start the API server
npm run dev   # uses nodemon

# 5. Open index.html in browser (or serve with any static server)
npx serve ..  # from backend/
```

### .env Configuration

```env
PORT=4000
JWT_SECRET=your_256_bit_random_secret_here
FRONTEND_URL=http://localhost:3000

# Gumla app
ODOO_HOST=your-odoo-server.com
ODOO_PORT=8069
ODOO_DB=gumla_production
ODOO_USER=vendor_portal_api_user
ODOO_PASSWORD=strong_api_password
ODOO_PROTOCOL=https
```

### Production Deployment (Docker)

```dockerfile
# backend/Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 4000
CMD ["node", "server.js"]
```

```yaml
# docker-compose.yml
version: '3.8'
services:
  api:
    build: ./backend
    env_file: .env
    ports: ["4000:4000"]
    restart: unless-stopped

  nginx:
    image: nginx:alpine
    volumes:
      - ./index.html:/usr/share/nginx/html/index.html
      - ./nginx.conf:/etc/nginx/conf.d/default.conf
    ports: ["80:80", "443:443"]
    depends_on: [api]
```

### Odoo Setup Requirements

1. Create a dedicated API user in Odoo with access to:
   - `product.template` (read)
   - `product.supplierinfo` (read, write, create)
   - `stock.quant` (read) — optional

2. For each vendor, create a `res.partner` record in Odoo and link its `id` to the vendor's portal account.

3. Assign products to vendors via `product.supplierinfo` records (can be done from Odoo purchase settings per product).

---

## 9. Assumptions & Limitations

| # | Assumption / Limitation | Recommendation |
|---|------------------------|----------------|
| 1 | Vendors are pre-created by admin (no self-registration to Odoo) | Build an admin onboarding flow that creates `res.partner` and maps vendor |
| 2 | Product assignment is done in Odoo (admin-controlled) | Add a vendor-product mapping UI in the admin portal |
| 3 | Only vendor price (`product.supplierinfo.price`) is managed | Extend to manage `pricelist.item` for more complex pricing rules |
| 4 | Single currency (EGP) in demo | Add currency selection; Odoo supports multi-currency natively |
| 5 | Frontend demo uses in-memory mock data | Connect to `/api/products` endpoint for production |
| 6 | No image upload for products | Add Cloudinary/S3 integration + Odoo `image_1920` field write |
| 7 | Audit log is a stub in demo | Implement full PostgreSQL `price_audit_log` table |
| 8 | JWT stored in localStorage in production | Use httpOnly cookies for XSS protection |

---

## 10. Sample UI Components

### Product Table Row (HTML)
```html
<tr>
  <td><input type="checkbox" class="row-check" data-id="42" /></td>
  <td>
    <div class="product-cell">
      <div class="product-thumb">💻</div>
      <div>
        <div class="product-name">Laptop Stand Pro</div>
        <div class="product-sku">LS-0041</div>
      </div>
    </div>
  </td>
  <td class="price-cell">EGP 799</td>
  <td>
    <button class="btn btn-outline-accent btn-sm" onclick="openEditModal(42)">
      Edit Price
    </button>
  </td>
</tr>
```

### Price Update API Call (Frontend)
```javascript
async function updatePrice(productId, price, supplierInfoId) {
  const token = localStorage.getItem('gumla_token');
  const res = await fetch(`/api/products/${productId}/price`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ price, supplierInfoId, minQty: 1 })
  });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}
```

---

*Gumla Vendor Portal · Built for the B2B Marketplace · Powered by Gumla app*
