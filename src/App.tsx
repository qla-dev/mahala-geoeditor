import { useState, useMemo, useRef, useEffect, Fragment } from 'react';
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
  const [mahalaZones, setMahalaZones] = useState<Zone[]>([]);
  const [savedMahalaZones, setSavedMahalaZones] = useState<Zone[]>([]);
  const [datasetVisibility, setDatasetVisibility] = useState<
    Record<string, boolean>
  >({
    [EDITABLE_DATASET_ID]: true,
    sarajevo: false,
  });
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<
    'idle' | 'saving' | 'success' | 'error'
  >('idle');
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [mode, setMode] = useState<
    'view' | 'draw' | 'edit-shared' | 'edit-single'
  >('view');
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [snappingEnabled, setSnappingEnabled] = useState(true);
  const [zoneMetadata, setZoneMetadata] = useState<string | null>(null);
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
    () => [
      {
        id: EDITABLE_DATASET_ID,
        name: 'User Mahalas',
        visible: datasetVisibility[EDITABLE_DATASET_ID] ?? true,
        color: '#3b82f6',
        zones: mahalaZones,
      },
      {
        id: 'sarajevo',
        name: 'Sarajevo Polygons',
        visible: datasetVisibility.sarajevo ?? false,
        color: '#10b981',
        zones: SARAJEVO_POLYGONS as Zone[],
      },
    ],
    [datasetVisibility, mahalaZones],
  );

  const visibleDatasets = useMemo(
    () => datasets.filter((dataset) => dataset.visible),
    [datasets],
  );

  const editableDatasetVisible = datasetVisibility[EDITABLE_DATASET_ID] ?? true;

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
    void loadMahalas();
  }, []);

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
    if (mode !== 'draw') {
      return;
    }

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

  return (
    <div className="flex h-screen w-full overflow-hidden bg-neutral-50 font-sans text-neutral-900">
      <aside className="z-10 flex w-80 flex-col border-r border-neutral-200 bg-white shadow-sm">
        <div className="flex items-center space-x-2 border-b border-neutral-100 p-4">
          <Layers className="h-6 w-6 text-purple-600" />
          <h1 className="text-lg font-semibold tracking-tight">
            Mahala GeoEditor
          </h1>
        </div>

        <div className="flex-grow overflow-y-auto p-4">
          <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-neutral-400">
            Tools
          </h2>
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
              <div className="mt-1 flex items-center justify-between rounded border border-neutral-100 bg-neutral-50 px-3 py-1">
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
          </div>

          <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-neutral-400">
            Datasets
          </h2>
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
                    {dataset.zones.map((zone) => (
                      <div
                        key={zone.id}
                        className="flex items-center justify-between py-1 text-xs"
                      >
                        <div className="flex min-w-0 items-center gap-2 pr-2">
                          <span className="truncate">{zone.name}</span>
                          {dataset.id === EDITABLE_DATASET_ID &&
                          pendingZoneIdSet.has(zone.id) ? (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                              dirty
                            </span>
                          ) : null}
                        </div>
                        <span className="text-neutral-400">
                          {zone.coordinates.length} pts
                        </span>
                      </div>
                    ))}
                    {dataset.id === EDITABLE_DATASET_ID &&
                    loadState === 'loading' ? (
                      <div className="py-2 text-xs text-neutral-500">
                        Loading from database...
                      </div>
                    ) : null}
                    {dataset.id === EDITABLE_DATASET_ID &&
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

        {mode === 'draw' ? (
          <div className="border-t border-neutral-100 bg-purple-50 p-4">
            <p className="mb-3 text-sm text-purple-800">
              Click on the map to add points. It can snap to visible polygon
              vertices.
            </p>
            <button
              onClick={handleFinishDraw}
              className="w-full rounded-md bg-purple-600 py-2 font-medium text-white shadow-sm transition hover:bg-purple-700"
            >
              Finish Polygon
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
          className="h-full w-full"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          />
          <MapController
            onMapClick={handleMapClick}
            setMousePos={setMousePos}
            isDraw={mode === 'draw'}
            snappingEnabled={snappingEnabled}
            datasets={visibleDatasets}
            drawingCoords={drawingCoords}
          />

          {datasets.map((dataset) => {
            if (!dataset.visible) {
              return null;
            }

            return dataset.zones.map((zone) => {
              const isSelected =
                dataset.id === EDITABLE_DATASET_ID &&
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
                        dataset.id === EDITABLE_DATASET_ID
                      ) {
                        setSelectedZoneId(zone.id);
                        return;
                      }

                      if (mode === 'view') {
                        setZoneMetadata(generateMetadataCode(zone));
                      }
                    },
                  }}
                >
                  {zone.name ? (
                    <Tooltip
                      permanent
                      direction="center"
                      className="rounded border-none bg-white/80 px-2 py-1 text-xs font-semibold text-neutral-800 shadow-sm"
                      opacity={0.9}
                    >
                      {zone.name}
                    </Tooltip>
                  ) : null}
                </Polygon>
              );
            });
          })}

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
            <AllVertices datasets={visibleDatasets} drawingCoords={drawingCoords} />
          ) : null}

          {mode === 'edit-shared' && editableDatasetVisible ? (
            <SharedEditMarkers
              zones={mahalaZones}
              updateVertex={updateVertexShared}
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
              insertVertex={insertVertexSingle}
            />
          ) : null}
        </MapContainer>
      </main>

      {zoneMetadata ? (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-neutral-900/40 p-4 backdrop-blur-sm">
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-neutral-100 bg-neutral-50/50 px-5 py-4">
              <h3 className="text-lg font-semibold text-neutral-800">
                Polygon Metadata
              </h3>
              <button
                onClick={() => setZoneMetadata(null)}
                className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-800"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>
            <div className="relative flex-grow overflow-auto bg-neutral-900 p-0">
              <pre className="p-5 font-mono text-xs leading-relaxed text-green-400">
                {zoneMetadata}
              </pre>
            </div>
            <div className="flex justify-end border-t border-neutral-100 bg-neutral-50/50 px-5 py-4">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(zoneMetadata);
                }}
                className="rounded-lg bg-purple-600 px-5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-purple-700"
              >
                Copy Source Code
              </button>
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
  isDraw,
  snappingEnabled,
  datasets,
  drawingCoords,
}: {
  onMapClick: (coordinate: Coordinate) => void;
  setMousePos: (coordinate: Coordinate | null) => void;
  isDraw: boolean;
  snappingEnabled: boolean;
  datasets: Dataset[];
  drawingCoords: Coordinate[];
}) {
  useMapEvents({
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

  return null;
}

function getClosestVertex(
  coordinate: Coordinate,
  datasets: Dataset[],
  drawingCoords: Coordinate[] = [],
  threshold = 0.001,
) {
  let closest: Coordinate | null = null;
  let minimumDistance = Infinity;

  const inspectCoordinate = (candidate: Coordinate) => {
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
  insertVertex,
}: {
  zones: Zone[];
  updateVertex: (oldCoord: Coordinate, newCoord: Coordinate) => void;
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
  insertVertex,
}: {
  zones: Zone[];
  selectedZoneId: string;
  updateVertex: (zoneId: string, index: number, coordinate: Coordinate) => void;
  insertVertex: (
    zoneId: string,
    insertIndex: number,
    coordinate: Coordinate,
  ) => void;
}) {
  const customIcon = new L.Icon({
    iconUrl,
    shadowUrl,
    iconSize: [25, 41],
    iconAnchor: [12, 41],
  });

  const selectedZone = useMemo(
    () => zones.find((zone) => zone.id === selectedZoneId) ?? null,
    [zones, selectedZoneId],
  );

  if (!selectedZone) {
    return null;
  }

  return (
    <>
      {selectedZone.coordinates.map((coordinate, index) => {
        const nextIndex = (index + 1) % selectedZone.coordinates.length;
        const nextCoordinate = selectedZone.coordinates[nextIndex];
        const midpoint = {
          latitude: (coordinate.latitude + nextCoordinate.latitude) / 2,
          longitude: (coordinate.longitude + nextCoordinate.longitude) / 2,
        };

        return (
          <Fragment key={`${index}-${coordinate.latitude},${coordinate.longitude}`}>
            <DraggableMarker
              coord={coordinate}
              onUpdate={(newCoordinate) =>
                updateVertex(selectedZone.id, index, newCoordinate)
              }
              icon={customIcon}
            />
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
  icon,
}: {
  coord: Coordinate;
  onUpdate: (coordinate: Coordinate) => void;
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
        onUpdate({ latitude: position.lat, longitude: position.lng });
      },
    }),
    [onUpdate],
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
