// =====================================================================
//  Rol tabanlı yetki (RBAC). Admin rolleri: super_admin, risk, support, finance
// =====================================================================
export const PERMISSIONS = {
  'overview.read': 'Genel bakışı görüntüleme',
  'users.read': 'Kullanıcıları görüntüleme',
  'users.manage': 'Kullanıcı askıya alma / plan değiştirme / oturum kapatma',
  'users.trading': 'Kullanıcının işlemlerini durdurma',
  'risk.manage': 'Platform riski ve global durdurma',
  'integrations.manage': 'Entegrasyonları yönetme',
  'billing.read': 'Abonelik ve ödemeleri görüntüleme',
  'billing.manage': 'Plan düzenleme / iade',
  'announcements.manage': 'Duyuru yayınlama',
  'audit.read': 'Denetim günlüğünü görüntüleme',
  'team.manage': 'Admin ekibini ve rolleri yönetme',
}

export const ROLES = {
  super_admin: { label: 'Süper Admin', color: 'red', permissions: Object.keys(PERMISSIONS) },
  risk: { label: 'Risk Görevlisi', color: 'yellow', permissions: ['overview.read', 'users.read', 'users.trading', 'risk.manage', 'integrations.manage', 'audit.read'] },
  support: { label: 'Destek', color: 'sky', permissions: ['overview.read', 'users.read', 'users.manage', 'announcements.manage'] },
  finance: { label: 'Finans', color: 'green', permissions: ['overview.read', 'users.read', 'billing.read', 'billing.manage'] },
}

export const isAdminRole = (role) => role in ROLES
export const permissionsOf = (role) => ROLES[role]?.permissions ?? []
export const can = (role, perm) => permissionsOf(role).includes(perm)
