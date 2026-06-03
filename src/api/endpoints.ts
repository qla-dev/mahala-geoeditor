const env = (import.meta as ImportMeta & {
  env?: Record<string, string | undefined>;
}).env;

const defaultBaseUrl = 'https://api.mahala.app/public/api';
const baseUrl = ((env?.VITE_MAHALA_DB_BASE_URL || defaultBaseUrl) ?? '').replace(/\/+$/, '');

const endpoints = {
  mahalas: `${baseUrl}/mahalas`,
  bulkSaveMahalas: `${baseUrl}/mahalas/bulk-save`,
};

export default endpoints;
