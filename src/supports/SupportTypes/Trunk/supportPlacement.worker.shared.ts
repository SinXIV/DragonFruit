import type { Vec3, LimitationCode } from '../../types';
import type { SupportTipProfile } from '../../SupportPrimitives/ContactCone/types';
import type { TrunkPlacementResult } from '../../PlacementLogic/StandardPlacement';

export interface InitMeshMessage {
    type: 'init_mesh';
    modelId: string;
    positions: Float32Array;
    indices: Uint32Array | Uint16Array | null;
    matrix: number[]; // Flat array of 16 elements (matrixWorld)
}

export interface CalculatePlacementRequestMessage {
    type: 'calculate_placement';
    requestId: number;
    tipPos: Vec3;
    tipNormal: Vec3;
    tipProfile: SupportTipProfile;
    rootsTopZ: number;
    settings: any; // Serialized support settings
    isPreview?: boolean;
    cancelSignal?: SharedArrayBuffer;
    cancelEpoch?: number;
}

export interface CalculatePlacementResponseMessage {
    type: 'calculate_placement_response';
    requestId: number;
    result: TrunkPlacementResult & {
        stagnated?: boolean;
        exhaustedBudget?: boolean;
    };
}

export type SupportPlacementWorkerMessage =
    | InitMeshMessage
    | CalculatePlacementRequestMessage;
