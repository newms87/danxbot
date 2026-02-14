# Users & Authentication Domain

The Users/Auth domain manages user accounts, role-based access control, and authentication across the Flytedesk platform. Users connect to Buyer and Supplier accounts through junction tables.

## Model Hierarchy

```
User (users)
  ├── BuyerUser (buyer_user) — junction to Buyer
  ├── SupplierUser (supplier_user) — junction to Supplier
  ├── Role (roles) — via role_user pivot
  │     └── Permission (permissions) — via permission_role pivot
  └── Invite (invites) — pending invitations
```

## User

**Model:** `ssap/app/Models/Account/User.php`
**Table:** `users`

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| id | int | Primary key |
| email | string | Unique login email |
| first_name | string | First name |
| last_name | string | Last name |
| password | string | Hashed password |
| phone | string | Phone number |
| title | string | Job title |
| ssp_user_id | int | Synced SSP platform user ID |
| last_active_at | timestamp | Last activity |
| active | boolean | Whether user is active |
| deleted_at | timestamp | Soft delete |

### User Type Constants

| Constant | Value | Description |
|----------|-------|-------------|
| TYPE_SUPPLIER | `supplier` | Supplier/publication user |
| TYPE_BUYER | `buyer` | Buyer/advertiser user |
| TYPE_FULFILLMENT_POD | `fulfillment-pod` | Internal fulfillment rep |

### Key Relationships

| Relationship | Type | Target |
|-------------|------|--------|
| roles() | BelongsToMany | Role (pivot: role_user) |
| buyers() | BelongsToMany | Buyer (pivot: buyer_user) |
| suppliers() | BelongsToMany | Supplier (pivot: supplier_user) |
| buyerEdges() | HasMany | BuyerUser |
| supplierEdges() | HasMany | SupplierUser |
| carts() | HasMany | Cart |
| contacts() | HasMany | Contact |
| userSettings() | BelongsToMany | UserSetting (pivot value) |
| reppedBuyers() | MorphedByMany | Buyer (polymorphic reppable) |
| reppedOrders() | MorphedByMany | Order (polymorphic reppable) |

### Key Methods

| Method | Description |
|--------|-------------|
| can($permission, $requireAll) | Check permissions by slug |
| cachedRoles() | Get roles with Cache::rememberForever |
| isFlytedeskAdmin() | Check for admin role |
| isFlytedeskAutomation() | Check for SSP API role |
| supplierAccount() | Get primary supplier |
| buyerAccount() | Get primary buyer |
| resolveSspUserId() | Resolve/create SSP user ID via API |

### Scopes

| Scope | Description |
|-------|-------------|
| scopeSuperAdmin() | Filter by admin roles |
| scopeSupplierTeam() | Filter by supplier roles |
| scopeBuyerTeam() | Filter by buyer roles |
| scopeIsActive($active) | Filter by active field |

## BuyerUser

**Model:** `ssap/app/Models/Buyer/BuyerUser.php`
**Table:** `buyer_user` (junction)

| Column | Type | Description |
|--------|------|-------------|
| id | int | Primary key |
| user_id | FK | Links to users.id |
| buyer_id | FK | Links to buyers.id |

Relationships: `user()` → User, `buyer()` → Buyer

## SupplierUser

**Model:** `ssap/app/Models/Supplier/SupplierUser.php`
**Table:** `supplier_user` (junction)

| Column | Type | Description |
|--------|------|-------------|
| id | int | Primary key |
| user_id | FK | Links to users.id |
| supplier_id | FK | Links to suppliers.id |

Relationships: `user()` → User, `supplier()` → Supplier
Traits: Taggable (supports tag names)

## Role System

**Model:** `ssap/app/Models/Auth/Role.php`
**Table:** `roles`

### Role ID Constants

**Admin Roles:**

| Constant | ID | Slug | Description |
|----------|----|------|-------------|
| SUPER_ADMIN | 10 | super_admin | Full platform access |
| SUPER_DIGITAL_ADMIN | 12 | super_digital_admin | Digital admin |
| SSP_API | 13 | ssp_api | SSP automation role |

**Supplier Roles:**

| Constant | ID | Description |
|----------|----|-------------|
| PUB_ADMIN | 1 | Publication admin |
| PUB_EDIT | 2 | Publication editor |
| PUB_COLLABORATE | 3 | Publication collaborator |
| PUB_VIEW | 4 | Publication viewer |
| PUB_EDITORIAL_ADMIN | 5 | Editorial admin |

**Buyer Roles:**

| Constant | ID | Description |
|----------|----|-------------|
| BUYER_ADMIN | 6 | Buyer admin |
| BUYER_EDIT | 7 | Buyer editor |
| BUYER_COLLABORATE | 8 | Buyer collaborator |
| BUYER_VIEW | 9 | Buyer viewer |

**Guest Roles (no real user accounts):**

| Constant | ID | Description |
|----------|----|-------------|
| GUEST | 11 | Guest |
| GUEST_INVOICE_PAYER | 101 | Can pay invoices |
| GUEST_CAMPAIGN_VIEWER | 102 | Can view campaigns |

### Role Collections

```
$adminRoles = [SUPER_ADMIN, SUPER_DIGITAL_ADMIN]
$automationRoles = [SSP_API]
$supplierRoles = [PUB_ADMIN, PUB_EDIT, PUB_COLLABORATE, PUB_VIEW, PUB_EDITORIAL_ADMIN]
$buyerRoles = [BUYER_ADMIN, BUYER_EDIT, BUYER_COLLABORATE, BUYER_VIEW]
```

### Role Categories

| Category | Value | Description |
|----------|-------|-------------|
| CATEGORY_ADMIN | 0 | Admin roles |
| CATEGORY_SUPPLIER | 1 | Supplier roles |
| CATEGORY_BUYER | 2 | Buyer roles |
| CATEGORY_LOCAL_BUYER | 3 | Local buyer roles |

## Permission System

**Model:** `ssap/app/Models/Auth/Permission.php`
**Table:** `permissions`
**Pivot:** `permission_role`

### Key Permissions

**Admin:**
- `do_anything` — SUPER_ADMIN only, full access
- `takeover_suppliers`, `takeover_buyers` — Impersonate accounts
- `manage_feature_flags` — Feature flag management
- `access_ssp_api` — SSP API access
- `manage_super_objects` — Super object management

**Supplier:**
- `pub_modify_organization_settings` — PUB_ADMIN only
- `pub_edit_order` — PUB_ADMIN, PUB_EDIT, PUB_COLLABORATE
- `pub_manage_creative` — All PUB roles
- `pub_manage_team_members` — PUB_ADMIN
- `pub_edit_roles` — PUB_ADMIN

**Buyer:**
- `buyer_manage_campaign` — BUYER_ADMIN, BUYER_EDIT
- `buyer_manage_creative` — BUYER_ADMIN, BUYER_EDIT, BUYER_COLLABORATE
- `buyer_manage_team_members` — BUYER_ADMIN

**Guest:**
- `guest_pay_invoices` — GUEST_INVOICE_PAYER
- `view_campaign_as_guest` — GUEST_CAMPAIGN_VIEWER

## Authentication

**Config:** `ssap/config/auth.php`

| Setting | Value |
|---------|-------|
| Default guard | api (JWT) |
| Web guard | Session-based |
| User provider | Eloquent (User model) |
| Password reset table | password_resets |
| Password reset expiry | 60 minutes |
| OAuth | QuickBooks provider |

### Auth Controllers

| Controller | Purpose |
|-----------|---------|
| LoginController | Login/logout (AuthenticatesUsers trait) |
| OAuthController | OAuth flow (start, authorize, callback) |
| ForgotPasswordController | Password reset requests |
| ResetPasswordController | Password reset token validation |
| RegisterController | User registration |
| TakeoverController | Super admin impersonation |

**Path:** `ssap/app/Http/Controllers/Auth/`

## User Management

**Repository:** `ssap/app/Repositories/UserRepository.php`

| Method | Description |
|--------|-------------|
| create(Role, $input) | Create user with initial role |
| addRole(User, $roles) | Add role (won't override SUPER_ADMIN) |
| updateAccount(User, $input) | Update user and contacts |
| sendResetPasswordEmail(User) | Send password reset email |
| setUserRole(User, Role) | Change user's role |

## Invitations

**Model:** `ssap/app/Models/Account/Invite.php`
**Table:** `invites`

| Status | Description |
|--------|-------------|
| INVITE_SENT | Invitation sent, pending |
| REQUESTED | Access requested |
| REJECTED | Invitation rejected |
| ACCEPTED | Invitation accepted |

Links to User, Buyer, or Supplier. Stores role as string (resolved on acceptance).

## Common SQL Queries

**Find user by email:**
```sql
SELECT * FROM users WHERE email = ? AND deleted_at IS NULL;
```

**Find users by role:**
```sql
SELECT u.* FROM users u
JOIN role_user ru ON u.id = ru.user_id
JOIN roles r ON ru.role_id = r.id
WHERE r.id IN (10, 12)  -- admin roles
AND u.deleted_at IS NULL;
```

**Find users for a buyer:**
```sql
SELECT u.* FROM users u
JOIN buyer_user bu ON u.id = bu.user_id
WHERE bu.buyer_id = ?
AND u.deleted_at IS NULL;
```

**Find users for a supplier:**
```sql
SELECT u.* FROM users u
JOIN supplier_user su ON u.id = su.user_id
WHERE su.supplier_id = ?
AND u.deleted_at IS NULL;
```

**Check user permissions:**
```sql
SELECT p.slug FROM permissions p
JOIN permission_role pr ON p.id = pr.permission_id
JOIN role_user ru ON pr.role_id = ru.role_id
WHERE ru.user_id = ?;
```

**Find active admins:**
```sql
SELECT u.* FROM users u
JOIN role_user ru ON u.id = ru.user_id
WHERE ru.role_id IN (10, 12)
AND u.deleted_at IS NULL;
```

## Key Files

| File | Purpose |
|------|---------|
| ssap/app/Models/Account/User.php | Main User model |
| ssap/app/Models/Buyer/BuyerUser.php | User-Buyer junction |
| ssap/app/Models/Supplier/SupplierUser.php | User-Supplier junction |
| ssap/app/Models/Auth/Role.php | Role model with constants |
| ssap/app/Models/Auth/Permission.php | Permission model |
| ssap/config/auth.php | Auth configuration |
| ssap/app/Repositories/UserRepository.php | User management |
| ssap/database/seeders/RoleSeeder.php | Role definitions |
| ssap/database/seeders/PermissionSeeder.php | Permission definitions |
