import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from '@react-three/drei/node_modules/three-mesh-bvh';
import { calculateSmartPlacementV2 } from '../../PlacementLogic/Pathfinding/SmartPlacementV2';
import { setSettings } from '../../Settings/state';
import { SDFCache } from '../../PlacementLogic/Pathfinding/SDFCache';
import { MultichannelFlowField } from '../../PlacementLogic/Pathfinding/MultichannelFlowField';
import { FlowFieldTracer } from '../../PlacementLogic/Pathfinding/FlowFieldTracer';
import type {
    SupportPlacementWorkerMessage,
    CalculatePlacementResponseMessage,
} from './supportPlacement.worker.shared';

// Initialize BVH on prototype
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

interface ModelCache {
    mesh: THREE.Mesh;
    geometry: THREE.BufferGeometry;
    sdf: SDFCache;
    flowField?: MultichannelFlowField;
}

const modelCaches = new Map<string, ModelCache>();

self.onmessage = (event: MessageEvent<SupportPlacementWorkerMessage>) => {
    const msg = event.data;
    if (!msg) return;

    if (msg.type === 'init_mesh') {
        try {
            // Clean up previous cached model of same ID
            const prev = modelCaches.get(msg.modelId);
            if (prev) {
                prev.geometry.dispose();
                (prev.geometry as any).disposeBoundsTree?.();
                modelCaches.delete(msg.modelId);
            }

            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(msg.positions, 3));
            if (msg.indices) {
                geometry.setIndex(new THREE.BufferAttribute(msg.indices, 1));
            }
            
            // Build BVH inside worker
            geometry.computeBoundsTree();

            const mesh = new THREE.Mesh(geometry);
            mesh.matrixWorld.fromArray(msg.matrix);
            mesh.updateMatrixWorld(true);

            const sdf = new SDFCache(mesh, { cellSize: 0.25 });
            
            modelCaches.set(msg.modelId, { mesh, geometry, sdf });
            console.log(`[SupportPlacementWorker] Cached model ${msg.modelId}`);
        } catch (error) {
            console.error('[SupportPlacementWorker] Failed to init mesh:', error);
        }
    } else if (msg.type === 'init_flow_field') {
        const cache = modelCaches.get(msg.modelId);
        if (cache) {
            try {
                if (!cache.flowField) {
                    cache.flowField = new MultichannelFlowField(cache.mesh, cache.sdf);
                    console.log(`[SupportPlacementWorker] Cached flow field for model ${msg.modelId}`);
                }
            } catch (error) {
                console.error('[SupportPlacementWorker] Failed to init flow field:', error);
            }
        } else {
            console.error(`[SupportPlacementWorker] No model cached for ID ${msg.modelId}, cannot build flow field`);
        }
    } else if (msg.type === 'calculate_placement') {
        const { requestId, tipPos, tipNormal, tipProfile, rootsTopZ, settings, isPreview, useFlowField } = msg;

        const cancelView = msg.cancelSignal ? new Int32Array(msg.cancelSignal) : null;
        const expectedEpoch = msg.cancelEpoch ?? 0;
        const shouldAbort = cancelView && typeof Atomics !== 'undefined'
            ? () => Atomics.load(cancelView, 0) !== expectedEpoch
            : undefined;

        if (shouldAbort?.()) return;

        // Find cached mesh for the search
        let modelCache: ModelCache | undefined = undefined;
        if (msg.modelId) {
            modelCache = modelCaches.get(msg.modelId);
        }
        if (!modelCache) {
            for (const cache of modelCaches.values()) {
                modelCache = cache;
                break;
            }
        }

        if (!modelCache) {
            console.error('[SupportPlacementWorker] No mesh cached, cannot calculate placement');
            return;
        }

        try {
            // Update settings inside worker context
            setSettings(settings);

            if (shouldAbort?.()) return;

            if (useFlowField && modelCache.flowField) {
                // Compute nominal socket position (without collision shifts)
                const effectiveConeAxis = tipNormal;
                const diskThickness = tipProfile.type === 'disk' ? (settings.tip.diskThicknessMm ?? 0.1) : 0;
                const coneStartPos = {
                    x: tipPos.x + tipNormal.x * diskThickness,
                    y: tipPos.y + tipNormal.y * diskThickness,
                    z: tipPos.z + tipNormal.z * diskThickness,
                };
                const socketPos = {
                    x: coneStartPos.x + effectiveConeAxis.x * tipProfile.lengthMm,
                    y: coneStartPos.y + effectiveConeAxis.y * tipProfile.lengthMm,
                    z: coneStartPos.z + effectiveConeAxis.z * tipProfile.lengthMm,
                };

                const radius = settings.shaft.diameterMm / 2;
                const trace = FlowFieldTracer.traceSupportPath(
                    socketPos.x, socketPos.y, socketPos.z,
                    radius,
                    modelCache.flowField,
                    rootsTopZ
                );

                if (shouldAbort?.()) return;

                const response: CalculatePlacementResponseMessage = {
                    type: 'calculate_placement_response',
                    requestId,
                    result: {
                        basePos: trace.basePos,
                        socketPos: socketPos,
                        unsnappedBottomPos: trace.basePos,
                        joints: trace.joints,
                        constructionJoints: [],
                        error: trace.error ? 'COLLISION_WITH_MODEL' as any : undefined,
                        angle: 180,
                        coneAxis: tipNormal,
                    },
                };

                self.postMessage(response);
                return;
            }

            // Fallback to standard SmartPlacementV2
            const result = calculateSmartPlacementV2(
                {
                    tipPos,
                    tipNormal,
                    tipProfile,
                    rootsTopZ,
                    mesh: modelCache.mesh,
                    modelId: 'worker-model',
                },
                {
                    isPreview: isPreview,
                    maxExpansions: isPreview ? 800 : undefined,
                }
            );

            if (shouldAbort?.()) return;

            const response: CalculatePlacementResponseMessage = {
                type: 'calculate_placement_response',
                requestId,
                result: {
                    basePos: result.basePos,
                    socketPos: result.socketPos,
                    unsnappedBottomPos: result.unsnappedBottomPos,
                    snappedNodeKey: result.snappedNodeKey,
                    joints: result.joints,
                    constructionJoints: result.constructionJoints,
                    error: result.error,
                    warning: result.warning,
                    angle: result.angle,
                    coneAxis: result.coneAxis,
                    stagnated: result.stagnated,
                    exhaustedBudget: result.exhaustedBudget,
                },
            };

            self.postMessage(response);
        } catch (error) {
            console.error('[SupportPlacementWorker] Placement calculation failed:', error);
        }
    }
};

self.onerror = () => {
    console.error('[SupportPlacementWorker] Uncaught error in worker thread');
};
