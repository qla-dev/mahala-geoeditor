const env = (import.meta as ImportMeta & {
  env?: Record<string, string | undefined>;
}).env;

const baseUrl = (env?.VITE_MAHALA_DB_BASE_URL || '').replace(/\/+$/, '');

const endpoints = baseUrl
  ? {
      mahalas: `${baseUrl}/mahalas`,
      bulkSaveMahalas: `${baseUrl}/mahalas/bulk-save`,
    }
  : {
      mahalas: `/db/mahalas`,
      bulkSaveMahalas: `/db/mahalas/bulk-save`,
    };

export default endpoints;
