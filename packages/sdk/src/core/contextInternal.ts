/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */
import {
	ActionEvent,
	Actor,
	ActorLike,
	Animation,
	AnimationLike,
	AnimationWrapMode,
	Asset,
	AssetContainer,
	AssetContainerIterable,
	AssetLike,
	BehaviorType,
	CollisionEvent,
	CollisionLayer,
	Context,
	CreateAnimationOptions,
	Guid,
	log,
	MediaCommand,
	MediaInstance,
	newGuid,
	PerformanceStats,
	SetAnimationStateOptions,
	SetMediaStateOptions,
	TriggerEvent,
	User,
	UserLike,
	ZeroGuid,
} from '..';
import {
	ExportedPromise,
	OperatingModel,
	Patchable,
	Payloads,
	Protocols,
	resolveJsonValues,
	safeAccessPath as safeGet,
} from '../internal';

/**
 * @hidden
 */
export class ContextInternal {
	public actorSet = new Map<Guid, Actor>();
	public userSet = new Map<Guid, User>();
	public userGroupMapping: { [id: string]: number } = { default: 1 };
	public assetContainers = new Set<AssetContainer>();
	public animationSet: Map<Guid, Animation> = new Map<Guid, Animation>();
	public protocol: Protocols.Protocol;
	public interval: NodeJS.Timer;
	public generation = 0;
	public prevGeneration = 0;
	public __rpc: any;

	constructor(public context: Context) {
		// Handle connection close events.
		this.onClose = this.onClose.bind(this);
		this.context.conn.on('close', this.onClose);
	}

	public Create(options?: {
		actor?: Partial<ActorLike>;
	}): Actor {
		return this.createActorFromPayload({
			...options,
			actor: {
				...(options && options.actor),
				id: newGuid()
			},
			type: 'create-empty'
		} as Payloads.CreateEmpty);
	}

	public CreateFromLibrary(options: {
		resourceId: string;
		actor?: Partial<ActorLike>;
	}): Actor {
		return this.createActorFromPayload({
			...options,
			actor: {
				...(options && options.actor),
				id: newGuid()
			},
			type: 'create-from-library'
		} as Payloads.CreateFromLibrary);
	}

	public CreateFromPrefab(options: {
		prefabId: Guid;
		collisionLayer?: CollisionLayer;
		actor?: Partial<ActorLike>;
	}): Actor {
		return this.createActorFromPayload({
			...options,
			actor: {
				...(options && options.actor),
				id: newGuid()
			},
			type: 'create-from-prefab'
		} as Payloads.CreateFromPrefab);
	}

	private createActorFromPayload(
		payload: Payloads.CreateActorCommon
	): Actor {
		// Resolve by-reference values now, ensuring they won't change in the
		// time between now and when this message is actually sent.
		payload.actor = Actor.sanitize(payload.actor);
		// Create the actor locally.
		this.updateActors(payload.actor);
		// Get a reference to the new actor.
		const actor = this.context.actor(payload.actor.id);

		this.protocol.sendPayload( payload, {
			resolve: (replyPayload: Payloads.ObjectSpawned | Payloads.OperationResult) => {
				this.protocol.recvPayload(replyPayload);
				let success: boolean;
				let message: string;
				if (replyPayload.type === 'operation-result') {
					success = replyPayload.resultCode !== 'error';
					message = replyPayload.message;
				} else {
					success = replyPayload.result.resultCode !== 'error';
					message = replyPayload.result.message;

					for (const createdAnimLike of replyPayload.animations) {
						if (!this.animationSet.has(createdAnimLike.id)) {
							const createdAnim = new Animation(this.context, createdAnimLike.id);
							createdAnim.copy(createdAnimLike);
							this.animationSet.set(createdAnimLike.id, createdAnim);
						}
					}

					for (const createdActorLike of replyPayload.actors) {
						const createdActor = this.actorSet.get(createdActorLike.id);
						if (createdActor) {
							createdActor.internal.notifyCreated(success, replyPayload.result.message);
						}
					}
				}

				if (success) {
					if (!actor.collider && actor.internal.behavior) {
						log.warning('app', 'Behaviors will not function on Unity host apps without adding a'
							+ ' collider to this actor first. Recommend adding a primitive collider'
							+ ' to this actor.');
					}
					actor.internal.notifyCreated(true);
				} else {
					actor.internal.notifyCreated(false, message);
				}
			},
			reject: (reason?: any) => {
				actor.internal.notifyCreated(false, reason);
			}
		});

		return actor;
	}

	public CreateFromGltf(container: AssetContainer, options: {
		uri: string;
		colliderType?: 'box' | 'mesh';
		actor?: Partial<ActorLike>;
	}): Actor {
		// create actor locally
		options.actor = Actor.sanitize({ ...options.actor, id: newGuid() });
		this.updateActors(options.actor);
		const actor = this.context.actor(options.actor.id);

		// reserve actor so the pending actor is ready for commands
		this.protocol.sendPayload({
			type: 'x-reserve-actor',
			actor: options.actor
		} as Payloads.XReserveActor);

		// kick off asset loading
		container.loadGltf(options.uri, options.colliderType)
		.then(assets => {
			if (!this.context.actor(actor.id)) {
				// actor was destroyed, stop loading
				return;
			}

			// once assets are done, find first prefab...
			const prefab = assets.find(a => !!a.prefab);
			if (!prefab) {
				actor.internal.notifyCreated(false, `glTF contains no prefabs: ${options.uri}`);
				return;
			}

			// ...and spawn it
			this.createActorFromPayload({
				type: 'create-from-prefab',
				prefabId: prefab.id,
				actor: options.actor
			} as Payloads.CreateFromPrefab);
		})
		.catch(reason => actor.internal.notifyCreated(false, reason));

		return actor;
	}

	public createAnimation(actorId: Guid, animationName: string, options: CreateAnimationOptions) {
		const actor = this.actorSet.get(actorId);
		if (!actor) {
			log.error('app', `Failed to create animation on ${animationName}. Actor ${actorId} not found.`);
		}
		options = {
			wrapMode: AnimationWrapMode.Once,
			...options
		};

		// Transform animations must be specified in local space
		for (const frame of options.keyframes) {
			if (frame.value.transform && !safeGet(frame.value, 'transform', 'local')) {
				throw new Error("Transform animations must be specified in local space");
			}
		}

		// generate the anim immediately
		const createdAnim = new Animation(this.context, newGuid());
		createdAnim.copy({
			name: animationName,
			targetActorIds: [actorId],
			weight: options.initialState?.enabled === true ? 1 : 0,
			speed: options.initialState?.speed,
			time: options.initialState?.time
		});
		this.animationSet.set(createdAnim.id, createdAnim);

		// Resolve by-reference values now, ensuring they won't change in the
		// time between now and when this message is actually sent.
		options.keyframes = resolveJsonValues(options.keyframes);
		return new Promise<Animation>((resolve, reject) => {
			this.protocol.sendPayload({
				type: 'create-animation',
				actorId,
				animationName,
				animationId: createdAnim.id.toString(),
				...options
			} as Payloads.CreateAnimation,
			{
				resolve: (reply: Payloads.ObjectSpawned) => {
					if (reply.result.resultCode !== 'error') {
						createdAnim.copy(reply.animations[0]);
						resolve(createdAnim);
					} else {
						reject(reply.result.message);
					}
				},
				reject
			});
		});
	}

	public setAnimationState(
		actorId: Guid,
		animationName: string,
		state: SetAnimationStateOptions
	) {
		const actor = this.actorSet.get(actorId);
		if (!actor) {
			log.error('app', `Failed to set animation state on "${animationName}". Actor "${actorId}" not found.`);
			return;
		}
		const anim = actor.animationsByName.get(animationName);
		if (!anim) {
			log.error('app', `Failed to set animation state on "${animationName}". ` +
				`No animation with this name was found on actor "${actorId}" (${actor.name}).`);
			return;
		}
		if (state.enabled !== undefined) {
			anim.isPlaying = state.enabled;
		}
		if (state.speed !== undefined) {
			anim.speed = state.speed;
		}
		if (state.time !== undefined) {
			anim.time = state.time;
		}
	}

	public setMediaState(
		mediaInstance: MediaInstance,
		command: MediaCommand,
		options?: SetMediaStateOptions,
		mediaAssetId?: Guid,
	) {
		this.protocol.sendPayload({
			type: 'set-media-state',
			id: mediaInstance.id,
			actorId: mediaInstance.actor.id,
			mediaAssetId,
			mediaCommand: command,
			options
		} as Payloads.SetMediaState);
	}

	public animateTo(
		actorId: Guid,
		value: Partial<ActorLike>,
		duration: number,
		curve: number[],
	) {
		const actor = this.actorSet.get(actorId);
		if (!actor) {
			log.error('app', `Failed animateTo. Actor ${actorId} not found.`);
		} else if (!Array.isArray(curve) || curve.length !== 4) {
			log.error('app', '`curve` parameter must be an array of four numbers. ' +
				'Try passing one of the predefined curves from `AnimationEaseCurves`');
		} else {
			this.protocol.sendPayload({
				type: 'interpolate-actor',
				actorId,
				animationName: newGuid().toString(),
				value,
				duration,
				curve,
				enabled: true
			} as Payloads.InterpolateActor);
		}
	}

	public async startListening() {
		try {
			// Startup the handshake protocol.
			const handshake = this.protocol =
				new Protocols.Handshake(this.context.conn, this.context.sessionId, OperatingModel.ServerAuthoritative);
			await handshake.run();

			// Switch to execution protocol.
			const execution = this.protocol = new Protocols.Execution(this.context);

			execution.on('protocol.update-actors', this.updateActors.bind(this));
			execution.on('protocol.destroy-actors', this.localDestroyActors.bind(this));
			execution.on('protocol.user-joined', this.userJoined.bind(this));
			execution.on('protocol.user-left', this.userLeft.bind(this));
			execution.on('protocol.update-user', this.updateUser.bind(this));
			execution.on('protocol.perform-action', this.performAction.bind(this));
			execution.on('protocol.receive-rpc', this.receiveRPC.bind(this));
			execution.on('protocol.collision-event-raised', this.collisionEventRaised.bind(this));
			execution.on('protocol.trigger-event-raised', this.triggerEventRaised.bind(this));
			execution.on('protocol.set-animation-state', this.setAnimationStateEventRaised.bind(this));
			execution.on('protocol.update-animations', this.updateAnimations.bind(this));

			// Startup the execution protocol
			execution.startListening();
		} catch (e) {
			log.error('app', e);
		}
	}

	public start() {
		if (!this.interval) {
			this.interval = setInterval(() => this.update(), 0);
			this.context.emitter.emit('started');
		}
	}

	public stop() {
		try {
			if (this.interval) {
				this.protocol.stopListening();
				clearInterval(this.interval);
				this.interval = undefined;
				this.context.emitter.emit('stopped');
				this.context.emitter.removeAllListeners();
			}
		} catch { }
	}

	public incrementGeneration() {
		this.generation++;
	}

	private assetsIterable() {
		return new AssetContainerIterable([...this.assetContainers]);
	}

	public update() {
		// Early out if no state changes occurred.
		if (this.generation === this.prevGeneration) {
			return;
		}

		this.prevGeneration = this.generation;

		const syncObjects = [
			...this.actorSet.values(),
			...this.assetsIterable(),
			...this.userSet.values(),
			...this.animationSet.values()
		] as Array<Patchable<any>>;

		for (const patchable of syncObjects) {
			const patch = patchable.internal.getPatchAndReset();
			if (!patch) {
				continue;
			}

			if (patchable instanceof Actor) {
				this.protocol.sendPayload({
					type: 'actor-update',
					actor: patch as ActorLike
				} as Payloads.ActorUpdate);
			} else if (patchable instanceof Animation) {
				this.protocol.sendPayload({
					type: 'animation-update',
					animation: patch as Partial<AnimationLike>
				} as Payloads.AnimationUpdate)
			} else if (patchable instanceof Asset) {
				this.protocol.sendPayload({
					type: 'asset-update',
					asset: patch as AssetLike
				} as Payloads.AssetUpdate);
			} else if (patchable instanceof User) {
				this.protocol.sendPayload({
					type: 'user-update',
					user: patch as UserLike
				} as Payloads.UserUpdate);
			}
		}

		if (this.nextUpdatePromise) {
			this.resolveNextUpdatePromise();
			this.nextUpdatePromise = null;
			this.resolveNextUpdatePromise = null;
		}
	}

	private nextUpdatePromise: Promise<void>;
	private resolveNextUpdatePromise: () => void;
	/** @hidden */
	public nextUpdate(): Promise<void> {
		if (this.nextUpdatePromise) {
			return this.nextUpdatePromise;
		}

		return this.nextUpdatePromise = new Promise(resolve => {
			this.resolveNextUpdatePromise = resolve;
		});
	}

	public sendDestroyActors(actorIds: Guid[]) {
		if (actorIds.length) {
			this.protocol.sendPayload({
				type: 'destroy-actors',
				actorIds,
			} as Payloads.DestroyActors);
		}
	}

	public updateActors(sactors: Partial<ActorLike> | Array<Partial<ActorLike>>) {
		if (!sactors) {
			return;
		}
		if (!Array.isArray(sactors)) {
			sactors = [sactors];
		}
		const newActorIds: Guid[] = [];
		// Instantiate and store each actor.
		sactors.forEach(sactor => {
			const isNewActor = !this.actorSet.get(sactor.id);
			const actor = isNewActor ? Actor.alloc(this.context, sactor.id) : this.actorSet.get(sactor.id);
			this.actorSet.set(sactor.id, actor);
			actor.copy(sactor);
			if (isNewActor) {
				newActorIds.push(actor.id);
			}
		});
		newActorIds.forEach(actorId => {
			const actor = this.actorSet.get(actorId);
			this.context.emitter.emit('actor-created', actor);
		});
	}

	public updateAnimations(animPatches: Array<Partial<AnimationLike>>) {
		if (!animPatches) { return; }
		const newAnims: Animation[] = [];
		for (const patch of animPatches) {
			if (this.animationSet.has(patch.id)) { continue; }
			const newAnim = new Animation(this.context, patch.id);
			this.animationSet.set(newAnim.id, newAnim);
			newAnim.copy(patch);
			newAnims.push(newAnim);
		}
		for (const anim of newAnims) {
			this.context.emitter.emit('animation-created', anim);
		}
	}

	public sendPayload(payload: Payloads.Payload, promise?: ExportedPromise): void {
		this.protocol.sendPayload(payload, promise);
	}

	public receiveRPC(payload: Payloads.EngineToAppRPC) {
		this.context.receiveRPC(payload);
	}

	public onClose = () => {
		this.stop();
	};

	public userJoined(suser: Partial<UserLike>) {
		if (!this.userSet.has(suser.id)) {
			const user = new User(this.context, suser.id);
			this.userSet.set(suser.id, user);
			user.copy(suser);
			this.context.emitter.emit('user-joined', user);
		}
	}

	public userLeft(userId: Guid) {
		const user = this.userSet.get(userId);
		if (user) {
			this.userSet.delete(userId);
			this.context.emitter.emit('user-left', user);
		}
	}

	public updateUser(suser: Partial<UserLike>) {
		let user = this.userSet.get(suser.id);
		if (!user) {
			user = new User(this.context, suser.id);
			user.copy(suser);
			this.userSet.set(user.id, user);
			this.context.emitter.emit('user-joined', user);
		} else {
			user.copy(suser);
			this.context.emitter.emit('user-updated', user);
		}
	}

	public performAction(actionEvent: ActionEvent) {
		if (actionEvent.user) {
			const targetActor = this.actorSet.get(actionEvent.targetId);
			if (targetActor) {
				targetActor.internal.performAction(actionEvent);
			}
		}
	}

	public collisionEventRaised(collisionEvent: CollisionEvent) {
		const actor = this.actorSet.get(collisionEvent.colliderOwnerId);
		const otherActor = this.actorSet.get((collisionEvent.collisionData.otherActorId));
		if (actor && otherActor) {
			// Update the collision data to contain the actual other actor.
			collisionEvent.collisionData = {
				...collisionEvent.collisionData,
				otherActor
			};

			actor.internal.collisionEventRaised(
				collisionEvent.eventType,
				collisionEvent.collisionData);
		}
	}

	public triggerEventRaised(triggerEvent: TriggerEvent) {
		const actor = this.actorSet.get(triggerEvent.colliderOwnerId);
		const otherActor = this.actorSet.get(triggerEvent.otherColliderOwnerId);
		if (actor && otherActor) {
			actor.internal.triggerEventRaised(
				triggerEvent.eventType,
				otherActor);
		}
	}

	public setAnimationStateEventRaised(actorId: Guid, animationName: string, state: SetAnimationStateOptions) {
		const actor = this.context.actor(actorId);
		if (actor) {
			actor.internal.setAnimationStateEventRaised(animationName, state);
		}
	}

	public localDestroyActors(actorIds: Guid[]) {
		for (const actorId of actorIds) {
			if (this.actorSet.has(actorId)) {
				this.localDestroyActor(this.actorSet.get(actorId));
			}
		}
	}

	public localDestroyActor(actor: Actor) {
		// Recursively destroy children first
		(actor.children || []).forEach(child => {
			this.localDestroyActor(child);
		});
		// Remove actor from _actors
		this.actorSet.delete(actor.id);
		// Raise event
		this.context.emitter.emit('actor-destroyed', actor);
	}

	public destroyActor(actorId: Guid) {
		const actor = this.actorSet.get(actorId);
		if (actor) {
			// Tell engine to destroy the actor (will destroy all children too)
			this.sendDestroyActors([actorId]);
			// Clean up the actor locally
			this.localDestroyActor(actor);
		}
	}

	public sendRigidBodyCommand(actorId: Guid, payload: Payloads.Payload) {
		this.protocol.sendPayload({
			type: 'rigidbody-commands',
			actorId,
			commandPayloads: [payload]
		} as Payloads.RigidBodyCommands);
	}

	public setBehavior(actorId: Guid, newBehaviorType: BehaviorType) {
		const actor = this.actorSet.get(actorId);
		if (actor) {
			this.protocol.sendPayload({
				type: 'set-behavior',
				actorId,
				behaviorType: newBehaviorType || 'none'
			} as Payloads.SetBehavior);
		}
	}

	public lookupAsset(id: Guid): Asset {
		if (id === ZeroGuid) { return null; }

		for (const c of this.assetContainers) {
			if (c.assetsById.has(id)) {
				return c.assetsById.get(id);
			}
		}
	}

	public getStats(): PerformanceStats {
		const networkStats = this.protocol.conn.statsReport;
		const stats: PerformanceStats = {
			actorCount: this.actorSet.size,
			actorWithMeshCount: 0,
			prefabCount: 0,
			materialCount: 0,
			textureCount: 0,
			texturePixelsTotal: 0,
			texturePixelsAverage: 0,
			meshCount: 0,
			meshVerticesTotal: 0,
			meshTrianglesTotal: 0,
			soundCount: 0,
			soundSecondsTotal: 0,
			...networkStats
		};

		for (const container of this.assetContainers) {
			stats.prefabCount += container.prefabs.length;
			stats.materialCount += container.materials.length;
			stats.textureCount += container.textures.length;
			stats.meshCount += container.meshes.length;
			stats.soundCount += container.sounds.length;

			for (const tex of container.textures) {
				stats.texturePixelsTotal += (tex.texture.resolution.x || 0) * (tex.texture.resolution.y || 0);
			}
			for (const mesh of container.meshes) {
				stats.meshTrianglesTotal += mesh.mesh.triangleCount || 0;
				stats.meshVerticesTotal += mesh.mesh.vertexCount || 0;
			}
			for (const sound of container.sounds) {
				stats.soundSecondsTotal += sound.sound.duration || 0;
			}
		}
		stats.texturePixelsAverage = stats.texturePixelsTotal / (stats.textureCount || 1);

		for (const actor of this.actorSet.values()) {
			if (actor.appearance.activeAndEnabled && actor.appearance.mesh) {
				stats.actorWithMeshCount += 1;
			}
		}

		return stats;
	}
}
