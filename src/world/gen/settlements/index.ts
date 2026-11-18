import type { SettlementFactory, SettlementLayer, TerrainSampler } from '../WorldGenerator';
import { Settlements } from './layer';

/**
 * Roads, cities, bridges and the airfield of seeded worlds (see ./layer.ts). Everything is
 * deterministic from the TerrainSampler (seed + natural terrain) and computed lazily per area.
 */
export const createSettlements: SettlementFactory = (terrain: TerrainSampler): SettlementLayer => new Settlements(terrain);

export { Settlements, airfieldPavedAt, AIR_SPAWN_DISTANCE } from './layer';
export { cityBuildings, cityPavedAt, toCityLocal, DOWNTOWN, MIDTOWN } from './cityLayout';
export type { CityBuilding } from './cityLayout';
export { BRIDGE_CLEARANCE, DECK_THICKNESS, PARAPET_HEIGHT, ROAD_HALF_WIDTH, MACRO_CELL, STREET_PITCH, STREET_HALF_WIDTH } from './types';
export type { BridgeSpan, Pier, Road, RoadPiece } from './types';
