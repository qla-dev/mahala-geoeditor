import { useState, useMemo, useRef, useEffect, Fragment } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import {
  MapContainer,
  TileLayer,
  Polygon,
  Marker,
  Polyline,
  CircleMarker,
  Tooltip,
  useMapEvents,
} from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Layers,
  MousePointer2,
  Settings,
  Share2,
  Plus,
  EyeOff,
  Eye,
  Save,
  RotateCcw,
} from 'lucide-react';
import endpoints from './api/endpoints';
import { SARAJEVO_POLYGONS } from './data/sarajevoPolygons';

// @ts-ignore
import iconUrl from 'leaflet/dist/images/marker-icon.png';
// @ts-ignore
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png';
// @ts-ignore
import shadowUrl from 'leaflet/dist/images/marker-shadow.png';

const EDITABLE_DATASET_ID = 'mahalas';
const DRAW_ZONE_STATUS = 'draft';
const DEFAULT_MAP_CENTER: [number, number] = [43.8563, 18.4131];
const GEOEDITOR_AUTH_STORAGE_KEY = 'mahala.geoeditor.authenticated';
const GEOEDITOR_USERNAME = 'qla.dev';
const GEOEDITOR_PASSWORD = 'password123';
const ACTIVE_ZONE_LABEL_MIN_ZOOM = 0;
const BOUNDARY_ZONE_LABEL_MIN_ZOOM = 9.3;
const SARAJEVO_MIN_ZOOM = 10;
const SARAJEVO_POLYGON_LABEL_MIN_ZOOM = 11;
const USER_MAHALA_LEVEL_1_LABEL_MIN_ZOOM = 12.3;
const USER_MAHALA_LEVEL_2_LABEL_MIN_ZOOM = 13.6;

const globalCustomIcon = new L.Icon({
  iconUrl,
  iconRetinaUrl,
  shadowUrl,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});

L.Icon.Default.mergeOptions({
  iconRetinaUrl,
  iconUrl,
  shadowUrl,
});

type Coordinate = { latitude: number; longitude: number };
type Zone = {
  id: string;
  name: string;
  slug?: string | null;
  status?: string | null;
  privacy?: number | null;
  owner_id?: number | null;
  level?: number | null;
  center?: Coordinate;
  coordinates: Coordinate[];
  holes?: Coordinate[][];
  created_at?: string | null;
  updated_at?: string | null;
};
type Dataset = {
  id: string;
  name: string;
  visible: boolean;
  color: string;
  zones: Zone[];
};
type FocusedZone = {
  datasetId: string;
  zoneId: string;
};
type BasemapMode = 'street' | 'satellite';

const BASEMAPS: Record<
  BasemapMode,
  {
    label: string;
    description: string;
    baseUrl: string;
    attribution: string;
    labelsUrl?: string;
    labelsAttribution?: string;
  }
> = {
  street: {
    label: 'Street',
    description: 'Carto light street map',
    baseUrl: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution:
      '&copy; OpenStreetMap contributors &copy; CARTO',
  },
  satellite: {
    label: 'Satellite',
    description: 'Esri imagery with place labels',
    baseUrl:
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution:
      'Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    labelsUrl:
      'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    labelsAttribution: 'Labels &copy; Esri',
  },
};

function getCoordinateKey(coordinate: Coordinate) {
  return `${coordinate.latitude},${coordinate.longitude}`;
}

function cloneCoordinate(coordinate: Coordinate): Coordinate {
  return {
    latitude: coordinate.latitude,
    longitude: coordinate.longitude,
  };
}

function cloneRing(coordinates: Coordinate[]): Coordinate[] {
  return coordinates.map(cloneCoordinate);
}

function cloneHoles(holes: Coordinate[][] = []): Coordinate[][] {
  return holes.map(cloneRing);
}

function cloneZone(zone: Zone): Zone {
  return {
    ...zone,
    center: zone.center ? cloneCoordinate(zone.center) : undefined,
    coordinates: cloneRing(zone.coordinates),
    holes: cloneHoles(zone.holes),
  };
}

function normalizeCoordinate(coordinate: unknown): Coordinate | null {
  const latitude = Number((coordinate as Coordinate | undefined)?.latitude);
  const longitude = Number((coordinate as Coordinate | undefined)?.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return { latitude, longitude };
}

function normalizeRing(coordinates: unknown): Coordinate[] {
  if (!Array.isArray(coordinates)) {
    return [];
  }

  return coordinates.map(normalizeCoordinate).filter(Boolean) as Coordinate[];
}

function normalizeHoles(holes: unknown): Coordinate[][] {
  if (!Array.isArray(holes)) {
    return [];
  }

  return holes
    .map((hole) => normalizeRing(hole))
    .filter((hole) => hole.length >= 3);
}

function getPolygonCenter(coordinates: Coordinate[]): Coordinate {
  if (coordinates.length === 0) {
    return { latitude: 0, longitude: 0 };
  }

  const latitude =
    coordinates.reduce((sum, coordinate) => sum + coordinate.latitude, 0) /
    coordinates.length;
  const longitude =
    coordinates.reduce((sum, coordinate) => sum + coordinate.longitude, 0) /
    coordinates.length;

  return { latitude, longitude };
}

function syncZoneCenter(zone: Zone): Zone {
  return {
    ...zone,
    center: getPolygonCenter(zone.coordinates),
    holes: cloneHoles(zone.holes),
  };
}

function normalizeZone(zone: unknown): Zone | null {
  const candidate = zone as Zone | undefined;
  const coordinates = normalizeRing(candidate?.coordinates);

  if (!candidate?.id || !candidate?.name || coordinates.length < 3) {
    return null;
  }

  const holes = normalizeHoles(candidate?.holes);
  const center =
    normalizeCoordinate(candidate?.center) ?? getPolygonCenter(coordinates);

  return {
    id: String(candidate.id),
    name: String(candidate.name),
    slug: candidate.slug ?? null,
    status: candidate.status ?? DRAW_ZONE_STATUS,
    privacy: candidate.privacy == null ? 0 : Number(candidate.privacy),
    owner_id: candidate.owner_id == null ? null : Number(candidate.owner_id),
    level: candidate.level == null ? 2 : Number(candidate.level),
    center,
    coordinates,
    holes,
    created_at: candidate.created_at ?? null,
    updated_at: candidate.updated_at ?? null,
  };
}

function normalizeZones(zones: unknown): Zone[] {
  if (!Array.isArray(zones)) {
    return [];
  }

  return zones.map(normalizeZone).filter(Boolean) as Zone[];
}

function generateMetadataCode(zone: Zone) {
  return `export const USER_MAHALAS = [
  {
    id: "${zone.id}",
    name: "${zone.name}",
    center: {
      latitude: ${zone.center?.latitude || 0},
      longitude: ${zone.center?.longitude || 0},
    },
    coordinates: [
${zone.coordinates
  .map(
    (coordinate) => `      {
        latitude: ${coordinate.latitude},
        longitude: ${coordinate.longitude},
      }`,
  )
  .join(',\n')}
    ],
    holes: [],
  }
];`;
}

function sameCoordinate(left: Coordinate, right: Coordinate) {
  return (
    left.latitude === right.latitude && left.longitude === right.longitude
  );
}

function zonesEqual(left: Zone, right: Zone) {
  return (
    left.id === right.id &&
    left.name === right.name &&
    (left.status ?? null) === (right.status ?? null) &&
    (left.privacy ?? null) === (right.privacy ?? null) &&
    (left.owner_id ?? null) === (right.owner_id ?? null) &&
    (left.level ?? null) === (right.level ?? null) &&
    JSON.stringify(left.coordinates) === JSON.stringify(right.coordinates) &&
    JSON.stringify(left.holes ?? []) === JSON.stringify(right.holes ?? [])
  );
}

function pointInPolygon(point: Coordinate, coordinates: Coordinate[]) {
  let inside = false;
  const x = point.longitude;
  const y = point.latitude;

  for (let i = 0, j = coordinates.length - 1; i < coordinates.length; j = i++) {
    const xi = coordinates[i].longitude;
    const yi = coordinates[i].latitude;
    const xj = coordinates[j].longitude;
    const yj = coordinates[j].latitude;

    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;

    if (intersect) {
      inside = !inside;
    }
  }

  return inside;
}

function buildZoneId(name: string) {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return `user-${slug || 'mahala'}-${Date.now()}`;
}

function buildSavePayload(zone: Zone) {
  return {
    id: zone.id,
    name: zone.name,
    status: zone.status || DRAW_ZONE_STATUS,
    privacy: zone.privacy ?? 0,
    owner_id: zone.owner_id ?? null,
    level: zone.level ?? 2,
    coordinates: cloneRing(zone.coordinates),
    holes: cloneHoles(zone.holes),
  };
}

function mergePersistedZones(currentZones: Zone[], persistedZones: Zone[]) {
  const persistedById = new Map(
    persistedZones.map((zone) => [zone.id, cloneZone(zone)]),
  );

  return currentZones.map(
    (zone) => persistedById.get(zone.id) ?? cloneZone(zone),
  );
}

function getSaveLabel(count: number) {
  return count === 1 ? 'Save 1 Mahala' : `Save ${count} Mahalas`;
}

export default function App() {
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [mahalaZones, setMahalaZones] = useState<Zone[]>([]);
  const [savedMahalaZones, setSavedMahalaZones] = useState<Zone[]>([]);
  const [datasetVisibility, setDatasetVisibility] = useState<
    Record<string, boolean>
  >({
    'user-mahalas-1': true,
    'user-mahalas-2': true,
    sarajevo: true,
  });
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<
    'idle' | 'saving' | 'success' | 'error'
  >('idle');
  const [currentZoom, setCurrentZoom] = useState<number>(12);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [mode, setMode] = useState<
    'view' | 'draw' | 'edit-shared' | 'edit-single'
  >('view');
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [focusedZone, setFocusedZone] = useState<FocusedZone | null>(null);
  const [basemapMode, setBasemapMode] = useState<BasemapMode>('street');
  const [snappingEnabled, setSnappingEnabled] = useState(true);
  const [inspectZone, setInspectZone] = useState<Zone | null>(null);
  const [mahalaSearch, setMahalaSearch] = useState<string>('');
  const [inspectDraft, setInspectDraft] = useState<Zone | null>(null);
  const [leftTab, setLeftTab] = useState<'tools' | 'basemap' | 'datasets'>('tools');
  const [drawingCoords, setDrawingCoords] = useState<Coordinate[]>([]);
  const [mousePos, setMousePos] = useState<Coordinate | null>(null);

  const pendingZones = useMemo(() => {
    const savedById = new Map<string, Zone>(
      savedMahalaZones.map((zone) => [zone.id, zone]),
    );

    return mahalaZones.filter((zone) => {
      const savedZone = savedById.get(zone.id);
      return !savedZone || !zonesEqual(zone, savedZone);
    });
  }, [mahalaZones, savedMahalaZones]);

  const pendingZoneIdSet = useMemo(
    () => new Set(pendingZones.map((zone) => zone.id)),
    [pendingZones],
  );
  const pendingZoneNames = useMemo(
    () => pendingZones.map((zone) => zone.name),
    [pendingZones],
  );

  const datasets = useMemo<Dataset[]>(
    () => {
      const user1 = mahalaZones.filter((zone) => zone.level === 1);
      const user2 = mahalaZones.filter((zone) => zone.level === 2);

      return [
        {
          id: 'sarajevo',
          name: 'Sarajevo Borders',
          visible: datasetVisibility.sarajevo ?? false,
          color: '#7c3aed',
          zones: SARAJEVO_POLYGONS as Zone[],
        },
        {
          id: 'user-mahalas-1',
          name: 'User Mahalas 1',
          visible: datasetVisibility['user-mahalas-1'] ?? true,
          color: '#3b82f6',
          zones: user1,
        },
        {
          id: 'user-mahalas-2',
          name: 'User Mahalas 2',
          visible: datasetVisibility['user-mahalas-2'] ?? true,
          color: '#10b981',
          zones: user2,
        },
      ];
    },
    [datasetVisibility, mahalaZones],
  );

  const visibleDatasets = useMemo(
    () => datasets.filter((dataset) => dataset.visible),
    [datasets],
  );

  const editableDatasetVisible =
    (datasetVisibility['user-mahalas-1'] ?? true) ||
    (datasetVisibility['user-mahalas-2'] ?? true);
  const activeBasemap = BASEMAPS[basemapMode];
  const drawModeCursorStyle = useMemo(
    () =>
      mode === 'draw'
        ? ({
            '--draw-mode-cursor': `url(${iconUrl}) 12 41, auto`,
          } as CSSProperties)
        : undefined,
    [mode],
  );

  const loadMahalas = async () => {
    setLoadState('loading');
    setLoadError(null);

    try {
      const response = await fetch(endpoints.mahalas, {
        headers: {
          Accept: 'application/json',
        },
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(payload?.message || 'Failed to load mahalas.');
      }

      const zones = normalizeZones(payload?.data);

      setMahalaZones(zones.map(cloneZone));
      setSavedMahalaZones(zones.map(cloneZone));
      setLoadState('ready');
    } catch (error) {
      setLoadState('error');
      setLoadError(
        error instanceof Error ? error.message : 'Failed to load mahalas.',
      );
    }
  };

  useEffect(() => {
    if (localStorage.getItem(GEOEDITOR_AUTH_STORAGE_KEY) === 'true') {
      setIsAuthenticated(true);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    void loadMahalas();
  }, [isAuthenticated]);

  useEffect(() => {
    if (mode !== 'draw') {
      setMousePos(null);
    }
  }, [mode]);

  useEffect(() => {
    if (selectedZoneId && !mahalaZones.some((zone) => zone.id === selectedZoneId)) {
      setSelectedZoneId(null);
    }
  }, [mahalaZones, selectedZoneId]);

  const handleMapClick = (latlng: Coordinate) => {
    if (mode === 'draw') {
      let nextPoint = latlng;

      if (snappingEnabled) {
        const snappedVertex = getClosestVertex(
          latlng,
          visibleDatasets,
          drawingCoords,
        );
        if (snappedVertex) {
          nextPoint = snappedVertex;
        }
      }

      setDrawingCoords((current) => [...current, nextPoint]);
      return;
    }

    if (mode === 'edit-single') {
      const clickedZone = visibleDatasets
        .filter((dataset) => dataset.id.startsWith('user-mahalas'))
        .flatMap((dataset) => dataset.zones)
        .find((zone) => pointInPolygon(latlng, zone.coordinates));

      if (clickedZone) {
        setSelectedZoneId(clickedZone.id);
      }
    }
  };

  const handleFinishDraw = () => {
    if (drawingCoords.length < 3) {
      alert('A polygon needs at least 3 points.');
      setDrawingCoords([]);
      return;
    }

    const name = window.prompt('Enter name for this polygon:');

    if (!name?.trim()) {
      setDrawingCoords([]);
      return;
    }

    const newZone = syncZoneCenter({
      id: buildZoneId(name),
      name: name.trim(),
      status: DRAW_ZONE_STATUS,
      privacy: 0,
      owner_id: null,
      level: 2,
      coordinates: cloneRing(drawingCoords),
      holes: [],
    });

    setMahalaZones((current) => [...current, newZone]);
    setSelectedZoneId(newZone.id);
    setDrawingCoords([]);
    setMode('view');
    setSaveState('idle');
    setSaveMessage(`"${newZone.name}" is ready to save to the database.`);
  };

  useEffect(() => {
    if (mode !== 'draw') {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;

      if (
        target?.isContentEditable ||
        tagName === 'INPUT' ||
        tagName === 'TEXTAREA' ||
        tagName === 'SELECT'
      ) {
        return;
      }

      if (event.key !== 'Enter' && event.key !== 'NumpadEnter') {
        return;
      }

      event.preventDefault();
      handleFinishDraw();
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [drawingCoords.length, mode]);

  const toggleDataset = (datasetId: string) => {
    setDatasetVisibility((current) => ({
      ...current,
      [datasetId]: !current[datasetId],
    }));
  };

  const updateVertexShared = (oldCoord: Coordinate, newCoord: Coordinate) => {
    setMahalaZones((current) =>
      current.map((zone) => {
        let changed = false;
        const coordinates = zone.coordinates.map((coordinate) => {
          if (!sameCoordinate(coordinate, oldCoord)) {
            return coordinate;
          }

          changed = true;
          return cloneCoordinate(newCoord);
        });

        if (!changed) {
          return zone;
        }

        return syncZoneCenter({ ...zone, coordinates });
      }),
    );
    setSaveState('idle');
    setSaveMessage(null);
  };

  const updateVertexSingle = (
    zoneId: string,
    index: number,
    newCoord: Coordinate,
  ) => {
    setMahalaZones((current) =>
      current.map((zone) => {
        if (zone.id !== zoneId) {
          return zone;
        }

        const coordinates = cloneRing(zone.coordinates);
        coordinates[index] = cloneCoordinate(newCoord);
        return syncZoneCenter({ ...zone, coordinates });
      }),
    );
    setSaveState('idle');
    setSaveMessage(null);
  };

  const removeVertexSingle = (zoneId: string, index: number) => {
    let deletionBlocked = false;

    setMahalaZones((current) =>
      current.map((zone) => {
        if (zone.id !== zoneId) {
          return zone;
        }

        if (zone.coordinates.length <= 3) {
          deletionBlocked = true;
          return zone;
        }

        const coordinates = cloneRing(zone.coordinates);
        coordinates.splice(index, 1);
        return syncZoneCenter({ ...zone, coordinates });
      }),
    );

    if (deletionBlocked) {
      alert('A polygon must keep at least 3 points.');
      return;
    }

    setSaveState('idle');
    setSaveMessage(null);
  };

  const insertVertexSingle = (
    zoneId: string,
    insertIndex: number,
    newCoord: Coordinate,
  ) => {
    setMahalaZones((current) =>
      current.map((zone) => {
        if (zone.id !== zoneId) {
          return zone;
        }

        const coordinates = cloneRing(zone.coordinates);
        coordinates.splice(insertIndex, 0, cloneCoordinate(newCoord));
        return syncZoneCenter({ ...zone, coordinates });
      }),
    );
    setSaveState('idle');
    setSaveMessage(null);
  };

  const insertVertexShared = (
    firstCoord: Coordinate,
    secondCoord: Coordinate,
    midpoint: Coordinate,
  ) => {
    setMahalaZones((current) =>
      current.map((zone) => {
        let changed = false;
        const coordinates: Coordinate[] = [];

        for (let index = 0; index < zone.coordinates.length; index += 1) {
          const currentCoordinate = zone.coordinates[index];
          const nextCoordinate =
            zone.coordinates[(index + 1) % zone.coordinates.length];

          coordinates.push(currentCoordinate);

          const isForwardMatch =
            sameCoordinate(currentCoordinate, firstCoord) &&
            sameCoordinate(nextCoordinate, secondCoord);
          const isReverseMatch =
            sameCoordinate(currentCoordinate, secondCoord) &&
            sameCoordinate(nextCoordinate, firstCoord);

          if (isForwardMatch || isReverseMatch) {
            coordinates.push(cloneCoordinate(midpoint));
            changed = true;
          }
        }

        if (!changed) {
          return zone;
        }

        return syncZoneCenter({ ...zone, coordinates });
      }),
    );
    setSaveState('idle');
    setSaveMessage(null);
  };

  const removeVertexShared = (targetCoord: Coordinate) => {
    let deletionBlocked = false;
    let changed = false;

    setMahalaZones((current) => {
      const affectedZones = current.filter((zone) =>
        zone.coordinates.some((coordinate) => sameCoordinate(coordinate, targetCoord)),
      );

      if (affectedZones.some((zone) => zone.coordinates.length <= 3)) {
        deletionBlocked = true;
        return current;
      }

      return current.map((zone) => {
        const removeIndex = zone.coordinates.findIndex((coordinate) =>
          sameCoordinate(coordinate, targetCoord),
        );

        if (removeIndex === -1) {
          return zone;
        }

        const coordinates = cloneRing(zone.coordinates);
        coordinates.splice(removeIndex, 1);
        changed = true;
        return syncZoneCenter({ ...zone, coordinates });
      });
    });

    if (deletionBlocked) {
      alert('A polygon must keep at least 3 points.');
      return;
    }

    if (!changed) {
      return;
    }

    setSaveState('idle');
    setSaveMessage(null);
  };

  const savePendingChanges = async () => {
    if (pendingZones.length === 0 || saveState === 'saving') {
      return;
    }

    const zonesToSave = pendingZones.map(cloneZone);
    const currentZones = mahalaZones.map(cloneZone);

    setSaveState('saving');
    setSaveMessage(null);

    try {
      const response = await fetch(endpoints.bulkSaveMahalas, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mahalas: zonesToSave.map(buildSavePayload),
        }),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(payload?.message || 'Failed to save mahalas.');
      }

      const persistedZones = normalizeZones(payload?.data);
      const mergedZones = mergePersistedZones(currentZones, persistedZones);

      setMahalaZones(mergedZones.map(cloneZone));
      setSavedMahalaZones(mergedZones.map(cloneZone));
      setSaveState('success');
      setSaveMessage(
        persistedZones.length === 1
          ? 'Saved 1 mahala to the database.'
          : `Saved ${persistedZones.length} mahalas to the database.`,
      );
    } catch (error) {
      setSaveState('error');
      setSaveMessage(
        error instanceof Error ? error.message : 'Failed to save mahalas.',
      );
    }
  };

  const discardPendingChanges = () => {
    const restoredZones = savedMahalaZones.map(cloneZone);

    setMahalaZones(restoredZones);
    setSaveState('idle');
    setSaveMessage(null);

    if (
      selectedZoneId &&
      !restoredZones.some((zone) => zone.id === selectedZoneId)
    ) {
      setSelectedZoneId(null);
    }
  };

  const handleLogin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (
      loginUsername.trim() === GEOEDITOR_USERNAME &&
      loginPassword === GEOEDITOR_PASSWORD
    ) {
      localStorage.setItem(GEOEDITOR_AUTH_STORAGE_KEY, 'true');
      setIsAuthenticated(true);
      setLoginError(null);
      return;
    }

    setLoginError('Pogresan korisnik ili lozinka.');
  };

  const handleLogout = () => {
    localStorage.removeItem(GEOEDITOR_AUTH_STORAGE_KEY);
    setIsAuthenticated(false);
    setLoginPassword('');
    setLoginError(null);
    setInspectZone(null);
  };

  if (!isAuthenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 text-neutral-900">
        <div className="w-full max-w-md rounded-3xl border border-neutral-200 bg-white p-8 shadow-xl">
          <div className="mb-8">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-purple-600">
              Mahala GeoEditor
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-neutral-900">
              Sign in
            </h1>
            <p className="mt-2 text-sm text-neutral-500">
              Enter your geoeditor credentials.
            </p>
          </div>

          <form className="space-y-4" onSubmit={handleLogin}>
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-neutral-700">
                Username
              </span>
              <input
                type="text"
                autoComplete="username"
                value={loginUsername}
                onChange={(event) => {
                  setLoginUsername(event.target.value);
                  if (loginError) {
                    setLoginError(null);
                  }
                }}
                className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-900 outline-none transition focus:border-purple-400 focus:bg-white"
                placeholder="Enter username"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-neutral-700">
                Password
              </span>
              <input
                type="password"
                autoComplete="current-password"
                value={loginPassword}
                onChange={(event) => {
                  setLoginPassword(event.target.value);
                  if (loginError) {
                    setLoginError(null);
                  }
                }}
                className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-900 outline-none transition focus:border-purple-400 focus:bg-white"
                placeholder="Enter password"
              />
            </label>

            {loginError ? (
              <p className="text-sm text-rose-500">{loginError}</p>
            ) : null}

            <button
              type="submit"
              className="w-full rounded-2xl bg-purple-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-purple-500"
            >
              Sign in
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-neutral-50 font-sans text-neutral-900">
      <aside className="z-10 flex w-80 flex-col border-r border-neutral-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-neutral-100 p-4">
          <div className="flex items-center space-x-2">
            <Layers className="h-6 w-6 text-purple-600" />
            <h1 className="text-lg font-semibold tracking-tight">
              Mahala GeoEditor
            </h1>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-semibold text-neutral-600 transition hover:bg-neutral-100"
          >
            Logout
          </button>
        </div>

        <div className="flex-grow overflow-y-auto p-4">
          <div className="mb-3">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setLeftTab('tools')}
                className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
                  leftTab === 'tools'
                    ? 'bg-purple-50 text-purple-700'
                    : 'bg-white hover:bg-neutral-100 text-neutral-700 border border-transparent'
                }`}
              >
                Tools
              </button>
              <button
                type="button"
                onClick={() => setLeftTab('basemap')}
                className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
                  leftTab === 'basemap'
                    ? 'bg-purple-50 text-purple-700'
                    : 'bg-white hover:bg-neutral-100 text-neutral-700 border border-transparent'
                }`}
              >
                Basemap
              </button>
              <button
                type="button"
                onClick={() => setLeftTab('datasets')}
                className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
                  leftTab === 'datasets'
                    ? 'bg-purple-50 text-purple-700'
                    : 'bg-white hover:bg-neutral-100 text-neutral-700 border border-transparent'
                }`}
              >
                Datasets
              </button>
            </div>
          </div>

          {leftTab === 'tools' && (
            <div className="mb-6 space-y-2">
              <button
                onClick={() => {
                  setMode('draw');
                  setDrawingCoords([]);
                }}
                className={`w-full rounded-md px-3 py-2 ${
                  mode === 'draw'
                    ? 'bg-purple-50 text-purple-700'
                    : 'hover:bg-neutral-100'
                }`}
              >
                <div className="flex items-center font-medium">
                  <Plus className="mr-2 h-4 w-4" />
                  Draw Mahala
                </div>
              </button>
              {mode === 'draw' ? (
                <div className="mt-1 rounded border border-neutral-100 bg-neutral-50 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="snapping"
                      className="text-sm font-medium text-neutral-600"
                    >
                      Snap to existing points
                    </label>
                    <input
                      type="checkbox"
                      id="snapping"
                      checked={snappingEnabled}
                      onChange={(event) => setSnappingEnabled(event.target.checked)}
                      className="h-4 w-4 rounded text-purple-600 focus:ring-purple-500"
                    />
                  </div>
                  <p className="mt-2 text-xs leading-5 text-neutral-500">
                    When drawing, click existing visible points to snap there.
                    Turn it off to place points freely.
                  </p>
                </div>
              ) : null}
              <button
                onClick={() => setMode('view')}
                className={`flex w-full items-center rounded-md px-3 py-2 ${
                  mode === 'view'
                    ? 'bg-purple-50 font-medium text-purple-700'
                    : 'hover:bg-neutral-100'
                }`}
              >
                <MousePointer2 className="mr-2 h-4 w-4" />
                View & Inspect
              </button>
              <button
                onClick={() => setMode('edit-shared')}
                className={`flex w-full items-center rounded-md px-3 py-2 ${
                  mode === 'edit-shared'
                    ? 'bg-purple-50 font-medium text-purple-700'
                    : 'hover:bg-neutral-100'
                }`}
              >
                <Share2 className="mr-2 h-4 w-4" />
                Edit Shared Borders
              </button>
              <button
                onClick={() => {
                  setMode('edit-single');
                  setSelectedZoneId(null);
                }}
                className={`flex w-full items-center rounded-md px-3 py-2 ${
                  mode === 'edit-single'
                    ? 'bg-purple-50 font-medium text-purple-700'
                    : 'hover:bg-neutral-100'
                }`}
              >
                <Settings className="mr-2 h-4 w-4" />
                Edit Single Polygon
              </button>
              {mode === 'edit-single' ? (
                <div className="mt-1 rounded border border-neutral-100 bg-neutral-50 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="snapping"
                      className="text-sm font-medium text-neutral-600"
                    >
                      Snap to existing points
                    </label>
                    <input
                      type="checkbox"
                      id="snapping"
                      checked={snappingEnabled}
                      onChange={(event) => setSnappingEnabled(event.target.checked)}
                      className="h-4 w-4 rounded text-purple-600 focus:ring-purple-500"
                    />
                  </div>
                  <p className="mt-2 text-xs leading-5 text-neutral-500">
                    When editing a single polygon, click one vertex then click an
                    existing visible point to snap there. Turn it off for free
                    dragging with no snap checks.
                  </p>
                </div>
              ) : null}
            </div>
          )}

          {leftTab === 'basemap' && (
            <div>
              <div className="mb-6 space-y-2">
                {(Object.entries(BASEMAPS) as [BasemapMode, (typeof BASEMAPS)[BasemapMode]][]).map(
                  ([basemapId, basemap]) => (
                    <button
                      key={basemapId}
                      type="button"
                      onClick={() => setBasemapMode(basemapId)}
                      className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                        basemapMode === basemapId
                          ? 'border-purple-200 bg-purple-50 text-purple-700'
                          : 'border-neutral-100 bg-neutral-50 hover:bg-neutral-100'
                      }`}
                    >
                      <div className="text-sm font-medium">{basemap.label}</div>
                      <div className="mt-1 text-xs text-neutral-500">
                        {basemap.description}
                      </div>
                    </button>
                  ),
                )}
              </div>
            </div>
          )}

          {leftTab === 'datasets' && (
            <div>
              <div className="space-y-2">
                {datasets.map((dataset) => (
                  <div
                    key={dataset.id}
                    className="overflow-hidden rounded-lg border border-neutral-100 bg-neutral-50"
                  >
                    <div className="flex items-center justify-between bg-white p-3">
                      <div className="flex items-center space-x-2">
                        <div
                          className="h-3 w-3 rounded-full"
                          style={{ backgroundColor: dataset.color }}
                        />
                        <span className="text-sm font-medium">{dataset.name}</span>
                      </div>
                      <button
                        onClick={() => toggleDataset(dataset.id)}
                        className="rounded p-1 text-neutral-500 hover:bg-neutral-100"
                      >
                        {dataset.visible ? (
                          <Eye className="h-4 w-4" />
                        ) : (
                          <EyeOff className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                    {dataset.visible ? (
                      <div className="max-h-48 overflow-y-auto px-3 pb-3">
                        {dataset.id.startsWith('user-mahalas') ? (
                          <div className="mb-2">
                            <input
                              type="search"
                              value={mahalaSearch}
                              onChange={(e) => setMahalaSearch(e.target.value)}
                              placeholder="Search mahalas"
                              className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 outline-none"
                            />
                          </div>
                        ) : null}

                        {(dataset.id.startsWith('user-mahalas') && mahalaSearch.trim()
                          ? dataset.zones.filter((z) => z.name.toLowerCase().includes(mahalaSearch.trim().toLowerCase()))
                          : dataset.zones
                        ).map((zone) => (
                          <button
                            key={zone.id}
                            type="button"
                            onClick={() => {
                              setFocusedZone({
                                datasetId: dataset.id,
                                zoneId: zone.id,
                              });

                              if (
                                mode === 'edit-single' &&
                                dataset.id.startsWith('user-mahalas')
                              ) {
                                setSelectedZoneId(zone.id);
                              }
                            }}
                            className="flex w-full items-center justify-between rounded px-1 py-1 text-left text-xs transition hover:bg-neutral-100"
                          >
                            <div className="flex min-w-0 items-center gap-2 pr-2">
                              <span className="truncate">{zone.name}</span>
                              {dataset.id.startsWith('user-mahalas') &&
                              pendingZoneIdSet.has(zone.id) ? (
                                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                                  dirty
                                </span>
                              ) : null}
                            </div>
                            <span className="text-neutral-400">
                              {zone.coordinates.length} pts
                            </span>
                          </button>
                        ))}
                        {dataset.id.startsWith('user-mahalas') &&
                        loadState === 'loading' ? (
                          <div className="py-2 text-xs text-neutral-500">
                            Loading from database...
                          </div>
                        ) : null}
                        {dataset.id.startsWith('user-mahalas') &&
                        loadState === 'error' ? (
                          <div className="py-2 text-xs text-red-600">
                            {loadError}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {mode === 'draw' ? (
          <div className="border-t border-neutral-100 bg-purple-50 p-4">
            <p className="mb-3 text-sm text-purple-800">
              Click on the map to add points. It can snap to visible polygon
              vertices. Press Enter to finish.
            </p>
            <button
              onClick={handleFinishDraw}
              className="w-full rounded-md bg-purple-600 py-2 font-medium text-white shadow-sm transition hover:bg-purple-700"
            >
              Finish Polygon (Enter)
            </button>
          </div>
        ) : null}

        <div className="border-t border-neutral-100 bg-neutral-50 p-4">
          {pendingZones.length > 0 ? (
            <>
              <p className="mb-2 text-sm font-medium text-neutral-800">
                Unsaved changes: {pendingZones.length}
              </p>
              <p className="mb-3 text-xs leading-5 text-neutral-600">
                {pendingZoneNames.slice(0, 3).join(', ')}
                {pendingZoneNames.length > 3
                  ? ` +${pendingZoneNames.length - 3} more`
                  : ''}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => void savePendingChanges()}
                  disabled={saveState === 'saving'}
                  className="flex flex-1 items-center justify-center rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  <Save className="mr-2 h-4 w-4" />
                  {saveState === 'saving'
                    ? 'Saving...'
                    : getSaveLabel(pendingZones.length)}
                </button>
                <button
                  onClick={discardPendingChanges}
                  disabled={saveState === 'saving'}
                  className="flex items-center justify-center rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Reset
                </button>
              </div>
            </>
          ) : null}

          {saveMessage ? (
            <p
              className={`text-xs leading-5 ${
                saveState === 'error'
                  ? 'text-red-600'
                  : saveState === 'success'
                    ? 'text-emerald-700'
                    : 'text-neutral-600'
              } ${pendingZones.length > 0 ? 'mt-3' : ''}`}
            >
              {saveMessage}
            </p>
          ) : null}

          {loadState === 'error' ? (
            <button
              onClick={() => void loadMahalas()}
              className="mt-3 w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-100"
            >
              Retry Loading
            </button>
          ) : null}
        </div>
      </aside>

      <main className="relative h-full flex-1">
        <MapContainer
          center={DEFAULT_MAP_CENTER}
          zoom={12}
          className={`h-full w-full ${mode === 'draw' ? 'draw-mode-map' : ''}`}
          style={drawModeCursorStyle}
        >
          <TileLayer
            attribution={activeBasemap.attribution}
            url={activeBasemap.baseUrl}
          />
          {activeBasemap.labelsUrl ? (
            <TileLayer
              attribution={activeBasemap.labelsAttribution}
              url={activeBasemap.labelsUrl}
              opacity={1}
            />
          ) : null}
          <MapController
            onMapClick={handleMapClick}
            setMousePos={setMousePos}
            setCurrentZoom={setCurrentZoom}
            isDraw={mode === 'draw'}
            snappingEnabled={snappingEnabled}
            datasets={visibleDatasets}
            drawingCoords={drawingCoords}
          />
          <FocusedZoneController
            datasets={datasets}
            focusedZone={focusedZone}
            onFocusedZoneHandled={() => setFocusedZone(null)}
          />

          {datasets.map((dataset) => {
            if (!dataset.visible) {
              return null;
            }

            return dataset.zones.map((zone) => {
              const isSelected =
                dataset.id.startsWith('user-mahalas') &&
                mode === 'edit-single' &&
                selectedZoneId === zone.id;

              return (
                <Polygon
                  key={`${dataset.id}:${zone.id}`}
                  positions={zone.coordinates.map((coordinate) => [
                    coordinate.latitude,
                    coordinate.longitude,
                  ])}
                  pathOptions={{
                    color: isSelected ? '#ec4899' : dataset.color,
                    weight: isSelected ? 3 : 2,
                    fillColor: dataset.color,
                    fillOpacity: isSelected ? 0.3 : 0.1,
                  }}
                  eventHandlers={{
                    click: () => {
                      if (
                        mode === 'edit-single' &&
                        dataset.id.startsWith('user-mahalas')
                      ) {
                        setSelectedZoneId(zone.id);
                        return;
                      }

                      if (mode === 'view') {
                        setInspectZone(zone);
                        setInspectDraft(zone);
                      }
                    },
                  }}
                >
                  {zone.name ? (
                    currentZoom >=
                    (dataset.id === 'sarajevo'
                      ? SARAJEVO_POLYGON_LABEL_MIN_ZOOM
                      : zone.level === 1
                      ? USER_MAHALA_LEVEL_1_LABEL_MIN_ZOOM
                      : USER_MAHALA_LEVEL_2_LABEL_MIN_ZOOM) ? (
                      <Tooltip
                        permanent
                        direction="center"
                        className="rounded border-none bg-white/80 text-xs font-semibold shadow-sm"
                        opacity={0.9}
                        style={{
                          color: dataset.color,
                          border: `1px solid ${dataset.color}`,
                          fontSize:
                            dataset.id === 'sarajevo' || !dataset.id.startsWith('user-mahalas')
                              ? 12
                              : zone.level === 1
                              ? 8
                              : 6,
                          padding:
                            dataset.id.startsWith('user-mahalas')
                              ? zone.level === 1
                                ? '4px 6px'
                                : '3px 4px'
                              : '6px 10px',
                        }}
                      >
                        {zone.name}
                      </Tooltip>
                    ) : null
                  ) : null}
                </Polygon>
              );
            });
          })}

          {visibleDatasets.some((dataset) => dataset.id === 'sarajevo') &&
          currentZoom >= SARAJEVO_MIN_ZOOM &&
          currentZoom < SARAJEVO_POLYGON_LABEL_MIN_ZOOM ? (
            <Marker position={DEFAULT_MAP_CENTER}>
              <Tooltip
                permanent
                direction="center"
                className="rounded border-none bg-white/80 text-xs font-semibold shadow-sm"
                opacity={0.9}
                style={{
                  color: '#7c3aed',
                  border: '1px solid #7c3aed',
                  fontSize: 12,
                  padding: '6px 10px',
                }}
              >
                Sarajevo
              </Tooltip>
            </Marker>
          ) : null}

          {mode === 'draw' ? (
            <>
              {drawingCoords.length > 0 ? (
                <Polyline
                  positions={drawingCoords.map((coordinate) => [
                    coordinate.latitude,
                    coordinate.longitude,
                  ])}
                  pathOptions={{
                    color: '#ec4899',
                    weight: 3,
                    dashArray: '5, 5',
                  }}
                />
              ) : null}
              {drawingCoords.length > 0 && mousePos ? (
                <Polyline
                  positions={[
                    [
                      drawingCoords[drawingCoords.length - 1].latitude,
                      drawingCoords[drawingCoords.length - 1].longitude,
                    ],
                    [mousePos.latitude, mousePos.longitude],
                  ]}
                  pathOptions={{
                    color: '#ec4899',
                    weight: 2,
                    opacity: 0.85,
                    dashArray: '5, 5',
                  }}
                />
              ) : null}
              {mousePos ? (
                <Marker
                  position={[mousePos.latitude, mousePos.longitude]}
                  icon={globalCustomIcon}
                />
              ) : null}
              {mousePos &&
              snappingEnabled &&
              getClosestVertex(mousePos, visibleDatasets, drawingCoords) ? (
                <CircleMarker
                  center={[mousePos.latitude, mousePos.longitude]}
                  radius={6}
                  pathOptions={{
                    color: 'red',
                    fillColor: '#fca5a5',
                    fillOpacity: 0.7,
                  }}
                />
              ) : null}
              {drawingCoords.map((coordinate, index) => (
                <Marker
                  key={`${coordinate.latitude}:${coordinate.longitude}:${index}`}
                  position={[coordinate.latitude, coordinate.longitude]}
                  icon={globalCustomIcon}
                />
              ))}
            </>
          ) : null}

          {mode === 'draw' && snappingEnabled ? (
            <AllVertices
              datasets={visibleDatasets}
              drawingCoords={mode === 'draw' ? drawingCoords : []}
            />
          ) : null}

          {mode === 'edit-shared' && editableDatasetVisible ? (
            <SharedEditMarkers
              zones={mahalaZones}
              updateVertex={updateVertexShared}
              removeVertex={removeVertexShared}
              insertVertex={insertVertexShared}
            />
          ) : null}

          {mode === 'edit-single' &&
          editableDatasetVisible &&
          selectedZoneId ? (
            <SingleEditMarkers
              zones={mahalaZones}
              selectedZoneId={selectedZoneId}
              updateVertex={updateVertexSingle}
              removeVertex={removeVertexSingle}
              insertVertex={insertVertexSingle}
              snappingEnabled={snappingEnabled}
              snapDatasets={visibleDatasets}
            />
          ) : null}
        </MapContainer>
      </main>

      {inspectDraft ? (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-neutral-900/40 p-4 backdrop-blur-sm">
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-neutral-100 bg-neutral-50/50 px-5 py-4">
              <h3 className="text-lg font-semibold text-neutral-800">Polygon Details</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    // copy raw JSON
                    navigator.clipboard.writeText(JSON.stringify(inspectDraft, null, 2));
                  }}
                  className="rounded-md p-1 text-neutral-500 hover:bg-neutral-100"
                >
                  View Source
                </button>
                <button
                  onClick={() => {
                    setInspectZone(null);
                    setInspectDraft(null);
                  }}
                  className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-800"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="relative flex-grow overflow-auto bg-white p-6">
              <div className="space-y-4 max-w-2xl">
                <div>
                  <div className="text-xs text-neutral-500">Name</div>
                  <div className="mt-1 text-sm font-medium text-neutral-900">{inspectDraft.name}</div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <label className="block">
                    <div className="text-xs text-neutral-500">Owner ID</div>
                    <input
                      type="number"
                      value={inspectDraft.owner_id ?? ''}
                      onChange={(e) =>
                        setInspectDraft((prev) =>
                          prev ? { ...prev, owner_id: e.target.value ? Number(e.target.value) : null } : prev,
                        )
                      }
                      className="mt-1 w-full rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-900 outline-none"
                      placeholder="Owner ID"
                    />
                  </label>

                  <label className="block">
                    <div className="text-xs text-neutral-500">Privacy</div>
                    <select
                      value={inspectDraft.privacy ?? 0}
                      onChange={(e) =>
                        setInspectDraft((prev) => (prev ? { ...prev, privacy: Number(e.target.value) } : prev))
                      }
                      className="mt-1 w-full rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-900 outline-none"
                    >
                      <option value={0}>Public (0)</option>
                      <option value={1}>Private (1)</option>
                    </select>
                  </label>
                </div>

                <div>
                  <div className="text-xs text-neutral-500">Level</div>
                  <select
                    value={inspectDraft.level ?? 2}
                    onChange={(e) =>
                      setInspectDraft((prev) => (prev ? { ...prev, level: Number(e.target.value) } : prev))
                    }
                    className="mt-1 w-48 rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-900 outline-none"
                  >
                    <option value={1}>Level 1</option>
                    <option value={2}>Level 2</option>
                  </select>
                </div>

                <div>
                  <div className="text-xs text-neutral-500">Points</div>
                  <div className="mt-1 text-sm text-neutral-700">{inspectDraft.coordinates.length} points</div>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-neutral-100 bg-neutral-50/50 px-5 py-4">
              <div className="text-xs text-neutral-500">Tip: use Save to persist changes</div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setInspectZone(null);
                    setInspectDraft(null);
                  }}
                  className="rounded-lg border border-neutral-200 px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-100"
                >
                  Close
                </button>
                <button
                  onClick={async () => {
                    if (!inspectDraft) return;
                    try {
                      setSaveState('saving');
                      const response = await fetch(endpoints.bulkSaveMahalas, {
                        method: 'POST',
                        headers: {
                          Accept: 'application/json',
                          'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ mahalas: [inspectDraft] }),
                      });
                      const payload = await response.json().catch(() => null);
                      if (!response.ok) {
                        throw new Error(payload?.message || 'Failed to save mahala.');
                      }
                      // reload from DB
                      await loadMahalas();
                      setInspectZone(null);
                      setInspectDraft(null);
                      setSaveState('success');
                      setSaveMessage('Mahala saved.');
                      setTimeout(() => setSaveMessage(null), 3000);
                    } catch (err) {
                      setSaveState('error');
                      setSaveMessage(err instanceof Error ? err.message : 'Save failed.');
                    }
                  }}
                  className="rounded-lg bg-purple-600 px-5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-purple-700"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MapController({
  onMapClick,
  setMousePos,
  setCurrentZoom,
  isDraw,
  snappingEnabled,
  datasets,
  drawingCoords,
}: {
  onMapClick: (coordinate: Coordinate) => void;
  setMousePos: (coordinate: Coordinate | null) => void;
  setCurrentZoom: (zoom: number) => void;
  isDraw: boolean;
  snappingEnabled: boolean;
  datasets: Dataset[];
  drawingCoords: Coordinate[];
}) {
  const map = useMapEvents({
    click(event) {
      if (!isDraw) {
        return;
      }

      let nextCoordinate = {
        latitude: event.latlng.lat,
        longitude: event.latlng.lng,
      };

      if (snappingEnabled) {
        const snappedCoordinate = getClosestVertex(
          nextCoordinate,
          datasets,
          drawingCoords,
        );

        if (snappedCoordinate) {
          nextCoordinate = snappedCoordinate;
        }
      }

      onMapClick(nextCoordinate);
    },
    mousemove(event) {
      if (!isDraw) {
        return;
      }

      let nextCoordinate = {
        latitude: event.latlng.lat,
        longitude: event.latlng.lng,
      };

      if (snappingEnabled) {
        const snappedCoordinate = getClosestVertex(
          nextCoordinate,
          datasets,
          drawingCoords,
        );

        if (snappedCoordinate) {
          nextCoordinate = snappedCoordinate;
        }
      }

      setMousePos(nextCoordinate);
    },
  });

  useEffect(() => {
    setCurrentZoom(map.getZoom());
    const handleZoomEnd = () => setCurrentZoom(map.getZoom());
    map.on('zoomend', handleZoomEnd);
    return () => {
      map.off('zoomend', handleZoomEnd);
    };
  }, [map]);

  return null;
}

function FocusedZoneController({
  datasets,
  focusedZone,
  onFocusedZoneHandled,
}: {
  datasets: Dataset[];
  focusedZone: FocusedZone | null;
  onFocusedZoneHandled: () => void;
}) {
  const map = useMapEvents({});

  useEffect(() => {
    if (!focusedZone) {
      return;
    }

    const zone = datasets
      .find((dataset) => dataset.id === focusedZone.datasetId)
      ?.zones.find((candidate) => candidate.id === focusedZone.zoneId);

    if (!zone || zone.coordinates.length === 0) {
      onFocusedZoneHandled();
      return;
    }

    const bounds = L.latLngBounds(
      zone.coordinates.map((coordinate) => [
        coordinate.latitude,
        coordinate.longitude,
      ]),
    );

    if (!bounds.isValid()) {
      onFocusedZoneHandled();
      return;
    }

    map.fitBounds(bounds.pad(0.2), {
      maxZoom: 16,
      animate: true,
    });
    onFocusedZoneHandled();
  }, [datasets, focusedZone, map, onFocusedZoneHandled]);

  return null;
}

function getClosestVertex(
  coordinate: Coordinate,
  datasets: Dataset[],
  drawingCoords: Coordinate[] = [],
  threshold = 0.001,
  excludedCoordinates: Coordinate[] = [],
) {
  let closest: Coordinate | null = null;
  let minimumDistance = Infinity;
  const excludedKeys = new Set(excludedCoordinates.map(getCoordinateKey));

  const inspectCoordinate = (candidate: Coordinate) => {
    if (excludedKeys.has(getCoordinateKey(candidate))) {
      return;
    }

    const dx = candidate.longitude - coordinate.longitude;
    const dy = candidate.latitude - coordinate.latitude;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < minimumDistance && distance < threshold) {
      minimumDistance = distance;
      closest = candidate;
    }
  };

  datasets.forEach((dataset) => {
    if (!dataset.visible) {
      return;
    }

    dataset.zones.forEach((zone) => {
      zone.coordinates.forEach(inspectCoordinate);
    });
  });

  drawingCoords.forEach(inspectCoordinate);

  return closest;
}

function SharedEditMarkers({
  zones,
  updateVertex,
  removeVertex,
  insertVertex,
}: {
  zones: Zone[];
  updateVertex: (oldCoord: Coordinate, newCoord: Coordinate) => void;
  removeVertex: (coordinate: Coordinate) => void;
  insertVertex: (
    firstCoord: Coordinate,
    secondCoord: Coordinate,
    midpoint: Coordinate,
  ) => void;
}) {
  const { uniqueCoordinates, uniqueSegments } = useMemo(() => {
    const coordinatesMap = new Map<string, Coordinate>();
    const segmentsMap = new Map<
      string,
      { firstCoord: Coordinate; secondCoord: Coordinate; midpoint: Coordinate }
    >();

    zones.forEach((zone) => {
      zone.coordinates.forEach((coordinate, index) => {
        const coordinateKey = `${coordinate.latitude},${coordinate.longitude}`;

        if (!coordinatesMap.has(coordinateKey)) {
          coordinatesMap.set(coordinateKey, coordinate);
        }

        const nextCoordinate =
          zone.coordinates[(index + 1) % zone.coordinates.length];
        const nextKey = `${nextCoordinate.latitude},${nextCoordinate.longitude}`;
        const segmentKey =
          coordinateKey < nextKey
            ? `${coordinateKey}-${nextKey}`
            : `${nextKey}-${coordinateKey}`;

        if (!segmentsMap.has(segmentKey)) {
          segmentsMap.set(segmentKey, {
            firstCoord: coordinate,
            secondCoord: nextCoordinate,
            midpoint: {
              latitude: (coordinate.latitude + nextCoordinate.latitude) / 2,
              longitude: (coordinate.longitude + nextCoordinate.longitude) / 2,
            },
          });
        }
      });
    });

    return {
      uniqueCoordinates: Array.from(coordinatesMap.values()),
      uniqueSegments: Array.from(segmentsMap.values()),
    };
  }, [zones]);

  const customIcon = new L.Icon({
    iconUrl,
    shadowUrl,
    iconSize: [25, 41],
    iconAnchor: [12, 41],
  });

  return (
    <>
      {uniqueCoordinates.map((coordinate) => (
        <Fragment key={`coord-${coordinate.latitude},${coordinate.longitude}`}>
          <DraggableMarker
            coord={coordinate}
            onUpdate={(newCoordinate) =>
              updateVertex(coordinate, newCoordinate)
            }
            onDelete={() => removeVertex(coordinate)}
            icon={customIcon}
          />
        </Fragment>
      ))}
      {uniqueSegments.map((segment) => (
        <CircleMarker
          key={`seg-${segment.midpoint.latitude},${segment.midpoint.longitude}`}
          center={[segment.midpoint.latitude, segment.midpoint.longitude]}
          radius={5}
          pathOptions={{
            color: '#9333ea',
            fillColor: 'white',
            fillOpacity: 1,
            weight: 2,
          }}
          eventHandlers={{
            click: () =>
              insertVertex(
                segment.firstCoord,
                segment.secondCoord,
                segment.midpoint,
              ),
          }}
        />
      ))}
    </>
  );
}

function SingleEditMarkers({
  zones,
  selectedZoneId,
  updateVertex,
  removeVertex,
  insertVertex,
  snappingEnabled,
  snapDatasets,
}: {
  zones: Zone[];
  selectedZoneId: string;
  updateVertex: (zoneId: string, index: number, coordinate: Coordinate) => void;
  removeVertex: (zoneId: string, index: number) => void;
  insertVertex: (
    zoneId: string,
    insertIndex: number,
    coordinate: Coordinate,
  ) => void;
  snappingEnabled: boolean;
  snapDatasets: Dataset[];
}) {
  const customIcon = new L.Icon({
    iconUrl,
    shadowUrl,
    iconSize: [25, 41],
    iconAnchor: [12, 41],
  });
  const [selectedVertexIndex, setSelectedVertexIndex] = useState<number | null>(
    null,
  );

  const selectedZone = useMemo(
    () => zones.find((zone) => zone.id === selectedZoneId) ?? null,
    [zones, selectedZoneId],
  );
  const snapTargetCoordinates = useMemo(() => {
    if (!snappingEnabled) {
      return [];
    }

    const coordinatesMap = new Map<string, Coordinate>();

    snapDatasets.forEach((dataset) => {
      if (!dataset.visible) {
        return;
      }

      dataset.zones.forEach((zone) => {
        if (dataset.id.startsWith('user-mahalas') && zone.id === selectedZoneId) {
          return;
        }

        zone.coordinates.forEach((coordinate) => {
          const key = getCoordinateKey(coordinate);

          if (!coordinatesMap.has(key)) {
            coordinatesMap.set(key, coordinate);
          }
        });
      });
    });

    return Array.from(coordinatesMap.values());
  }, [selectedZoneId, snapDatasets, snappingEnabled]);

  useEffect(() => {
    setSelectedVertexIndex(null);
  }, [selectedZoneId, snappingEnabled]);

  if (!selectedZone) {
    return null;
  }

  return (
    <>
      {snappingEnabled && selectedVertexIndex !== null
        ? snapTargetCoordinates.map((coordinate) => (
            <CircleMarker
              key={`snap-target:${coordinate.latitude},${coordinate.longitude}`}
              center={[coordinate.latitude, coordinate.longitude]}
              radius={6}
              pathOptions={{
                color: '#f59e0b',
                fillColor: '#fff7ed',
                fillOpacity: 1,
                weight: 2,
              }}
              eventHandlers={{
                click: () => {
                  updateVertex(
                    selectedZone.id,
                    selectedVertexIndex,
                    cloneCoordinate(coordinate),
                  );
                  setSelectedVertexIndex(null);
                },
              }}
            />
          ))
        : null}
      {selectedZone.coordinates.map((coordinate, index) => {
        const nextIndex = (index + 1) % selectedZone.coordinates.length;
        const nextCoordinate = selectedZone.coordinates[nextIndex];
        const midpoint = {
          latitude: (coordinate.latitude + nextCoordinate.latitude) / 2,
          longitude: (coordinate.longitude + nextCoordinate.longitude) / 2,
        };

        return (
          <Fragment key={`${selectedZone.id}:vertex:${index}`}>
            {snappingEnabled ? (
              <>
                {selectedVertexIndex === index ? (
                  <CircleMarker
                    center={[coordinate.latitude, coordinate.longitude]}
                    radius={10}
                    pathOptions={{
                      color: '#f59e0b',
                      fillColor: '#fef3c7',
                      fillOpacity: 0.65,
                      weight: 3,
                    }}
                  />
                ) : null}
                <Marker
                  position={[coordinate.latitude, coordinate.longitude]}
                  icon={customIcon}
                  eventHandlers={{
                    click: () => {
                      setSelectedVertexIndex((current) =>
                        current === index ? null : index,
                      );
                    },
                    contextmenu: (event) => {
                      event.originalEvent.preventDefault();
                      removeVertex(selectedZone.id, index);
                      setSelectedVertexIndex((current) =>
                        current === index ? null : current,
                      );
                    },
                  }}
                />
              </>
            ) : (
              <DraggableMarker
                coord={coordinate}
                onUpdate={(newCoordinate) =>
                  updateVertex(selectedZone.id, index, newCoordinate)
                }
                onDelete={() => removeVertex(selectedZone.id, index)}
                icon={customIcon}
              />
            )}
            <CircleMarker
              center={[midpoint.latitude, midpoint.longitude]}
              radius={5}
              pathOptions={{
                color: '#9333ea',
                fillColor: 'white',
                fillOpacity: 1,
                weight: 2,
              }}
              eventHandlers={{
                click: () =>
                  insertVertex(selectedZone.id, index + 1, midpoint),
              }}
            />
          </Fragment>
        );
      })}
    </>
  );
}

function AllVertices({
  datasets,
  drawingCoords = [],
}: {
  datasets: Dataset[];
  drawingCoords?: Coordinate[];
}) {
  const uniqueCoordinates = useMemo(() => {
    const coordinatesMap = new Map<string, Coordinate>();

    datasets.forEach((dataset) => {
      if (!dataset.visible) {
        return;
      }

      dataset.zones.forEach((zone) => {
        zone.coordinates.forEach((coordinate) => {
          const key = `${coordinate.latitude},${coordinate.longitude}`;
          if (!coordinatesMap.has(key)) {
            coordinatesMap.set(key, coordinate);
          }
        });
      });
    });

    drawingCoords.forEach((coordinate) => {
      const key = `${coordinate.latitude},${coordinate.longitude}`;
      if (!coordinatesMap.has(key)) {
        coordinatesMap.set(key, coordinate);
      }
    });

    return Array.from(coordinatesMap.values());
  }, [datasets, drawingCoords]);

  return (
    <>
      {uniqueCoordinates.map((coordinate) => (
        <CircleMarker
          key={`${coordinate.latitude},${coordinate.longitude}`}
          interactive={false}
          center={[coordinate.latitude, coordinate.longitude]}
          radius={3}
          pathOptions={{
            color: '#888',
            weight: 1,
            fillOpacity: 0.5,
            stroke: false,
          }}
        />
      ))}
    </>
  );
}

function DraggableMarker({
  coord,
  onUpdate,
  onDelete,
  icon,
}: {
  coord: Coordinate;
  onUpdate: (coordinate: Coordinate) => void;
  onDelete?: () => void;
  icon: L.Icon;
}) {
  const markerRef = useRef<L.Marker>(null);

  const eventHandlers = useMemo(
    () => ({
      dragend() {
        const marker = markerRef.current;

        if (!marker) {
          return;
        }

        const position = marker.getLatLng();
        const nextCoordinate = {
          latitude: position.lat,
          longitude: position.lng,
        };

        onUpdate(nextCoordinate);
      },
      contextmenu(event) {
        event.originalEvent.preventDefault();
        onDelete?.();
      },
    }),
    [onDelete, onUpdate],
  );

  return (
    <Marker
      draggable
      eventHandlers={eventHandlers}
      position={[coord.latitude, coord.longitude]}
      ref={markerRef}
      icon={icon}
    />
  );
}
