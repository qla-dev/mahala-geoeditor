import { useState, useMemo, useRef, useEffect, Fragment } from 'react';
import { MapContainer, TileLayer, Polygon, Marker, Polyline, CircleMarker, Tooltip, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Layers, MousePointer2, Settings, Share2, Plus, Type, EyeOff, Eye } from 'lucide-react';
import { USER_MAHALAS } from './data/userMahalas';
import { SARAJEVO_POLYGONS } from './data/sarajevoPolygons';

// Fix leafet default icon issue
// @ts-ignore
import iconUrl from 'leaflet/dist/images/marker-icon.png';
// @ts-ignore
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png';
// @ts-ignore
import shadowUrl from 'leaflet/dist/images/marker-shadow.png';

const globalCustomIcon = new L.Icon({
  iconUrl: iconUrl,
  iconRetinaUrl: iconRetinaUrl,
  shadowUrl: shadowUrl,
  iconSize: [25, 41],
  iconAnchor: [12, 41]
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
  center?: Coordinate;
  coordinates: Coordinate[];
  holes?: any[];
};
type Dataset = {
  id: string;
  name: string;
  visible: boolean;
  color: string;
  zones: Zone[];
};

function getPolygonCenter(coordinates: Coordinate[]) {
  if (!coordinates || coordinates.length === 0) return { latitude: 0, longitude: 0 };
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const c of coordinates) {
    if (c.latitude < minLat) minLat = c.latitude;
    if (c.latitude > maxLat) maxLat = c.latitude;
    if (c.longitude < minLng) minLng = c.longitude;
    if (c.longitude > maxLng) maxLng = c.longitude;
  }
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
  };
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
${zone.coordinates.map(c => `      {
        latitude: ${c.latitude},
        longitude: ${c.longitude},
      }`).join(',\n')}
    ],
    holes: [],
  }
];`;
}

export default function App() {
  const [datasets, setDatasets] = useState<Dataset[]>(() => {
    let localZones: Zone[] = [];
    try {
      const stored = window.localStorage.getItem('mahala-geoeditor-localstorage');
      if (stored) {
        localZones = JSON.parse(stored);
      }
    } catch (e) {
      console.error(e);
    }
    
    return [
      {
        id: 'localstorage',
        name: 'Local Storage',
        visible: true,
        color: '#9333ea', // purple-600
        zones: localZones,
      },
      {
        id: 'mahalas',
        name: 'User Mahalas',
        visible: true,
        color: '#3b82f6',
        zones: USER_MAHALAS as any, // Cast to any because userMahalas JSON might not have exact string type array for holes
      },
      {
        id: 'sarajevo',
        name: 'Sarajevo Polygons',
        visible: false,
        color: '#10b981',
        zones: SARAJEVO_POLYGONS as any,
      },
    ];
  });

  // Save to localStorage when datasets change
  useEffect(() => {
    const localDs = datasets.find(ds => ds.id === 'localstorage');
    if (localDs) {
      window.localStorage.setItem('mahala-geoeditor-localstorage', JSON.stringify(localDs.zones));
    }
  }, [datasets]);

  const [mode, setMode] = useState<'view' | 'draw' | 'edit-shared' | 'edit-single'>('view');
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [snappingEnabled, setSnappingEnabled] = useState(true);
  const [zoneMetadata, setZoneMetadata] = useState<string | null>(null);
  
  // Drawing state
  const [drawingCoords, setDrawingCoords] = useState<Coordinate[]>([]);
  const [mousePos, setMousePos] = useState<Coordinate | null>(null);

  // Edit shared state
  // We don't necessarily need to store large maps in state, just derive them from datasets
  
  const handleMapClick = (latlng: Coordinate) => {
    if (mode === 'draw') {
      let newPoint = latlng;
      if (snappingEnabled) {
          const snapVertex = getClosestVertex(latlng, datasets);
          if (snapVertex) newPoint = snapVertex;
      }
      setDrawingCoords([...drawingCoords, newPoint]);
    }
  };

  const handleFinishDraw = () => {
    if (drawingCoords.length < 3) {
      alert("A polygon needs at least 3 points.");
      setDrawingCoords([]);
      return;
    }
    const name = window.prompt("Enter name for this polygon:");
    if (!name) {
      setDrawingCoords([]);
      return;
    }
    const center = getPolygonCenter(drawingCoords);
    const newZone: Zone = {
      id: `user-${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`,
      name,
      center,
      coordinates: drawingCoords,
      holes: [],
    };
    console.log("New Polygon Generated:", JSON.stringify(newZone, null, 2));
    
    setDatasets(prev => prev.map(ds => {
      if (ds.id === 'localstorage') {
        return { ...ds, zones: [...ds.zones, newZone] };
      }
      return ds;
    }));
    
    setZoneMetadata(generateMetadataCode(newZone));
    setDrawingCoords([]);
    setMode('view');
  };

  const toggleDataset = (id: string) => {
    setDatasets(prev => prev.map(ds => ds.id === id ? { ...ds, visible: !ds.visible } : ds));
  };

  const updateVertexShared = (oldCoord: Coordinate, newCoord: Coordinate) => {
    setDatasets(prev => {
      const updatedDatasets = prev.map(ds => {
        if (!ds.visible) return ds;
        return {
          ...ds,
          zones: ds.zones.map(z => ({
            ...z,
            coordinates: z.coordinates.map(c => 
              c.latitude === oldCoord.latitude && c.longitude === oldCoord.longitude ? newCoord : c
            )
          }))
        };
      });
      console.log("Updated Polygons after Shared Edit:");
      // Find what was updated to log
      updatedDatasets.forEach(ds => {
        ds.zones.forEach((z, i) => {
          const oldZone = prev.find(pds => pds.id === ds.id)?.zones[i];
          if (oldZone && JSON.stringify(oldZone.coordinates) !== JSON.stringify(z.coordinates)) {
            console.log(JSON.stringify(z, null, 2));
          }
        });
      });
      return updatedDatasets;
    });
  };

  const updateVertexSingle = (zoneId: string, idx: number, newCoord: Coordinate) => {
    setDatasets(prev => {
      const updatedDatasets = prev.map(ds => {
        if (!ds.visible) return ds;
        const hasZone = ds.zones.some(z => z.id === zoneId);
        if (!hasZone) return ds;
        
        return {
          ...ds,
          zones: ds.zones.map(z => {
            if (z.id !== zoneId) return z;
            const newCoords = [...z.coordinates];
            newCoords[idx] = newCoord;
            const newZ = { ...z, coordinates: newCoords };
            console.log(`Updated Single Polygon (ID: ${zoneId}):\n`, JSON.stringify(newZ, null, 2));
            return newZ;
          })
        };
      });
      return updatedDatasets;
    });
  };

  const insertVertexSingle = (zoneId: string, insertIdx: number, newCoord: Coordinate) => {
    setDatasets(prev => {
      const updatedDatasets = prev.map(ds => {
        if (!ds.visible) return ds;
        const hasZone = ds.zones.some(z => z.id === zoneId);
        if (!hasZone) return ds;
        
        return {
          ...ds,
          zones: ds.zones.map(z => {
            if (z.id !== zoneId) return z;
            const newCoords = [...z.coordinates];
            newCoords.splice(insertIdx, 0, newCoord);
            const newZ = { ...z, coordinates: newCoords };
            console.log(`Updated Single Polygon (ID: ${zoneId}):\n`, JSON.stringify(newZ, null, 2));
            return newZ;
          })
        };
      });
      return updatedDatasets;
    });
  };

  const insertVertexShared = (c1: Coordinate, c2: Coordinate, midCoord: Coordinate) => {
    setDatasets(prev => {
      return prev.map(ds => {
        if (!ds.visible) return ds;
        return {
          ...ds,
          zones: ds.zones.map(z => {
            let changed = false;
            const newCoords: Coordinate[] = [];
            for (let i = 0; i < z.coordinates.length; i++) {
              newCoords.push(z.coordinates[i]);
              const nextC = z.coordinates[(i + 1) % z.coordinates.length];
              const currC = z.coordinates[i];
              if ((currC.latitude === c1.latitude && currC.longitude === c1.longitude && nextC.latitude === c2.latitude && nextC.longitude === c2.longitude) ||
                  (currC.latitude === c2.latitude && currC.longitude === c2.longitude && nextC.latitude === c1.latitude && nextC.longitude === c1.longitude)) {
                 newCoords.push(midCoord);
                 changed = true;
              }
            }
            if (changed) {
              return { ...z, coordinates: newCoords };
            }
            return z;
          })
        };
      });
    });
  };

  return (
    <div className="flex h-screen w-full bg-neutral-50 overflow-hidden text-neutral-900 font-sans">
      {/* Sidebar */}
      <aside className="w-80 bg-white border-r border-neutral-200 flex flex-col shadow-sm z-10">
        <div className="p-4 border-b border-neutral-100 flex items-center space-x-2">
          <Layers className="text-purple-600 w-6 h-6" />
          <h1 className="font-semibold text-lg tracking-tight">Mahala GeoEditor</h1>
        </div>
        
        <div className="p-4 flex-grow overflow-y-auto">
          <h2 className="text-xs font-bold text-neutral-400 uppercase tracking-wider mb-3">Tools</h2>
          <div className="space-y-2 mb-6">
            <button 
              onClick={() => { setMode('draw'); setDrawingCoords([]); }}
              className={`w-full flex flex-col px-3 py-2 rounded-md ${mode === 'draw' ? 'bg-purple-50 text-purple-700' : 'hover:bg-neutral-100'}`}
            >
              <div className="flex items-center font-medium">
                <Plus className="w-4 h-4 mr-2" />
                Draw Mahala
              </div>
            </button>
            {mode === 'draw' && (
              <div className="flex items-center justify-between px-3 py-1 bg-neutral-50 rounded border border-neutral-100 mt-1">
                <label htmlFor="snapping" className="text-sm font-medium text-neutral-600">Snap to existing points</label>
                <input 
                  type="checkbox" 
                  id="snapping" 
                  checked={snappingEnabled} 
                  onChange={(e) => setSnappingEnabled(e.target.checked)} 
                  className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
                />
              </div>
            )}
            <button 
              onClick={() => setMode('view')}
              className={`w-full flex items-center px-3 py-2 rounded-md ${mode === 'view' ? 'bg-purple-50 text-purple-700 font-medium' : 'hover:bg-neutral-100'}`}
            >
              <MousePointer2 className="w-4 h-4 mr-2" />
              View & Inspect
            </button>
            <button 
              onClick={() => setMode('edit-shared')}
              className={`w-full flex items-center px-3 py-2 rounded-md ${mode === 'edit-shared' ? 'bg-purple-50 text-purple-700 font-medium' : 'hover:bg-neutral-100'}`}
            >
              <Share2 className="w-4 h-4 mr-2" />
              Edit Shared Borders
            </button>
            <button 
              onClick={() => { setMode('edit-single'); setSelectedZoneId(null); }}
              className={`w-full flex items-center px-3 py-2 rounded-md ${mode === 'edit-single' ? 'bg-purple-50 text-purple-700 font-medium' : 'hover:bg-neutral-100'}`}
            >
              <Settings className="w-4 h-4 mr-2" />
              Edit Single Polygon
            </button>
          </div>

          <h2 className="text-xs font-bold text-neutral-400 uppercase tracking-wider mb-3">Datasets</h2>
          <div className="space-y-2">
            {datasets.map(ds => (
              <div key={ds.id} className="border border-neutral-100 rounded-lg overflow-hidden bg-neutral-50">
                <div className="flex items-center justify-between p-3 bg-white">
                  <div className="flex items-center space-x-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: ds.color }} />
                    <span className="font-medium text-sm">{ds.name}</span>
                  </div>
                  <button onClick={() => toggleDataset(ds.id)} className="p-1 hover:bg-neutral-100 rounded text-neutral-500">
                     {ds.visible ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  </button>
                </div>
                {ds.visible && (
                  <div className="px-3 pb-3 max-h-48 overflow-y-auto">
                    {ds.zones.map(z => (
                      <div key={z.id} className="text-xs py-1 flex items-center justify-between">
                         <span className="truncate pr-2">{z.name}</span>
                         <span className="text-neutral-400">{z.coordinates.length} pts</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {mode === 'draw' && (
          <div className="p-4 border-t border-neutral-100 bg-purple-50">
            <p className="text-sm text-purple-800 mb-3">Click on the map to add points. It will automatically snap to nearby points on existing borders.</p>
            <button onClick={handleFinishDraw} className="w-full bg-purple-600 text-white font-medium py-2 rounded-md shadow-sm hover:bg-purple-700 transition">
               Finish Polygon
            </button>
          </div>
        )}
      </aside>

      {/* Map Area */}
      <main className="flex-1 relative h-full">
        <MapContainer center={[43.8563, 18.4131]} zoom={12} className="w-full h-full">
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          />
          <MapController 
            onMapClick={handleMapClick} 
            setMousePos={setMousePos} 
            isDraw={mode === 'draw'} 
            snappingEnabled={snappingEnabled}
            datasets={datasets}
            drawingCoords={drawingCoords}
          />

          {/* Render Datasets */}
          {datasets.map(ds => {
            if (!ds.visible) return null;
            return ds.zones.map(z => {
              const isSelected = mode === 'edit-single' && selectedZoneId === z.id;
              return (
              <Polygon 
                key={z.id}
                positions={z.coordinates.map(c => [c.latitude, c.longitude])}
                pathOptions={{ 
                  color: isSelected ? '#ec4899' : ds.color, 
                  weight: isSelected ? 3 : 2, 
                  fillColor: ds.color, 
                  fillOpacity: isSelected ? 0.3 : 0.1 
                }}
                eventHandlers={{
                  click: () => {
                    if (mode === 'edit-single') {
                      setSelectedZoneId(z.id);
                    } else if (mode === 'view') {
                      setZoneMetadata(generateMetadataCode(z));
                    }
                  }
                }}
              >
                {z.name && (
                  <Tooltip permanent direction="center" className="bg-white/80 border-none shadow-sm font-semibold text-neutral-800 text-xs px-2 py-1 rounded" opacity={0.9}>
                    {z.name}
                  </Tooltip>
                )}
              </Polygon>
            )});
          })}

          {/* Drawing Polyline */}
          {mode === 'draw' && (
            <>
              {drawingCoords.length > 0 && (
                <Polyline 
                  positions={drawingCoords.map(c => [c.latitude, c.longitude])} 
                  pathOptions={{ color: '#ec4899', weight: 3, dashArray: '5, 5' }} 
                />
              )}
              {mousePos && snappingEnabled && getClosestVertex(mousePos, datasets, drawingCoords) && (
                <CircleMarker center={[mousePos.latitude, mousePos.longitude]} radius={6} pathOptions={{ color: 'red', fillColor: '#fca5a5', fillOpacity: 0.7 }} />
              )}
              {drawingCoords.map((c, i) => (
                <Marker key={i} position={[c.latitude, c.longitude]} icon={globalCustomIcon} />
              ))}
            </>
          )}

          {mode === 'draw' && snappingEnabled && (
            <AllVertices datasets={datasets} drawingCoords={drawingCoords} />
          )}

          {/* Edit Shared Markers */}
          {mode === 'edit-shared' && (
            <SharedEditMarkers datasets={datasets} updateVertex={updateVertexShared} insertVertex={insertVertexShared} />
          )}

          {/* Edit Single Markers */}
          {mode === 'edit-single' && selectedZoneId && (
            <SingleEditMarkers datasets={datasets} selectedZoneId={selectedZoneId} updateVertex={updateVertexSingle} insertVertex={insertVertexSingle} />
          )}

        </MapContainer>
      </main>

      {/* Metadata Modal */}
      {zoneMetadata && (
        <div className="fixed inset-0 bg-neutral-900/40 z-[9999] flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
             <div className="flex justify-between items-center px-5 py-4 border-b border-neutral-100 bg-neutral-50/50">
               <h3 className="font-semibold text-neutral-800 text-lg">Polygon Metadata</h3>
               <button onClick={() => setZoneMetadata(null)} className="text-neutral-400 hover:text-neutral-800 p-1 rounded-md hover:bg-neutral-100 transition-colors">
                 <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
               </button>
             </div>
             <div className="p-0 flex-grow overflow-auto relative bg-neutral-900">
               <pre className="text-xs text-green-400 p-5 font-mono leading-relaxed">{zoneMetadata}</pre>
             </div>
             <div className="px-5 py-4 border-t border-neutral-100 flex justify-end bg-neutral-50/50">
               <button 
                 onClick={() => {
                   navigator.clipboard.writeText(zoneMetadata);
                 }}
                 className="bg-purple-600 text-white px-5 py-2 rounded-lg font-medium text-sm hover:bg-purple-700 transition-colors shadow-sm"
               >
                 Copy Source Code
               </button>
             </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MapController({ onMapClick, setMousePos, isDraw, snappingEnabled, datasets, drawingCoords }: any) {
  useMapEvents({
    click(e) {
      if (isDraw) {
        let latlng = { latitude: e.latlng.lat, longitude: e.latlng.lng };
        if (snappingEnabled) {
          const snap = getClosestVertex(latlng, datasets, drawingCoords);
          if (snap) latlng = snap;
        }
        onMapClick(latlng);
      }
    },
    mousemove(e) {
      if (isDraw) {
        let latlng = { latitude: e.latlng.lat, longitude: e.latlng.lng };
        if (snappingEnabled) {
          const snap = getClosestVertex(latlng, datasets, drawingCoords);
          if (snap) latlng = snap;
        }
        setMousePos(latlng);
      }
    }
  });
  return null;
}

function getClosestVertex(coord: Coordinate, datasets: Dataset[], drawingCoords: Coordinate[] = [], threshold = 0.001) {
  let closest: Coordinate | null = null;
  let minDistance = Infinity;

  const processPoint = (c: Coordinate) => {
    const dx = c.longitude - coord.longitude;
    const dy = c.latitude - coord.latitude;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < minDistance && dist < threshold) {
      minDistance = dist;
      closest = c;
    }
  };

  datasets.forEach(ds => {
    if (!ds.visible) return;
    ds.zones.forEach(z => {
      z.coordinates.forEach(processPoint);
    });
  });

  drawingCoords.forEach(processPoint);

  return closest;
}

function SharedEditMarkers({ datasets, updateVertex, insertVertex }: { datasets: Dataset[], updateVertex: (oldC: Coordinate, newC: Coordinate) => void, insertVertex: (c1: Coordinate, c2: Coordinate, newC: Coordinate) => void }) {
  // Collect all unique coordinates and unique segments
  const { uniqueCoords, uniqueSegments } = useMemo(() => {
    const coordsMap = new Map<string, Coordinate>();
    const segmentsMap = new Map<string, { c1: Coordinate, c2: Coordinate, mid: Coordinate }>();

    datasets.forEach(ds => {
      if (!ds.visible) return;
      ds.zones.forEach(z => {
        z.coordinates.forEach((c, idx) => {
          const key = `${c.latitude},${c.longitude}`;
          if (!coordsMap.has(key)) {
            coordsMap.set(key, c);
          }

          const nextC = z.coordinates[(idx + 1) % z.coordinates.length];
          const key1 = key;
          const key2 = `${nextC.latitude},${nextC.longitude}`;
          const segKey = key1 < key2 ? `${key1}-${key2}` : `${key2}-${key1}`;
          
          if (!segmentsMap.has(segKey)) {
            segmentsMap.set(segKey, {
              c1: c,
              c2: nextC,
              mid: {
                latitude: (c.latitude + nextC.latitude) / 2,
                longitude: (c.longitude + nextC.longitude) / 2
              }
            });
          }
        });
      });
    });
    return {
      uniqueCoords: Array.from(coordsMap.values()),
      uniqueSegments: Array.from(segmentsMap.values())
    };
  }, [datasets]);

  // Leaflet draggable marker icon
  const customIcon = new L.Icon({
    iconUrl: iconUrl,
    shadowUrl: shadowUrl,
    iconSize: [25, 41],
    iconAnchor: [12, 41]
  });

  return (
    <>
      {uniqueCoords.map(uc => (
        <DraggableMarker key={`coord-${uc.latitude},${uc.longitude}`} coord={uc} onUpdate={(newC) => updateVertex(uc, newC)} icon={customIcon} />
      ))}
      {uniqueSegments.map(seg => (
        <CircleMarker 
          key={`seg-${seg.mid.latitude},${seg.mid.longitude}`}
          center={[seg.mid.latitude, seg.mid.longitude]} 
          radius={5} 
          pathOptions={{ color: '#9333ea', fillColor: 'white', fillOpacity: 1, weight: 2 }}
          eventHandlers={{
            click: () => insertVertex(seg.c1, seg.c2, seg.mid)
          }}
        />
      ))}
    </>
  );
}

function SingleEditMarkers({ datasets, selectedZoneId, updateVertex, insertVertex }: { datasets: Dataset[], selectedZoneId: string, updateVertex: (zoneId: string, idx: number, newC: Coordinate) => void, insertVertex: (zoneId: string, idx: number, newC: Coordinate) => void }) {
  const customIcon = new L.Icon({
    iconUrl: iconUrl,
    shadowUrl: shadowUrl,
    iconSize: [25, 41],
    iconAnchor: [12, 41]
  });

  const selectedZone = useMemo(() => {
    for (const ds of datasets) {
      const zone = ds.zones.find(z => z.id === selectedZoneId);
      if (zone) return zone;
    }
    return null;
  }, [datasets, selectedZoneId]);

  if (!selectedZone) return null;

  return (
    <>
      {selectedZone.coordinates.map((coord, idx) => {
        const nextIdx = (idx + 1) % selectedZone.coordinates.length;
        const nextCoord = selectedZone.coordinates[nextIdx];
        const midCoord = {
           latitude: (coord.latitude + nextCoord.latitude) / 2,
           longitude: (coord.longitude + nextCoord.longitude) / 2
        };

        return (
          <Fragment key={`${idx}-${coord.latitude},${coord.longitude}`}>
            <DraggableMarker coord={coord} onUpdate={(newC: Coordinate) => updateVertex(selectedZone.id, idx, newC)} icon={customIcon} />
            <CircleMarker 
              center={[midCoord.latitude, midCoord.longitude]} 
              radius={5} 
              pathOptions={{ color: '#9333ea', fillColor: 'white', fillOpacity: 1, weight: 2 }}
              eventHandlers={{
                click: () => insertVertex(selectedZone.id, idx + 1, midCoord)
              }}
            />
          </Fragment>
        );
      })}
    </>
  );
}

function AllVertices({ datasets, drawingCoords }: { datasets: Dataset[], drawingCoords?: Coordinate[] }) {
  const uniqueCoords = useMemo(() => {
    const map = new Map<string, Coordinate>();
    datasets.forEach(ds => {
      if (!ds.visible) return;
      ds.zones.forEach(z => {
        z.coordinates.forEach(c => {
          const key = `${c.latitude},${c.longitude}`;
          if (!map.has(key)) map.set(key, c);
        });
      });
    });
    if (drawingCoords) {
      drawingCoords.forEach(c => {
        const key = `${c.latitude},${c.longitude}`;
        if (!map.has(key)) map.set(key, c);
      });
    }
    return Array.from(map.values());
  }, [datasets, drawingCoords]);

  return (
    <>
      {uniqueCoords.map(uc => (
        <CircleMarker key={`${uc.latitude},${uc.longitude}`} center={[uc.latitude, uc.longitude]} radius={3} pathOptions={{ color: '#888', weight: 1, fillOpacity: 0.5, stroke: false }} />
      ))}
    </>
  );
}

function DraggableMarker({ coord, onUpdate, icon }: any) {
  const markerRef = useRef<L.Marker>(null);
  
  const eventHandlers = useMemo(
    () => ({
      dragend() {
        const marker = markerRef.current;
        if (marker != null) {
          const pos = marker.getLatLng();
          onUpdate({ latitude: pos.lat, longitude: pos.lng });
        }
      },
    }),
    [onUpdate]
  );

  return (
    <Marker
      draggable={true}
      eventHandlers={eventHandlers}
      position={[coord.latitude, coord.longitude]}
      ref={markerRef}
      icon={icon}
    />
  );
}
