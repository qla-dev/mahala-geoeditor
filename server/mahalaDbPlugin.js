import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

const ROUTE_PREFIX = '/db/mahalas';

let cachedPool = null;
let cachedPoolKey = null;

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return dotenv.parse(fs.readFileSync(filePath));
}

function buildDbConfig(rootDir) {
  const backendEnv = readEnvFile(path.resolve(rootDir, '../mahala-backend/.env'));
  const geoeditorEnv = {
    ...readEnvFile(path.join(rootDir, '.env')),
    ...readEnvFile(path.join(rootDir, '.env.local')),
  };
  const mergedEnv = {
    ...backendEnv,
    ...geoeditorEnv,
    ...process.env,
  };

  const host = mergedEnv.MAHALA_DB_HOST || mergedEnv.DB_HOST || '127.0.0.1';
  const port = Number(mergedEnv.MAHALA_DB_PORT || mergedEnv.DB_PORT || 3306);
  const database =
    mergedEnv.MAHALA_DB_DATABASE || mergedEnv.DB_DATABASE || '';
  const user =
    mergedEnv.MAHALA_DB_USERNAME || mergedEnv.DB_USERNAME || '';
  const password =
    mergedEnv.MAHALA_DB_PASSWORD ?? mergedEnv.DB_PASSWORD ?? '';

  if (!database) {
    throw new Error(
      'Missing MAHALA_DB_DATABASE/DB_DATABASE for direct geoeditor DB access.',
    );
  }

  if (!user) {
    throw new Error(
      'Missing MAHALA_DB_USERNAME/DB_USERNAME for direct geoeditor DB access.',
    );
  }

  if (!Number.isFinite(port)) {
    throw new Error('Database port must be a valid number.');
  }

  return {
    host,
    port,
    database,
    user,
    password,
  };
}

async function getPool(rootDir) {
  const config = buildDbConfig(rootDir);
  const configKey = JSON.stringify(config);

  if (cachedPool && cachedPoolKey === configKey) {
    return cachedPool;
  }

  if (cachedPool) {
    await cachedPool.end().catch(() => {});
  }

  cachedPool = mysql.createPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    waitForConnections: true,
    connectionLimit: 10,
    decimalNumbers: true,
    dateStrings: true,
  });
  cachedPoolKey = configKey;

  return cachedPool;
}

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function parseJsonValue(value, fallback) {
  if (value == null) {
    return fallback;
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  return value;
}

function normalizeCoordinate(coordinate, contextLabel) {
  const latitude = Number(coordinate?.latitude);
  const longitude = Number(coordinate?.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new HttpError(400, `${contextLabel} must include valid latitude and longitude.`);
  }

  if (latitude < -90 || latitude > 90) {
    throw new HttpError(400, `${contextLabel} latitude is out of range.`);
  }

  if (longitude < -180 || longitude > 180) {
    throw new HttpError(400, `${contextLabel} longitude is out of range.`);
  }

  return { latitude, longitude };
}

function normalizeRing(coordinates, label) {
  if (!Array.isArray(coordinates) || coordinates.length < 3) {
    throw new HttpError(400, `${label} must contain at least 3 coordinates.`);
  }

  return coordinates.map((coordinate, index) =>
    normalizeCoordinate(coordinate, `${label} coordinate ${index + 1}`),
  );
}

function normalizeHoles(holes) {
  if (holes == null) {
    return [];
  }

  if (!Array.isArray(holes)) {
    throw new HttpError(400, 'Holes must be an array.');
  }

  return holes.map((hole, index) => normalizeRing(hole, `Hole ${index + 1}`));
}

function buildCenter(coordinates) {
  const latitude =
    coordinates.reduce((sum, coordinate) => sum + coordinate.latitude, 0) /
    coordinates.length;
  const longitude =
    coordinates.reduce((sum, coordinate) => sum + coordinate.longitude, 0) /
    coordinates.length;

  return { latitude, longitude };
}

function formatMahalaRow(row) {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: row.slug == null ? null : String(row.slug),
    status: row.status == null ? null : String(row.status),
    privacy: row.privacy == null ? 0 : Number(row.privacy),
    owner_id: row.owner_id == null ? null : Number(row.owner_id),
    level: row.level == null ? 2 : Number(row.level),
    center: {
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
    },
    coordinates: parseJsonValue(row.coordinates, []),
    holes: parseJsonValue(row.holes, []),
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

async function fetchMahalaById(connection, id) {
  const [rows] = await connection.query(
    `
      select
        id,
        name,
        slug,
        status,
        privacy,
        owner_id,
        level,
        latitude,
        longitude,
        coordinates,
        holes,
        created_at,
        updated_at
      from mahalas
      where id = ?
      limit 1
    `,
    [id],
  );

  return rows[0] ?? null;
}

async function idExists(connection, id) {
  const [rows] = await connection.query(
    'select id from mahalas where id = ? limit 1',
    [id],
  );

  return rows.length > 0;
}

async function resolveUniqueId(connection, requestedId, name) {
  if (requestedId) {
    return requestedId;
  }

  const baseId = `user-${slugify(name) || 'mahala'}`;
  let resolvedId = baseId;
  let suffix = 2;

  while (await idExists(connection, resolvedId)) {
    resolvedId = `${baseId}-${suffix}`;
    suffix += 1;
  }

  return resolvedId;
}

async function slugExists(connection, slug, ignoredId) {
  const query = ignoredId
    ? 'select id from mahalas where slug = ? and id <> ? limit 1'
    : 'select id from mahalas where slug = ? limit 1';
  const params = ignoredId ? [slug, ignoredId] : [slug];
  const [rows] = await connection.query(query, params);

  return rows.length > 0;
}

async function resolveUniqueSlug(connection, requestedSlug, name, currentId) {
  const startingSlug = requestedSlug || slugify(name) || slugify(currentId) || 'mahala';

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(startingSlug)) {
    throw new HttpError(
      400,
      'Slug must contain only lowercase letters, numbers, and hyphens.',
    );
  }

  let resolvedSlug = startingSlug;
  let suffix = 2;

  while (await slugExists(connection, resolvedSlug, currentId)) {
    resolvedSlug = `${startingSlug}-${suffix}`;
    suffix += 1;
  }

  return resolvedSlug;
}

async function ensureOwnerExists(connection, ownerId) {
  if (ownerId == null) {
    return null;
  }

  const normalizedOwnerId = Number(ownerId);

  if (!Number.isInteger(normalizedOwnerId) || normalizedOwnerId < 1) {
    throw new HttpError(400, 'owner_id must be a positive integer or null.');
  }

  const [rows] = await connection.query(
    'select id from users where id = ? limit 1',
    [normalizedOwnerId],
  );

  if (rows.length === 0) {
    throw new HttpError(400, `owner_id ${normalizedOwnerId} does not exist.`);
  }

  return normalizedOwnerId;
}

function normalizePrivacy(value, fallback = 0) {
  if (value == null || value === '') {
    return fallback;
  }

  const privacy = Number(value);

  if (!Number.isInteger(privacy) || privacy < 0) {
    throw new HttpError(400, 'privacy must be an integer greater than or equal to 0.');
  }

  return privacy;
}

function normalizeLevel(value, fallback = 2) {
  if (value == null || value === '') {
    return fallback;
  }

  const level = Number(value);

  if (!Number.isInteger(level)) {
    throw new HttpError(400, 'level must be an integer.');
  }

  return level;
}

function normalizeStatus(value, fallback = 'draft') {
  if (value == null) {
    return fallback;
  }

  return String(value);
}

async function readRequestBody(req) {
  return await new Promise((resolve, reject) => {
    let rawBody = '';

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      rawBody += chunk;

      if (rawBody.length > 1_000_000) {
        reject(new HttpError(413, 'Request body is too large.'));
      }
    });
    req.on('end', () => {
      if (!rawBody.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch {
        reject(new HttpError(400, 'Request body must be valid JSON.'));
      }
    });
    req.on('error', (error) => {
      reject(error);
    });
  });
}

async function loadMahalas(rootDir) {
  const pool = await getPool(rootDir);
  const [rows] = await pool.query(`
    select
      id,
      name,
      slug,
      status,
      privacy,
      owner_id,
      level,
      latitude,
      longitude,
      coordinates,
      holes,
      created_at,
      updated_at
    from mahalas
    order by created_at desc, id desc
  `);

  return rows.map(formatMahalaRow);
}

async function saveMahalas(rootDir, payload) {
  const mahalas = Array.isArray(payload?.mahalas) ? payload.mahalas : null;

  if (!mahalas || mahalas.length === 0) {
    throw new HttpError(400, 'mahalas must be a non-empty array.');
  }

  const pool = await getPool(rootDir);
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const persistedMahalas = [];

    for (const candidate of mahalas) {
      const requestedId = candidate?.id ? String(candidate.id).trim() : '';
      const existingRow = requestedId
        ? await fetchMahalaById(connection, requestedId)
        : null;
      const name = String(candidate?.name || existingRow?.name || '').trim();

      if (!name) {
        throw new HttpError(400, 'Every mahala must include a name.');
      }

      const coordinates = normalizeRing(candidate?.coordinates, 'Coordinates');
      const holes = normalizeHoles(candidate?.holes);
      const center = buildCenter(coordinates);
      const nextId = existingRow
        ? String(existingRow.id)
        : await resolveUniqueId(connection, requestedId, name);
      const nextSlug = await resolveUniqueSlug(
        connection,
        candidate?.slug ? String(candidate.slug).trim() : '',
        name,
        existingRow?.id ?? nextId,
      );
      const privacy = normalizePrivacy(candidate?.privacy, existingRow?.privacy ?? 0);
      const ownerId = await ensureOwnerExists(
        connection,
        candidate?.owner_id ?? existingRow?.owner_id ?? null,
      );
      const level = normalizeLevel(candidate?.level, existingRow?.level ?? 2);
      const status = normalizeStatus(candidate?.status, existingRow?.status ?? 'draft');

      if (existingRow) {
        await connection.query(
          `
            update mahalas
            set
              name = ?,
              slug = ?,
              status = ?,
              privacy = ?,
              owner_id = ?,
              level = ?,
              latitude = ?,
              longitude = ?,
              coordinates = ?,
              holes = ?,
              updated_at = now()
            where id = ?
          `,
          [
            name,
            nextSlug,
            status,
            privacy,
            ownerId,
            level,
            center.latitude,
            center.longitude,
            JSON.stringify(coordinates),
            JSON.stringify(holes),
            nextId,
          ],
        );
      } else {
        await connection.query(
          `
            insert into mahalas (
              id,
              name,
              slug,
              status,
              privacy,
              owner_id,
              level,
              latitude,
              longitude,
              coordinates,
              holes,
              created_at,
              updated_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now(), now())
          `,
          [
            nextId,
            name,
            nextSlug,
            status,
            privacy,
            ownerId,
            level,
            center.latitude,
            center.longitude,
            JSON.stringify(coordinates),
            JSON.stringify(holes),
          ],
        );
      }

      const savedRow = await fetchMahalaById(connection, nextId);
      persistedMahalas.push(formatMahalaRow(savedRow));
    }

    await connection.commit();

    return persistedMahalas;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function buildHandler(rootDir) {
  return async (req, res, next) => {
    if (!req.url?.startsWith(ROUTE_PREFIX)) {
      next();
      return;
    }

    const requestUrl = new URL(req.url, 'http://localhost');

    try {
      if (req.method === 'GET' && requestUrl.pathname === ROUTE_PREFIX) {
        const mahalas = await loadMahalas(rootDir);
        sendJson(res, 200, { data: mahalas });
        return;
      }

      if (
        req.method === 'POST' &&
        requestUrl.pathname === `${ROUTE_PREFIX}/bulk-save`
      ) {
        const body = await readRequestBody(req);
        const mahalas = await saveMahalas(rootDir, body);
        sendJson(res, 200, {
          message: 'Mahalas saved successfully.',
          data: mahalas,
        });
        return;
      }

      sendJson(res, 404, { message: 'Mahala DB route not found.' });
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      const message =
        error instanceof Error
          ? error.message
          : 'Unexpected geoeditor database error.';

      sendJson(res, statusCode, { message });
    }
  };
}

function attachMiddleware(server, rootDir) {
  server.middlewares.use(buildHandler(rootDir));
}

export function mahalaDbPlugin() {
  let rootDir = process.cwd();

  return {
    name: 'mahala-db-plugin',
    configResolved(config) {
      rootDir = config.root;
    },
    configureServer(server) {
      attachMiddleware(server, rootDir);
    },
    configurePreviewServer(server) {
      attachMiddleware(server, rootDir);
    },
  };
}
