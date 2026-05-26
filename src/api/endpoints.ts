const env = (import.meta as ImportMeta & {
  env?: Record<string, string | undefined>;
}).env;

const baseUrl = (env?.VITE_MAHALA_DB_BASE_URL || '').replace(/\/+$/, '');

const endpoints = {
  mahalas: `${baseUrl}/db/mahalas`,
  bulkSaveMahalas: `${baseUrl}/db/mahalas/bulk-save`,
};

export default endpoints;
