const env = (import.meta as ImportMeta & {
  env?: Record<string, string | undefined>;
}).env;

const fallbackHost =
  typeof window !== 'undefined' && window.location.hostname
    ? window.location.hostname
    : '127.0.0.1';

const fallbackProtocol =
  typeof window !== 'undefined' && window.location.protocol === 'https:'
    ? 'https:'
    : 'http:';

const baseUrl =
  env?.VITE_MAHALA_API_BASE_URL ||
  `${fallbackProtocol}//${fallbackHost}/mahala/mahala-backend/public/api`;

const endpoints = {
  mahalas: `${baseUrl}/mahalas`,
  bulkSaveMahalas: `${baseUrl}/mahalas/bulk-save`,
};

export default endpoints;
