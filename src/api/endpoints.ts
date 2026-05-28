const env = (import.meta as ImportMeta & {
  env?: Record<string, string | undefined>;
}).env;

const defaultBaseUrl = 'https://trendify.ba/mahala-api/public/api';
const baseUrl = ((env?.VITE_MAHALA_DB_BASE_URL || defaultBaseUrl) ?? '').replace(/\/+$/, '');

const endpoints = {
  mahalas: `${baseUrl}/mahalas`,
  bulkSaveMahalas: `${baseUrl}/mahalas/bulk-save`,
};

export default endpoints;
